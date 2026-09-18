import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, splitKnownThinkingSuffix, type ThinkingLevel } from "../../shared/model-info.ts";

export type LiveAdvisorModel = Readonly<{ model: string; thinking: ThinkingLevel }>;
export type LiveAdvisorModels = Readonly<{ worker: LiveAdvisorModel; advisor: LiveAdvisorModel }>;

export const DEFAULT_LIVE_ADVISOR_MODELS: LiveAdvisorModels = Object.freeze({
	worker: Object.freeze({ model: "openai-codex/gpt-5.6-luna", thinking: "medium" }),
	advisor: Object.freeze({ model: "openai-codex/gpt-6-astra", thinking: "xhigh" }),
});

function fields(value: unknown, keys: string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
		throw new Error(`liveAdvisor ${label} must contain exactly ${keys.join(", ")}.`);
	}
	return value as Record<string, unknown>;
}

export function resolveLiveAdvisorModels(value: unknown, available: readonly Model<Api>[]): LiveAdvisorModels {
	const config = fields(value, ["worker", "advisor"], "models");
	const role = (name: "worker" | "advisor"): LiveAdvisorModel => {
		const entry = fields(config[name], ["model", "thinking"], name);
		if (typeof entry.model !== "string" || !/^[^\s/]+\/\S+$/.test(entry.model)
			|| splitKnownThinkingSuffix(entry.model).thinkingSuffix) {
			throw new Error(`liveAdvisor ${name}.model must be an exact provider/model ID without a thinking suffix.`);
		}
		const thinking = THINKING_LEVELS.find((level) => level === entry.thinking);
		if (!thinking) throw new Error(`liveAdvisor ${name}.thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
		const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === entry.model);
		if (!model) throw new Error(`liveAdvisor requires authenticated ${name} model '${entry.model}'.`);
		if (!getSupportedThinkingLevels(model).includes(thinking)) {
			throw new Error(`liveAdvisor ${name} model '${entry.model}' does not support thinking '${thinking}'.`);
		}
		return Object.freeze({ model: entry.model, thinking });
	};
	return Object.freeze({ worker: role("worker"), advisor: role("advisor") });
}
