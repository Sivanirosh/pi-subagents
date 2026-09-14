import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Type } from "typebox";
import { registerChildWatchdog } from "../../src/watchdog/register-child.ts";
import type { ChildWatchdogConfig, ChildWatchdogStatusEvent } from "../../src/watchdog/child-status.ts";

const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
const fixtureUrl = "https://synthetic.invalid/v1/chat/completions";
const watchdogConfig: ChildWatchdogConfig = {
	agent: "native-connectivity-fixture",
	childIndex: 0,
	watchdogTailTimeoutMs: 1_000,
	agentEndTimeoutMs: 1_000,
	maxWarnings: null,
	blockOnFailure: true,
	lsp: { enabled: false, timeoutMs: 1_000, maxFiles: 1, maxDiagnostics: 1 },
	stalemateRepeats: 3,
	cadence: { everyNTools: null },
};

type PiModule = typeof import("@earendil-works/pi-coding-agent");
type Scenario = "admitted" | "failed" | "stale" | "shutdown";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => { resolve = next; });
	return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function providerResponse(toolName?: string, text = "Fixture complete."): Response {
	const delta = toolName
		? { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: toolName, arguments: "{}" } }] }
		: { content: text };
	const chunk = {
		id: "native-connectivity-fixture",
		object: "chat.completion.chunk",
		created: 1,
		model: "native-connectivity-fixture",
		choices: [{ index: 0, delta, finish_reason: toolName ? "tool_calls" : "stop" }],
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

async function createScenario(pi: PiModule, scenario: Scenario, sdkVersion: string): Promise<{
	session: any;
	runtimes: Array<{ dispose(): void }>;
	cwd: string;
	statusEvents: ChildWatchdogStatusEvent[];
	nativeEvents: string[];
	eventTimeline: string[];
	executeCount: () => number;
	returnedCount: () => number;
	started: Promise<void>;
	release: () => void;
}> {
	const cwd = mkdtempSync(join(tmpdir(), "watchdog-native-connectivity-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "https://synthetic.invalid/v1", apiKey: "fixture-key", models: [{ id: "native-connectivity-fixture", name: "native-connectivity-fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	const statusEvents: ChildWatchdogStatusEvent[] = [];
	const nativeEvents: string[] = [];
	const eventTimeline: string[] = [];
	const started = deferred<void>();
	const release = deferred<void>();
	let executeCalls = 0;
	let returnedCalls = 0;
	const runtimes: Array<{ dispose(): void }> = [];
	let session: any;
	// SAFETY: The native fixture receives the actual SDK ExtensionAPI; this test intentionally treats its dynamic boundary as a fixture-only contract.
	const extensionFactory = (api: any): void => {
		// Observe the native tool_call before the source gate; a blocking handler
		// prevents later tool_call observers from running in the SDK runner.
		api.on("tool_call", (event: { toolName: string }) => nativeEvents.push(`tool_call:${event.toolName}`));
		api.on("tool_result", (event: { toolName: string }) => {
			nativeEvents.push(`tool_result:${event.toolName}`);
			eventTimeline.push(`tool_result:${event.toolName}`);
		});
		const runtime = registerChildWatchdog(api, watchdogConfig, (event) => {
			statusEvents.push(event);
			eventTimeline.push(`status:${event.phase}:${event.effectSettlement?.status ?? "none"}`);
		});
		if (runtime) runtimes.push(runtime);
		api.on("session_start", () => nativeEvents.push("session_start"));
		api.on("tool_execution_start", (event: { toolName: string }) => {
			nativeEvents.push(`tool_execution_start:${event.toolName}`);
			if ((scenario === "failed" || scenario === "stale") && event.toolName === "fixture_effect") {
				// Controlled state stimulus: force the source runtime state immediately
				// after native admission preflight's start event, before tool_call.
				// SAFETY: This fixture intentionally injects the known watchdog status seam to exercise admission denial.
				(runtime as any).status = scenario;
			}
		});
		api.on("tool_execution_end", (event: { toolName: string }) => nativeEvents.push(`tool_execution_end:${event.toolName}`));
		api.on("session_shutdown", () => nativeEvents.push("session_shutdown"));
		api.registerTool({
			name: "fixture_effect",
			label: "Fixture effect",
			description: "Perform one isolated benign fixture effect.",
			parameters: Type.Object({}),
			async execute() {
				executeCalls++;
				started.resolve();
				if (scenario === "admitted" || scenario === "shutdown") await release.promise;
				returnedCalls++;
				return { content: [{ type: "text", text: "Fixture effect executed." }], details: {} };
			},
		});
	};
	try {
		const settingsManager = pi.SettingsManager.create(cwd, agentDir);
		const resourceLoader = new pi.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [extensionFactory],
		});
		await resourceLoader.reload();
		const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: modelRuntime.getModel("fixture", "native-connectivity-fixture"), sessionManager: pi.SessionManager.inMemory(cwd), noTools: "builtin" }));
		assert.equal(pi.__piSubagentsTestShim, undefined, `native scenario ${scenario} must not use the test shim`);
		assert.equal(pi.VERSION, sdkVersion);
		await session.bindExtensions({});
		return { session, runtimes, cwd, statusEvents, nativeEvents, eventTimeline, executeCount: () => executeCalls, returnedCount: () => returnedCalls, started: started.promise, release: () => { started.resolve(); release.resolve(); }, };
	} catch (error) {
		started.resolve();
		release.resolve();
		for (const runtime of runtimes) runtime.dispose();
		session?.dispose();
		rmSync(cwd, { recursive: true, force: true });
		throw error;
	}
}

it("native Pi dispatches one child watchdog effect through real SDK lifecycle events", {
	skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to an installed real Pi SDK root",
	timeout: 30_000,
}, async () => {
	const entry = (await import("node:child_process")).execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	assert.match(entry, /\/dist\/index\.js$/);
	// SAFETY: The preceding assertion verifies that the resolved module is the SDK dist entrypoint used by this fixture.
	const pi = await import(entry) as PiModule;
	const sdkVersion = String(pi.VERSION);
	const previousFetch = globalThis.fetch;
	const responses: Array<() => Response> = [];
	globalThis.fetch = async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		assert.equal(url, fixtureUrl, "native fixture must not make unexpected network calls");
		const next = responses.shift();
		assert.ok(next, "scripted inference response was exhausted");
		return next!();
	};
	const sessions: Array<Awaited<ReturnType<typeof createScenario>>> = [];
	const prompts: Promise<unknown>[] = [];
	try {
		const admitted = await createScenario(pi, "admitted", sdkVersion);
		sessions.push(admitted);
		responses.push(() => providerResponse("fixture_effect"), () => providerResponse());
		const admittedPrompt = admitted.session.prompt("Run one benign fixture effect.");
		prompts.push(admittedPrompt);
		await within(admitted.started, "admitted fixture effect start");
		assert.equal(admitted.returnedCount(), 0, "admitted fixture remains held before watchdog-state injection");
		assert.equal(admitted.statusEvents.some((event) => event.effectSettlement?.status === "settled"), false, "admitted fixture has not settled before watchdog-state injection");
		// SAFETY: The native fixture exposes the registered runtime so this test can inject a failed gate after admission.
		(admitted.runtimes[0] as any).status = "failed";
		assert.equal(admitted.returnedCount(), 0, "admitted fixture remains held across watchdog-state injection");
		assert.equal(admitted.statusEvents.some((event) => event.effectSettlement?.status === "settled"), false, "admitted fixture remains unsettled across watchdog-state injection");
		admitted.release();
		await within(admittedPrompt, "admitted prompt");
		assert.equal(admitted.executeCount(), 1, "admitted effect executes exactly once");
		assert.ok(admitted.nativeEvents.indexOf("tool_call:fixture_effect") < admitted.nativeEvents.indexOf("tool_result:fixture_effect"));
		assert.ok(admitted.statusEvents.some((event) => event.effectSettlement?.status === "settled"), "returned effect is settled by native tool_result order");
		assert.ok(admitted.eventTimeline.indexOf("tool_result:fixture_effect") < admitted.eventTimeline.findIndex((event) => event === "status:failed:settled"), "settlement follows the native tool_result event");
		assert.ok(admitted.statusEvents.some((event) => event.effectSettlement?.status === "settled" && event.phase === "failed"), "settled observation preserves later failed gate state");

		for (const state of ["failed", "stale"] as const) {
			const denied = await createScenario(pi, state, sdkVersion);
			sessions.push(denied);
			responses.push(() => providerResponse("fixture_effect"), () => providerResponse());
			const deniedPrompt = denied.session.prompt(`Attempt one effect while child watchdog is ${state}.`);
			prompts.push(deniedPrompt);
			await within(deniedPrompt, `${state} denial prompt`);
			assert.equal(denied.executeCount(), 0, `${state} admission denial does not invoke execute`);
			assert.ok(denied.nativeEvents.includes("tool_execution_start:fixture_effect"));
			assert.ok(denied.nativeEvents.includes("tool_call:fixture_effect"));
			assert.ok(denied.statusEvents.length > 0);
		}

		const shutdown = await createScenario(pi, "shutdown", sdkVersion);
		sessions.push(shutdown);
		responses.push(() => providerResponse("fixture_effect"), () => providerResponse());
		const shutdownPrompt = shutdown.session.prompt("Start one effect and wait for supported session shutdown.");
		prompts.push(shutdownPrompt);
		await within(shutdown.started, "shutdown fixture effect start");
		await within(shutdown.session.reload(), "native session reload shutdown");
		assert.ok(shutdown.nativeEvents.includes("session_shutdown"), "SDK session reload dispatches session_shutdown");
		assert.ok(shutdown.statusEvents.some((event) => event.effectSettlement?.status === "unresolved" && event.effectSettlement.reason === "cancelled-before-tool-return"), "shutdown reports unresolved started effect");
		shutdown.release();
		await within(shutdownPrompt, "shutdown prompt completion");
		assert.equal(responses.length, 0, "scripted inference has no unbounded or unconsumed model loop");
		console.log(`Actual Pi ${sdkVersion}: admitted/denied/settled/shutdown native child-watchdog evidence collected.`);
	} finally {
		for (const scenario of sessions) scenario.release();
		for (const scenario of sessions) scenario.session?.dispose();
		try {
			await within(Promise.allSettled(prompts), "native prompt cleanup");
		} finally {
			globalThis.fetch = previousFetch;
			for (const scenario of sessions) {
				for (const runtime of scenario.runtimes) runtime.dispose();
				rmSync(scenario.cwd, { recursive: true, force: true });
			}
		}
	}
});
