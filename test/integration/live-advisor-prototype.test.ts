import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createDefaultChildSessionFactory, setChildSessionFactory, type ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { resolveChildWatchdogConfig, type ChildWatchdogStatusEvent } from "../../src/watchdog/child-status.ts";
import registerSubagentPromptRuntime, { stripParentOnlySubagentMessages } from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../src/watchdog/types.ts";
import { createMainWatchdogReview } from "../../src/watchdog/review.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { MainWatchdogRuntime, type WatchdogReviewRequest, type WatchdogReviewResult } from "../../src/watchdog/runtime.ts";
import { createForkContextResolver } from "../../src/shared/fork-context.ts";

const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
type PiModule = typeof import("@earendil-works/pi-coding-agent");

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => { resolve = next; });
	return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
		})]);
	} finally { clearTimeout(timer); }
}

const runtimeConfig = {
	...DEFAULT_WATCHDOG_CONFIG, enabled: true,
	main: { ...DEFAULT_WATCHDOG_CONFIG.main, enabled: true },
	cadence: { everyNTools: 1 }, scope: { enabled: false },
	lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: false }, agentEndTimeoutMs: 50,
};
const ctx = { cwd: process.cwd() };

describe("live advisor runtime regressions", () => {
	it("preserves ordinary cadence evidence when the boundary supersedes it", async () => {
		const entered = deferred<void>();
		const pending = deferred<WatchdogReviewResult>();
		const inputs: string[] = [];
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => ({ ok: true, config: runtimeConfig, errors: [], sources: [] }),
			review: (request) => {
				inputs.push(request.delta);
				if (inputs.length === 1) { entered.resolve(); return pending.promise; }
				return { stopReason: "stop" };
			},
		});
		try {
			runtime.enqueueDelta("UNIQUE_TURN_A"); runtime.handleToolResult(ctx);
			await entered.promise;
			runtime.enqueueDelta("UNIQUE_TURN_B");
			await runtime.handleAgentEnd({}, ctx);
			assert.deepEqual(inputs, ["UNIQUE_TURN_A", "UNIQUE_TURN_A\n\n---\n\nUNIQUE_TURN_B"]);
		} finally { runtime.dispose(); pending.resolve({ stopReason: "aborted" }); }
	});

	for (const action of ["dispose", "reset", "supersede"] as const) it(`ignores a non-cooperative ${action} review after its actual deadline`, async () => {
		const entered = deferred<void>();
		const pending = deferred<WatchdogReviewResult>();
		let notifications = 0;
		let steers = 0;
		let calls = 0;
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => ({ ok: true, config: runtimeConfig, errors: [], sources: [] }),
			review: () => { if (++calls > 1) return { stopReason: "stop" }; entered.resolve(); return pending.promise; },
			onReviewFailure: () => { notifications++; }, displayWarning: () => { steers++; },
		});
		runtime.enqueueDelta("pending"); runtime.handleToolResult(ctx); await entered.promise;
		if (action === "dispose") runtime.dispose();
		else if (action === "reset") runtime.reset();
		else await runtime.handleAgentEnd({}, ctx);
		// The review remains unresolved through its production deadline.
		await new Promise((resolve) => setTimeout(resolve, runtimeConfig.agentEndTimeoutMs + 20));
		assert.equal(notifications, 0); assert.equal(runtime.getSnapshot().status, "idle");
		pending.resolve({ warnings: [{ severity: "blocker", importance: "high", summary: "late", evidence: "late", recommendedAction: "late steer" }] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(steers, 0); assert.equal(runtime.getSnapshot().status, "idle"); runtime.dispose();
	});

	it("serializes persistent boundary reviews and submits each delta once", async () => {
		const entered = deferred<void>(); const pending = deferred<WatchdogReviewResult>();
		const inputs: string[] = [];
		const runtime = new MainWatchdogRuntime({
			incrementalReviewDeltas: true,
			resolveConfig: () => ({ ok: true, config: runtimeConfig, errors: [], sources: [] }),
			review: (request) => { inputs.push(request.delta); entered.resolve(); return inputs.length === 1 ? pending.promise : { stopReason: "stop" }; },
		});
		try {
			runtime.enqueueDelta("DELTA_A"); runtime.handleToolResult(ctx); await entered.promise;
			runtime.enqueueDelta("DELTA_B"); const boundary = runtime.handleAgentEnd({}, ctx);
			assert.deepEqual(inputs, ["DELTA_A"]); pending.resolve({ stopReason: "stop" });
			await boundary; assert.deepEqual(inputs, ["DELTA_A", "DELTA_B"]);
		} finally { runtime.dispose(); }
	});
});

async function nativeFixture() {
	const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	assert.match(entry, /\/dist\/index\.js$/);
	const pi: PiModule = await import(entry);
	assert.equal(pi.VERSION, "0.85.1");
	const cwd = mkdtempSync(join(tmpdir(), "live-advisor-native-"));
	const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-token", refresh: "fixture-refresh", expires: Date.now() + 86_400_000 } }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-codex": { baseUrl: "https://synthetic.invalid/v1", api: "openai-completions", models: ["gpt-5.6-luna", "gpt-6-astra"].map((id) => ({ id, name: id, api: "openai-completions", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
	const settingsManager = pi.SettingsManager.create(cwd, agentDir);
	const context = deferred<ExtensionContext>(); const apiReady = deferred<ExtensionAPI>();
	const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(api) => {
		apiReady.resolve(api); api.on("session_start", (_event, contextValue) => { context.resolve(contextValue); });
	}] });
	await resourceLoader.reload();
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
	const parent = pi.SessionManager.create(cwd, join(cwd, "sessions"));
	const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: modelRuntime.getModel("openai-codex", "gpt-5.6-luna"), sessionManager: parent });
	await session.bindExtensions({});
	return { pi, cwd, agentDir, parent, session, context: await context.promise, api: await apiReady.promise };
}

const nativeOptions = { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the installed Pi SDK", timeout: 30_000 };
const reviewConfig = { ...DEFAULT_WATCHDOG_CONFIG, main: { enabled: true, model: "openai-codex/gpt-6-astra", thinking: "xhigh" } };
function request(delta: string, reviewId: number): WatchdogReviewRequest {
	return { delta, reviewId, epoch: 1, hasScope: false, config: reviewConfig, emitWarning: () => true };
}

it("native canonical seed, persistent identity, fresh auth and ordinary stateless reviews", nativeOptions, async () => {
	const fixture = await nativeFixture();
	const { pi, parent, cwd, context } = fixture;
	const calls: Array<{ messages: Context["messages"]; options: SimpleStreamOptions | undefined }> = [];
	const streamFn: StreamFn = (model, context, options) => {
		calls.push({ messages: structuredClone(context.messages), options });
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ADVISOR_ACK" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
		return stream;
	};
	let key = "first-key";
	const auth = mock.method(context.modelRegistry, "getApiKeyAndHeaders", async () => ({ ok: true, apiKey: key, headers: { "x-credential": key }, env: { FIXTURE_CREDENTIAL: key } }));
	try {
		const ordinary = createMainWatchdogReview(context, { streamFn });
		assert.equal((await ordinary(request("ordinary-A", 1)))?.stopReason, "stop"); key = "second-key";
		assert.equal((await ordinary(request("ordinary-B", 2)))?.stopReason, "stop");
		assert.equal(JSON.stringify(calls[1]!.messages).includes("ordinary-A"), false);
		assert.equal(calls[1]!.options?.apiKey, key); calls.length = 0;
		parent.appendMessage({ role: "user", content: "RETIRED_HISTORY", timestamp: Date.now() });
		parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "old" }], api: "openai-completions", provider: "openai-codex", model: "gpt-5.6-luna", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
		const kept = parent.appendMessage({ role: "user", content: "PLANNER_MARKER", timestamp: Date.now() });
		parent.appendCompaction("COMPACTION_CONSTRAINT", kept, 10000);
		parent.appendCustomMessageEntry("constraint", "CUSTOM_CONSTRAINT", true);
		const fork = createForkContextResolver(parent, "fork", { openSession: (file, dir) => pi.SessionManager.open(file, dir) });
		await fork.prepareSessionForIndex(0); const seed = fork.sessionFileForIndex(0); assert.ok(seed);
		assert.notEqual(seed, parent.getSessionFile());
		const seedBytes = readFileSync(seed);
		const canonical = pi.SessionManager.open(seed, undefined, cwd).buildSessionContext().messages;
		assert.match(JSON.stringify(canonical), /COMPACTION_CONSTRAINT/); assert.match(JSON.stringify(canonical), /CUSTOM_CONSTRAINT/);
		assert.doesNotMatch(JSON.stringify(canonical), /RETIRED_HISTORY/);
		const cache = new Map<string, Agent>(); const review = createMainWatchdogReview(context, { streamFn, seedSessionFile: seed, agentCache: cache });
		let identity: Agent | undefined;
		for (let n = 1; n <= 3; n++) {
			key = `credential-${n}`;
			assert.equal((await review(request(`DELTA_${n}`, n)))?.stopReason, "stop");
			assert.equal(cache.size, 1); const agent = cache.values().next().value; assert.ok(agent);
			identity ??= agent; assert.equal(agent, identity);
			assert.equal(calls[n - 1]!.options?.apiKey, key);
			assert.equal(calls[n - 1]!.options?.headers?.["x-credential"], key);
			assert.equal(calls[n - 1]!.options?.env?.FIXTURE_CREDENTIAL, key);
			assert.equal(calls[n - 1]!.options?.reasoning, "xhigh");
		}
		assert.deepEqual(calls[0]!.messages.slice(0, canonical.length), canonical);
		assert.equal(calls[2]!.messages.filter((message) => JSON.stringify(message).includes("DELTA_1")).length, 1);
		assert.deepEqual(readFileSync(seed), seedBytes, "valid canonical seed remains unchanged");
		const valid = seedBytes.toString("utf8");
		const malformedSeeds = [
			["malformed-tail", `${valid}{PRIVATE_CONSTRAINT`],
			["invalid-header", "{not-json}\n"],
			["malformed-row", `${valid}{PRIVATE_CONSTRAINT}\n`],
			["truncated-custom", valid.split("\n").map((line) => line.includes("CUSTOM_CONSTRAINT") ? line.slice(0, -1) : line).join("\n")],
			["empty", ""], ["whitespace", "\n \n"], ["unterminated", valid.slice(0, -1)],
			["invalid-utf8", Buffer.concat([seedBytes, Buffer.from('{"private":"'), Buffer.from([0xff]), Buffer.from('"}\n')])],
		] as const;
		const open = mock.method(pi.SessionManager, "open");
		try {
			for (const [name, bytes] of malformedSeeds) {
				const corrupt = join(cwd, `${name}.jsonl`); writeFileSync(corrupt, bytes);
				const before = readFileSync(corrupt); const dispatches = calls.length;
				const corruptReview = createMainWatchdogReview(context, { streamFn, seedSessionFile: corrupt });
				await assert.rejects(async () => corruptReview(request("delta", 1)), { name: "Error", message: "Live advisor seed is unreadable, empty, or malformed." }, name);
				assert.equal(calls.length, dispatches, `${name}: no advisor dispatch`);
				assert.equal(open.mock.callCount(), 0, `${name}: no native open or repair`);
				assert.deepEqual(readFileSync(corrupt), before, `${name}: seed bytes unchanged`);
			}
		} finally { open.mock.restore(); }
		assert.throws(() => createMainWatchdogReview(context, { seedSessionFile: join(cwd, "missing") }), /does not exist/);
	} finally { auth.mock.restore(); fixture.session.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

interface WorkerRequest {
	model: string;
	reasoning_effort?: string;
	messages: Context["messages"];
}

function workerResponse(turn: number, job: number, final?: string): Response {
	const delta = final ? { content: final } : {
		content: `DRIFT_DELTA_${job}_${turn}`,
		tool_calls: [{ index: 0, id: `effect-${turn}`, type: "function", function: { name: "fixture_effect", arguments: "{}" } }],
	};
	const chunk = { id: "live-advisor", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: final ? "stop" : "tool_calls" }] };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

for (const scenario of ["correction", "failure", "timeout", "cancel-late-result", "cancel-late-timeout"] as const) {
	it(`public liveAdvisor native ${scenario}`, nativeOptions, async () => {
		const fixture = await nativeFixture();
		const { pi, cwd, agentDir, parent, context, api } = fixture;
		const previousEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, openAiKey: process.env.OPENAI_API_KEY };
		process.env.PI_CODING_AGENT_DIR = agentDir; process.env.OPENAI_API_KEY = "fixture-key";
		// Reuse the resolver's native opener seam without changing the planner context.
		Object.assign(parent, { openSession: (file: string, dir?: string) => pi.SessionManager.open(file, dir) });
		if (scenario !== "correction") {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ subagents: { watchdog: { agentEndTimeoutMs: 150 } } }));
		}
		const state = createChildSafeState(); state.baseCwd = cwd;
		const worker: AgentConfig = { name: "worker", description: "Controlled worker", systemPrompt: "", systemPromptMode: "replace", inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false, source: "runtime", filePath: "", tools: ["fixture_effect"], completionGuard: false };
		const executor = createSubagentExecutor({ pi: api, state, config: {}, asyncByDefault: false, tempArtifactsDir: cwd, getSubagentSessionRoot: () => join(cwd, "children"), expandTilde: (value) => value, discoverAgents: () => ({ agents: [worker, { ...worker, name: "external", runner: { type: "external-cli", command: "/not-authorized" } }] }) });
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const launches: ChildSessionLaunch[] = [];
		const jobAgents: Agent[][] = []; const jobSeeds: string[] = []; const jobWorkerFiles: string[] = [];
		const subscriptions = new Map<Agent, number>(); const aborts = new Map<Agent, number>();
		const subscribe = Agent.prototype.subscribe; const abort = Agent.prototype.abort;
		let job = 0; let reviewEnds = 0; let shutdowns = 0; let workerAborts = 0;
		let workerAbortObserved = false; let advisorAbortObserved = false; let workerPending = false;
		let workers: WorkerRequest[] = []; let advisors: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		let statuses: ChildWatchdogStatusEvent[] = []; let steers: string[] = [];
		let workerHeld = deferred<void>(); let advisorEntered = deferred<void>(); let firstReviewEnded = deferred<void>();
		let secondReviewEnded = deferred<void>(); let heldStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
		const subscribeSpy = mock.method(Agent.prototype, "subscribe", function (this: Agent, listener: Parameters<Agent["subscribe"]>[0]) {
			if (!jobAgents[job]!.includes(this)) jobAgents[job]!.push(this);
			subscriptions.set(this, (subscriptions.get(this) ?? 0) + 1);
			const unsubscribe = subscribe.call(this, async (event, signal) => {
				await listener(event, signal);
				if (event.type === "agent_end") {
					reviewEnds++;
					if (reviewEnds === 1) firstReviewEnded.resolve();
					if (reviewEnds === 2) secondReviewEnded.resolve();
				}
			});
			return () => { unsubscribe(); subscriptions.set(this, subscriptions.get(this)! - 1); };
		});
		const abortSpy = mock.method(Agent.prototype, "abort", function (this: Agent) { aborts.set(this, (aborts.get(this) ?? 0) + 1); return abort.call(this); });
		const providerMocks: Array<{ mock: { restore(): void } }> = [];
		const advisorStream: StreamFn = async (model, inferenceContext, options) => {
			assert.equal(model.provider, "openai-codex"); assert.equal(model.id, "gpt-6-astra");
			assert.equal(options?.reasoning, "xhigh", "exact effort at supported controlled stream dispatch");
			advisors.push({ context: { ...inferenceContext, messages: structuredClone(inferenceContext.messages) }, options }); advisorEntered.resolve();
			const stream = createAssistantMessageEventStream();
			const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "ADVISOR_ACK" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
			if (scenario !== "correction") {
				await workerHeld.promise;
				if (scenario === "failure") stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: "Controlled advisor transport failed (401)" } });
				else {
					heldStream = stream;
					options?.signal?.addEventListener("abort", () => {
						advisorAbortObserved = true;
						if (scenario === "timeout") stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
					}, { once: true });
				}
				return stream;
			}
			if (advisors.length === 1) {
				assert.match(JSON.stringify(inferenceContext.messages.at(-1)), new RegExp(`DRIFT_DELTA_${job}_1`), "correction reviews observed worker drift, not scope alone");
				stream.push({ type: "done", reason: "toolUse", message: { ...message, stopReason: "toolUse", content: [{ type: "toolCall", id: `warning-${job}`, name: "watchdog_warn", arguments: { severity: "blocker", importance: "high", summary: `Drift job ${job}`, evidence: "Worker drift violates the constraint", recommendedAction: `CORRECT_JOB_${job}`, category: "missed-constraint" } }] } });
			} else stream.push({ type: "done", reason: "stop", message });
			return stream;
		};
		setChildSessionFactory({
			async create(launch) {
				launches.push(launch);
				assert.equal(launch.model, "openai-codex/gpt-5.6-luna:medium");
				if (launch.storage.kind === "file") assert.deepEqual(pi.SessionManager.open(launch.storage.sessionFile, undefined, cwd).buildSessionContext().messages, [], "worker file must start without planner context");
				const config = launch.runtime.childWatchdog; assert.ok(config);
				assert.equal(config.model, "openai-codex/gpt-6-astra"); assert.equal(config.thinking, "xhigh");
				assert.deepEqual(config.cadence, { everyNTools: 1 }); assert.deepEqual(config.fallbackModels, []);
				assert.ok(config.liveAdvisorSeedSessionFile); jobSeeds.push(config.liveAdvisorSeedSessionFile);
				assert.notEqual(config.liveAdvisorSeedSessionFile, parent.getSessionFile());
				const seedManager = pi.SessionManager.open(config.liveAdvisorSeedSessionFile, undefined, cwd);
				assert.equal(seedManager.getHeader()?.parentSession, parent.getSessionFile());
				assert.match(JSON.stringify(seedManager.buildSessionContext().messages), new RegExp(`PLANNER_JOB_${job}`));
				const statusSink = launch.runtime.watchdogStatus;
				launch.runtime.watchdogStatus = (event) => { statuses.push(event); statusSink?.(event); };
				launch.hooks.unshift({ name: "live-advisor-observer", factory: (childApi) => {
					childApi.on("session_start", (_event, childCtx) => {
						const provider = childCtx.modelRegistry.getProvider("openai-codex"); assert.ok(provider);
						const originalStream = provider.streamSimple.bind(provider);
						const dispatch: StreamFn = (model, streamContext, options) => model.id === "gpt-6-astra" ? advisorStream(model, streamContext, options) : originalStream(model, streamContext, options);
						providerMocks.push(mock.method(provider, "streamSimple", dispatch));
					});
					childApi.on("session_shutdown", () => { shutdowns++; });
					childApi.registerTool({ name: "fixture_effect", label: "Fixture effect", description: "controlled drift", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "effect completed" }], details: {} }; } });
				} });
				for (const hook of launch.hooks) {
					const register = hook.factory;
					hook.factory = (childApi) => {
						const sendMessage = childApi.sendMessage.bind(childApi);
						const observeSend: ExtensionAPI["sendMessage"] = (message, options) => {
							if (options?.deliverAs === "steer") steers.push(JSON.stringify(message));
							return sendMessage(message, options);
						};
						providerMocks.push(mock.method(childApi, "sendMessage", observeSend));
						register(childApi);
					};
				}
				const child = await factory.create(launch);
				assert.equal(child.modelId, "openai-codex/gpt-5.6-luna");
				assert.equal(child.messages.length, 0, "fresh worker has no planner messages");
				const prompt = child.prompt.bind(child);
				child.prompt = async (text) => { workerPending = true; try { await prompt(text); } finally { workerPending = false; } };
				const originalAbort = child.abort.bind(child);
				child.abort = () => { workerAborts++; return originalAbort(); };
				assert.ok(child.sessionFile); jobWorkerFiles.push(child.sessionFile);
				return child;
			},
			dispose: () => factory.dispose(),
		});
		const previousFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			assert.equal(input instanceof Request ? input.url : String(input), "https://synthetic.invalid/v1/chat/completions");
			const body: WorkerRequest = JSON.parse(String(init?.body)); workers.push(body);
			assert.equal(body.model, "gpt-5.6-luna"); assert.equal(body.reasoning_effort, "medium");
			assert.doesNotMatch(JSON.stringify(body), /PLANNER_JOB_/);
			const turn = workers.length;
			if (turn <= 3) return workerResponse(turn, job);
			if (scenario !== "correction") {
				workerHeld.resolve();
				return new Promise<Response>((_resolve, reject) => {
					const abort = () => { workerAbortObserved = true; reject(new DOMException("aborted", "AbortError")); };
					if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
				});
			}
			if (turn === 4) await within(firstReviewEnded.promise, "first correction review");
			if (turn === 6) await within(secondReviewEnded.promise, "second persistent review");
			if (turn <= 6) return workerResponse(turn, job);
			return workerResponse(turn, job, JSON.stringify(body).includes(`CORRECT_JOB_${job}`) ? `CORRECTED_FINAL_${job}` : "UNSAFE_FINAL");
		};
		try {
			for (job = 0; job < (scenario === "correction" ? 2 : 1); job++) {
				jobAgents.push([]); workers = []; advisors = []; statuses = []; steers = []; reviewEnds = 0;
				workerHeld = deferred<void>(); advisorEntered = deferred<void>(); firstReviewEnded = deferred<void>(); secondReviewEnded = deferred<void>();
				parent.resetLeaf();
				parent.appendMessage({ role: "user", content: `PLANNER_JOB_${job}: preserve this constraint`, timestamp: Date.now() });
				parent.appendMessage({ role: "assistant", content: [{ type: "text", text: `Planner ${job} acknowledged.` }], api: "openai-completions", provider: "openai-codex", model: "gpt-5.6-luna", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
				const cancel = new AbortController();
				const params: SubagentParamsLike = { agent: "worker", task: `TASK_ONLY_${job}: inspect the bounded fixture`, async: false, liveAdvisor: true, output: false, acceptance: { level: "none", reason: "Controlled inference fixture" } };
				const execution = executor.execute(`native-job-${job}`, params, cancel.signal, undefined, context);
				if (scenario.startsWith("cancel")) {
					await within(Promise.all([advisorEntered.promise, workerHeld.promise]), "pending worker and advisor");
					cancel.abort();
				}
				const result = await within(execution, "production foreground settlement");
				const child = result.details?.results[0]; assert.ok(child, JSON.stringify(result));
				assert.equal(shutdowns, job + 1, `production disposal emits native shutdown before returning: ${JSON.stringify(result)}`);
				assert.equal(state.foregroundControls.size, 0);
				assert.equal(workerPending, false, "real worker prompt settled before fixture cleanup");
				assert.equal(jobAgents[job]!.length, 1, "every review in a job uses the SAME advisor Agent");
				assert.ok((aborts.get(jobAgents[job]![0]!) ?? 0) >= 1, "job shutdown aborts its advisor");
				if (scenario === "correction") {
					assert.equal(child.exitCode, 0, JSON.stringify(result)); assert.equal(child.finalOutput, `CORRECTED_FINAL_${job}`, JSON.stringify({ steers, statuses, advisors: advisors.map((call) => call.context.messages) }));
					assert.equal(child.context, "fresh"); assert.equal(child.thinking, "medium");
					assert.ok(reviewEnds >= 2); assert.ok(steers.length > 0, "actual correction-branch steer required");
					assert.ok(advisors.length >= 3); assert.match(JSON.stringify(advisors[0]!.context), new RegExp(`PLANNER_JOB_${job}`));
					const last = advisors.at(-1)!.context.messages;
					assert.equal(last.filter((message) => JSON.stringify(message).includes(`PLANNER_JOB_${job}:`)).length, 1);
					const deltas = last.filter((message) => message.role === "user" && JSON.stringify(message).includes("<turn_delta>"));
					assert.ok(deltas.length >= 2);
					for (let turn = 1; turn <= 6; turn++) assert.equal(JSON.stringify(deltas).split(`DRIFT_DELTA_${job}_${turn}`).length - 1, 1, "each worker delta retained exactly once in advisor history");
					assert.equal(subscriptions.get(jobAgents[job]![0]!), 0, "review listeners removed");
					if (job === 1) {
						assert.notEqual(jobAgents[0]![0], jobAgents[1]![0]); assert.notEqual(jobSeeds[0], jobSeeds[1]); assert.notEqual(jobWorkerFiles[0], jobWorkerFiles[1]);
						assert.doesNotMatch(JSON.stringify(advisors), /PLANNER_JOB_0|CORRECT_JOB_0|DRIFT_DELTA_0/);
					}
				} else {
					assert.notEqual(child.exitCode, 0); assert.ok(workerAborts > 0); assert.equal(workerAbortObserved, true);
					assert.equal(workers.length, 4, "pending real inference aborted without another request");
					if (scenario === "failure") assert.ok(statuses.some((event) => event.phase === "failed"));
					else assert.equal(advisorAbortObserved, true);
					if (scenario === "timeout") assert.ok(statuses.some((event) => event.phase === "stale"));
					if (scenario.startsWith("cancel")) {
						assert.match(child.error ?? "", /aborted/i);
						const settledStatuses: string = JSON.stringify(statuses);
						if (scenario === "cancel-late-timeout") await new Promise((resolve) => setTimeout(resolve, 200));
						assert.equal(JSON.stringify(statuses), settledStatuses, "no disposed timeout status resurrection");
						assert.ok(heldStream);
						heldStream.push({ type: "done", reason: "toolUse", message: { role: "assistant", content: [{ type: "toolCall", id: "late-warning", name: "watchdog_warn", arguments: { severity: "blocker", importance: "high", summary: "late", evidence: "late", recommendedAction: "LATE_STEER" } }], api: "openai-completions", provider: "openai-codex", model: "gpt-6-astra", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() } });
						await within(jobAgents[job]![0]!.waitForIdle(), "late non-cooperative advisor settlement");
						await new Promise((resolve) => setImmediate(resolve));
						assert.equal(JSON.stringify(statuses), settledStatuses); assert.equal(steers.length, 0);
						assert.equal(advisors.length, 1, "no provider dispatch after cancellation");
						assert.equal(subscriptions.get(jobAgents[job]![0]!), 0);
					}
				}
			}
			if (scenario === "correction") {
				const unsupported: SubagentParamsLike[] = [
					{ agent: "worker", task: "task", async: true },
					{ workflowScript: "return { safe: true };", async: false },
					{ action: "status" }, { agent: "external", task: "task", async: false },
					{ agent: "worker", task: "task", machine: "unavailable", async: false },
					{ tasks: [{ agent: "worker", task: "task" }], async: false },
					{ chain: [{ agent: "worker", task: "task" }], async: false },
				];
				for (const params of unsupported) {
					const result = await executor.execute("unsupported", { ...params, liveAdvisor: true }, new AbortController().signal, undefined, context);
					assert.equal(result.isError, true, JSON.stringify(params));
					if (!params.tasks && !params.chain) assert.match(JSON.stringify(result.content), /liveAdvisor/);
					assert.equal(launches.length, 2, "unsupported modes must not launch a child");
				}
				const available = context.modelRegistry.getAvailable.bind(context.modelRegistry);
				for (const missing of ["gpt-5.6-luna", "gpt-6-astra"]) {
					const availableMock = mock.method(context.modelRegistry, "getAvailable", () => available().filter((model) => model.id !== missing));
					try {
						const result = await executor.execute("missing-model", { agent: "worker", task: "task", async: false, liveAdvisor: true }, new AbortController().signal, undefined, context);
						assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), new RegExp(`requires authenticated .*${missing}`));
						assert.equal(launches.length, 2);
					} finally { availableMock.mock.restore(); }
				}
			}
		} finally {
			// Assertions above precede fixture cleanup; this abort cannot satisfy the production guard checks.
			await factory.dispose(); setChildSessionFactory(undefined);
			for (const observer of providerMocks) observer.mock.restore();
			subscribeSpy.mock.restore(); abortSpy.mock.restore(); globalThis.fetch = previousFetch;
			if (previousEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousEnv.agentDir;
			if (previousEnv.openAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousEnv.openAiKey;
			fixture.session.dispose(); rmSync(cwd, { recursive: true, force: true });
		}
	});
}

it("prompt runtime preserves only the opted-in current child's displayed advisor warning", () => {
	const warning = { role: "custom", customType: SUBAGENT_WATCHDOG_WARNING_TYPE, content: "correction", display: true, timestamp: Date.now(), details: { source: "child", state: "displayed", runId: "current-job", agent: "worker" } } satisfies AgentMessage;
	const rejected = [
		{ ...warning, details: { ...warning.details, source: "main" } },
		{ ...warning, details: { ...warning.details, runId: "old-job" } },
		{ ...warning, details: { ...warning.details, agent: "other-child" } },
		{ ...warning, details: { ...warning.details, stale: true } },
		{ ...warning, details: { ...warning.details, state: "candidate" } },
		{ ...warning, details: undefined },
	];
	assert.deepEqual(stripParentOnlySubagentMessages([warning, ...rejected]), []);
	assert.deepEqual(stripParentOnlySubagentMessages([warning, ...rejected], { liveAdvisor: { runId: "current-job", agent: "worker" } }), [warning]);
	assert.deepEqual(stripParentOnlySubagentMessages([warning], { liveAdvisor: {} }), []);
});

it("only live advisor workers receive bounded planner-correction authority", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "advisor-authority-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const seed = join(cwd, "seed.jsonl");
	writeFileSync(seed, `${JSON.stringify({ type: "session", version: 3, id: "authority", timestamp: new Date().toISOString(), cwd })}\n`);
	for (const live of [false, true]) {
		let beforeStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		// SAFETY: This registration-only probe supplies the APIs used before session events and captures the final prompt hook.
		const pi = {
			on: (name: string, handler: typeof beforeStart) => { if (name === "before_agent_start") beforeStart = handler; },
			registerTool: () => {},
			events: { on: () => () => {} },
		} as never;
		registerSubagentPromptRuntime(pi, {
			fanoutChild: false, depth: 1, waitTool: { enabled: true }, fast: false, watchdogStatus: () => {},
			childWatchdog: resolveChildWatchdogConfig({ config: DEFAULT_WATCHDOG_CONFIG, agent: "worker", runId: "job", childIndex: 0,
				forceLiveAdvisor: live, liveAdvisorSeedSessionFile: live ? seed : undefined }),
		});
		assert.ok(beforeStart);
		const result = await beforeStart({ systemPrompt: "Original worker instructions." });
		if (!live) assert.equal(result, undefined);
		else {
			assert.match(result?.systemPrompt ?? "", /current-job child watchdog corrections.*take precedence over conflicting task notes/);
			assert.match(result?.systemPrompt ?? "", /do not expand tools, filesystem permissions, or scope/);
		}
	}
});

it("live advisor opt-in forces its profile without changing ordinary disabled defaults", () => {
	assert.equal(resolveChildWatchdogConfig({ config: DEFAULT_WATCHDOG_CONFIG, agent: "worker", childIndex: 0 }), undefined);
	const live = resolveChildWatchdogConfig({ config: DEFAULT_WATCHDOG_CONFIG, agent: "worker", childIndex: 0, forceLiveAdvisor: true, liveAdvisorSeedSessionFile: "/fixture/seed" });
	assert.equal(live?.model, "openai-codex/gpt-6-astra"); assert.equal(live?.thinking, "xhigh");
	assert.deepEqual(live?.cadence, { everyNTools: 1 });
	assert.equal(resolveChildWatchdogConfig({ config: DEFAULT_WATCHDOG_CONFIG, agent: "worker", childIndex: 0 }), undefined);
});
