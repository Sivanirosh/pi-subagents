import assert from "node:assert/strict";
import { it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_LIVE_ADVISOR_MODELS, resolveLiveAdvisorModels } from "../../src/runs/shared/live-advisor-models.ts";
import { resolveChildWatchdogConfig } from "../../src/watchdog/child-status.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";

const available: Model<Api>[] = ["worker", "advisor"].map((id) => ({
	provider: "fixture", id, name: id, api: "openai-completions", baseUrl: "https://synthetic.invalid",
	reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], contextWindow: 128000, maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));
const configured = { worker: { model: "fixture/worker", thinking: "low" }, advisor: { model: "fixture/advisor", thinking: "high" } };

it("validates exact model/effort selections and snapshots both roles", () => {
	const input = structuredClone(configured);
	const resolved = resolveLiveAdvisorModels(input, available);
	input.worker.model = "fixture/changed";
	assert.deepEqual(resolved, configured);
	assert.ok(Object.isFrozen(resolved) && Object.isFrozen(resolved.worker) && Object.isFrozen(resolved.advisor));
	const watchdog = resolveChildWatchdogConfig({ config: DEFAULT_WATCHDOG_CONFIG, forceLiveAdvisor: true, liveAdvisorModel: resolved.advisor });
	assert.equal(watchdog?.model, configured.advisor.model);
	assert.equal(watchdog?.thinking, "high");
	assert.deepEqual(watchdog?.fallbackModels, []);
	assert.deepEqual(watchdog?.cadence, { everyNTools: 1 });
	assert.equal(resolveChildWatchdogConfig({ config: DEFAULT_WATCHDOG_CONFIG }), undefined);
	assert.equal(DEFAULT_LIVE_ADVISOR_MODELS.worker.thinking, "medium");
});

it("rejects malformed, unavailable and unsupported selections rather than substituting", () => {
	for (const input of [null, [], {}, { ...configured, extra: true }, { worker: configured.worker },
		{ ...configured, advisor: null }, { ...configured, worker: { ...configured.worker, extra: true } },
		...['worker', 'fixture/worker:high', ' fixture/worker', 'fixture/missing', ''].map((model) => ({ ...configured, worker: { ...configured.worker, model } })),
		...[null, false, 'invalid'].map((thinking) => ({ ...configured, advisor: { ...configured.advisor, thinking } })),
	]) assert.throws(() => resolveLiveAdvisorModels(input, available), /liveAdvisor/);
	for (const role of ["worker", "advisor"] as const) {
		const models = available.map((model) => model.id === role ? { ...model, reasoning: false } : model);
		assert.throws(() => resolveLiveAdvisorModels(configured, models), /does not support thinking/);
		const holes = available.map((model) => model.id === role ? { ...model, thinkingLevelMap: { low: null, high: null } } : model);
		assert.throws(() => resolveLiveAdvisorModels(configured, holes), /does not support thinking/);
		const off = { ...configured, [role]: { ...configured[role], thinking: "off" } };
		assert.equal(resolveLiveAdvisorModels(off, models)[role].thinking, "off");
	}
});
