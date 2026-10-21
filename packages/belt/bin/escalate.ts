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
import {
	loadGatewayPolicy,
	resolveReasoningEffort,
	type ReasoningEffort,
} from "./router-policy.ts";
import {
	childTraceparent,
	safeUpstreamId,
} from "../../telemetry/src/http-trace.ts";

/** Z.AI GLM-5.3 doc-verified efforts: low|high|max — the model ALWAYS
 *  thinks (disable → 400; medium is not in the 5.3 set). The fleet axis
 *  clamps to the two verified values; leaving the pin OFF is what burned
 *  whole max_tokens budgets on reasoning_content (oracle glm-5.3 review,
 *  3 attempts, empty visible content). */
const ZAI_EFFORT: Record<ReasoningEffort, "low" | "high"> = {
	low: "low",
	medium: "low",
	high: "high",
	xhigh: "high",
};

/** thinking budget per pinned effort — litellm's anthropic adapter buckets
 *  ≥4096→high and ≥1024→low, so the legacy litellm-direct hop reproduces
 *  the same effort from the thinking field alone. */
const THINKING_BUDGET: Record<"low" | "high", number> = {
	low: 1024,
	high: 4096,
};

export interface EscalateResult {
	text: string;
	model: string;
	status?: number;
	retryAfterMs?: number;
	note?: string;
	error?: string;
	/** Echoed by LiteLLM or stamped by a Buckle gate hop. */
	upstreamCallId?: string;
	upstreamRid?: string;
	attemptId?: string;
}

function upstreamError(raw: string, status: number): string {
	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string | number; message?: string } | string;
		};
		const error = parsed.error;
		if (typeof error === "string") return error.slice(0, 512);
		if (error && typeof error === "object") {
			const detail = [error.code, error.message].filter(Boolean).join(": ");
			if (detail) return detail.slice(0, 512);
		}
	} catch {
		// Preserve a bounded plain-text error when the upstream did not send JSON.
	}
	return raw.trim().slice(0, 512) || `HTTP ${status}`;
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
		policyPath?: string;
		traceparent?: string;
		requestId?: string;
		onAttempt?: (receipt: {
			hop: "buckle-gate" | "litellm";
			traceparent: string | null;
			requestId: string | null;
			attemptId: string;
			status?: number;
			durationMs: number;
			retryAfterMs?: number;
			upstreamCallId?: string;
			upstreamRid?: string;
			failureKind?: "http" | "transport" | "decode" | "empty";
		}) => void;
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
	const effort = resolveReasoningEffort(
		loadGatewayPolicy(opts.policyPath),
		opts.wantFast ? "escalate-fast" : "escalate",
	);
	const pinned = ZAI_EFFORT[effort];
	const attemptStarted = performance.now();
	const attemptTrace = opts.traceparent
		? childTraceparent(opts.traceparent)
		: null;
	const attemptId = `belt_${attemptTrace?.split("-")[1] ?? crypto.randomUUID().replaceAll("-", "")}_${attemptTrace?.split("-")[2] ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
	let status: number | undefined;
	let retryAfter: number | undefined;
	let upstreamCallId: string | undefined;
	let upstreamRid: string | undefined;
	let failureKind: "http" | "transport" | "decode" | "empty" | undefined;
	try {
		const res = await (opts.fetcher ?? fetch)(`${leg.url}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": leg.key,
				authorization: `Bearer ${leg.key}`,
				"anthropic-version": "2023-06-01",
				"x-litellm-call-id": attemptId,
				...(opts.requestId ? { "x-klh-request-id": opts.requestId } : {}),
				...(attemptTrace ? { traceparent: attemptTrace } : {}),
			},
			signal: AbortSignal.timeout(120_000),
			body: JSON.stringify({
				// litellm group names — the [1m] 1M-context ids exist in no litellm
				// model_list; lanes 400'd on unrecognized_model through this path
				model,
				max_tokens: budget.maxTokens,
				// W770 reasoning pin on both carriers: thinking rides the anthropic
				// wire (legacy litellm-direct hop buckets it to the same effort);
				// reasoning_effort rides top-level (gate hop — buckle forwards
				// verbatim). Both drop harmlessly until the operator's litellm.yaml
				// zai rows carry allowed_openai_params: [reasoning_effort].
				thinking: { type: "enabled", budget_tokens: THINKING_BUDGET[pinned] },
				reasoning_effort: pinned,
				...(body.system === undefined ? {} : { system: body.system }),
				messages: body.messages,
			}),
		});
		status = res.status;
		upstreamCallId = safeUpstreamId(res.headers?.get("x-litellm-call-id"));
		upstreamRid = safeUpstreamId(res.headers?.get("x-belt-rid"));
		if (!res.ok) {
			failureKind = "http";
			const error = upstreamError(await res.text(), res.status);
			retryAfter =
				res.status === 429
					? retryAfterMs(res.headers.get("retry-after"))
					: undefined;
			return {
				text: "",
				model,
				status: res.status,
				retryAfterMs: retryAfter,
				error,
				attemptId,
				...(upstreamCallId ? { upstreamCallId } : {}),
				...(upstreamRid ? { upstreamRid } : {}),
			};
		}
		const j = (await res.json()) as { content?: Array<{ text?: string }> };
		const text = (j.content ?? [])
			.map((b) => b.text ?? "")
			.join("")
			.trim();
		if (!text) failureKind = "empty";
		return {
			text,
			model,
			status: res.status,
			note: budget.note,
			attemptId,
			...(upstreamCallId ? { upstreamCallId } : {}),
			...(upstreamRid ? { upstreamRid } : {}),
		};
	} catch (error) {
		failureKind ??= status === undefined ? "transport" : "decode";
		throw error;
	} finally {
		opts.onAttempt?.({
			hop: leg.mode === "gate" ? "buckle-gate" : "litellm",
			traceparent: attemptTrace,
			requestId: opts.requestId ?? null,
			attemptId,
			status,
			durationMs: Math.round(performance.now() - attemptStarted),
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
			...(upstreamCallId ? { upstreamCallId } : {}),
			...(upstreamRid ? { upstreamRid } : {}),
			...(failureKind ? { failureKind } : {}),
		});
	}
}
