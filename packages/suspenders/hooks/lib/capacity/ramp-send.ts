// hooks/lib/capacity/ramp-send.ts — W1713 one synthetic request through the
// gate on a virtual lane's own scoped key: builds the wire body, rides the
// /w/<sid> lane prefix, and folds the answer into one classified RequestRow.
// Never throws — every failure mode is a row class.
import { inferenceHeaders } from "../hub/inference-buckle.ts";
import {
	buildBody,
	classifyStatus,
	extractResult,
	refusalOf,
	requestPath,
	type ToolMode,
} from "./ramp-classify.ts";
import type {
	OutcomeClass,
	RampRoute,
	RequestRow,
	Usage,
} from "./ramp-types.ts";

export interface SendCtx {
	fetch: typeof fetch;
	front: string;
	now: () => number;
	runId: string;
	toolMode: ToolMode;
	maxOut: number;
	prefixTokens: number;
	timeoutMs: number;
	/** hard abort: the drain deadline or an operator stop */
	abort: AbortSignal;
}

export interface SendLane {
	sid: string;
	key: string;
}

const ZERO: Usage = { fresh: 0, cached: 0, cacheWrite: 0, out: 0 };

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** problem+json `code` or an upstream-shaped `error.type`, when the gate set no header. */
function bodyCode(json: unknown): string | null {
	if (!isRecord(json)) return null;
	if (typeof json.code === "string") return json.code;
	return isRecord(json.error) && typeof json.error.type === "string"
		? json.error.type
		: null;
}

const failClass = (sig: AbortSignal, hard: AbortSignal): OutcomeClass => {
	if (hard.aborted) return "aborted";
	return sig.aborted ? "timeout" : "network";
};

export async function sendOne(
	c: SendCtx,
	route: RampRoute,
	step: number,
	lane: SendLane,
): Promise<RequestRow> {
	const startMs = c.now();
	const base = {
		runId: c.runId,
		route: route.name,
		model: route.model,
		wire: route.wire,
		step,
		lane: lane.sid,
		startMs,
	};
	const sig = AbortSignal.any([c.abort, AbortSignal.timeout(c.timeoutMs)]);
	const failed = (cls: OutcomeClass): RequestRow => ({
		...base,
		ms: c.now() - startMs,
		status: null,
		class: cls,
		code: null,
		refusal: null,
		retryAfterS: null,
		toolCalled: false,
		usage: ZERO,
	});
	let res: Response;
	try {
		res = await c.fetch(`${c.front}/w/${lane.sid}${requestPath(route.wire)}`, {
			method: "POST",
			headers: inferenceHeaders({
				token: lane.key,
				wire: route.wire === "messages" ? "anthropic" : "openai",
			}),
			body: JSON.stringify(buildBody(route, c)),
			signal: sig,
		});
	} catch {
		return failed(failClass(sig, c.abort));
	}
	const json: unknown = await res.json().catch(() => null);
	if (json === null && sig.aborted) return failed(failClass(sig, c.abort));
	const got = res.ok ? extractResult(route.wire, json) : null;
	const code = res.headers.get("x-belt-error") ?? bodyCode(json);
	const refusal = refusalOf(res.headers.get("x-belt-route"));
	const retry = Number(res.headers.get("retry-after"));
	return {
		...base,
		ms: c.now() - startMs,
		status: res.status,
		class: classifyStatus({
			status: res.status,
			refusal,
			code,
			toolOk: got?.toolCalled ?? false,
			requireTool: c.toolMode === "force",
		}),
		code,
		refusal,
		retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : null,
		toolCalled: got?.toolCalled ?? false,
		usage: got?.usage ?? ZERO,
	};
}
