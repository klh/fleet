#!/usr/bin/env bun
// escalate.ts — W422.17.3: the :4000 router's cloud-escalation leg, moved out
// of router-shim.ts so the gate ride is unit-testable. Fleet law (W422.17,
// owner 2026-10-05): every LLM egress rides the buckle gate. When the
// operator sets BELT_ESCALATE_URL + BELT_ESCALATE_KEY (a machine-config
// bksk_ key scoped buckle:proxy:WRITE_ — never the admin key), escalation
// POSTs to the buckle front in gate mode and lands in route_audit like every
// other rider. With the env unset the legacy leg stands (settings.json
// ANTHROPIC_BASE_URL/AUTH_TOKEN — the litellm engine behind the gate) so a
// not-yet-enrolled machine keeps escalation; enrollment = filling two env
// names, never a code change.
import type { AnthropicBody } from "./router-core.ts";
import { applyBudget, retryAfterMs } from "./router-core.ts";

export interface EscalateResult {
	text: string;
	model: string;
	status?: number;
	retryAfterMs?: number;
	note?: string;
}

/** The escalation leg the operator's machine config selects. */
export interface EscalationLeg {
	mode: "gate" | "legacy";
	url: string;
	key: string;
	/** gate-mode model pin (BELT_ESCALATE_MODEL); legacy keeps the wire pins. */
	modelOverride?: string;
}

type Env = Record<string, string | undefined>;

/** Legacy source of truth: the harness settings env (litellm engine). */
export type SettingsLoader = () => Promise<{
	tok?: string;
	base?: string;
}>;

export const defaultSettingsLoader: SettingsLoader = async () => {
	const home = process.env.HOME;
	if (!home) return {};
	try {
		const s = JSON.parse(
			await Bun.file(`${home}/.claude/settings.json`).text(),
		) as {
			env?: { ANTHROPIC_AUTH_TOKEN?: string; ANTHROPIC_BASE_URL?: string };
		};
		return {
			tok: s.env?.ANTHROPIC_AUTH_TOKEN,
			base: s.env?.ANTHROPIC_BASE_URL,
		};
	} catch {
		return {};
	}
};

/** Gate env beats legacy creds; neither → null (escalation disabled). */
export async function resolveEscalationLeg(
	env: Env,
	settings: SettingsLoader = defaultSettingsLoader,
): Promise<EscalationLeg | null> {
	const url = env.BELT_ESCALATE_URL?.trim();
	const key = env.BELT_ESCALATE_KEY?.trim();
	if (url && key) {
		return {
			mode: "gate",
			url: url.replace(/\/+$/, ""),
			key,
			modelOverride: env.BELT_ESCALATE_MODEL?.trim() || undefined,
		};
	}
	const s = await settings();
	if (s.tok && s.base) {
		return {
			mode: "legacy",
			url: s.base.replace(/\/+$/, ""),
			key: s.tok,
		};
	}
	return null;
}

/** The one escalation call. Contract = the old viaCloud: empty text on any
 *  failure, 429 surfaces its Retry-After, budget note rides along. */
export async function escalate(
	body: AnthropicBody,
	opts: {
		maxTokens: number;
		wantFast: boolean;
		env?: Env;
		settings?: SettingsLoader;
		fetcher?: typeof fetch;
	},
): Promise<EscalateResult> {
	const wantFastModel = opts.wantFast ? "glm-5.3-flash" : "glm-5.3";
	const leg = await resolveEscalationLeg(
		opts.env ?? process.env,
		opts.settings,
	);
	if (!leg) return { text: "", model: wantFastModel };
	const model = leg.modelOverride ?? wantFastModel;
	const budget = applyBudget(model, opts.maxTokens);
	const res = await (opts.fetcher ?? fetch)(`${leg.url}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": leg.key,
			authorization: `Bearer ${leg.key}`,
			"anthropic-version": "2023-06-01",
		},
		signal: AbortSignal.timeout(120_000),
		body: JSON.stringify({
			// litellm group names — the [1m] 1M-context ids exist in no litellm
			// model_list; lanes 400'd on unrecognized_model through this path
			model,
			max_tokens: budget.maxTokens,
			...(body.system === undefined ? {} : { system: body.system }),
			messages: body.messages,
		}),
	});
	if (res.status === 429) {
		await res.body?.cancel();
		return {
			text: "",
			model,
			status: 429,
			retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
		};
	}
	const j = (await res.json()) as { content?: Array<{ text?: string }> };
	return {
		text: (j.content ?? [])
			.map((b) => b.text ?? "")
			.join("")
			.trim(),
		model,
		status: res.status,
		note: budget.note,
	};
}
