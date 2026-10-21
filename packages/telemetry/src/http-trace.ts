// Shared HTTP trace contract for Fleet services. Only opaque IDs and bounded
// diagnostic enums cross service boundaries; prompt and error bodies do not.
import { randomBytes, randomUUID } from "node:crypto";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_LABEL = /^[a-z][a-z0-9_-]{0,39}$/;

export interface FleetTrace {
	traceparent: string;
	traceId: string;
	requestId: string;
}

export interface HopFields {
	service: string;
	hop?: string;
	refusal?: string;
	traceId?: string;
	requestId?: string;
	attempts?: number;
	upstreamStatus?: number;
	upstreamKind?: string;
	upstreamId?: string;
	callId?: string;
}

/** One bounded, body-free attempt receipt shared by gateway layers. */
export interface HopReceipt {
	rid: string;
	traceId: string;
	ordinal: number;
	service: string;
	hop: string;
	candidate: string;
	status: number | null;
	refusal: string | null;
	durationMs: number;
	retryAfterMs: number | null;
	upstreamId: string | null;
	callId: string | null;
}

/** Shape and length guard for correlation IDs. This does not establish who
 *  authored the value or whether it is unique. */
export function safeCorrelationId(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

export const safeUpstreamId = safeCorrelationId;

export function traceIdOf(traceparent: string | null): string | undefined {
	const match = traceparent?.match(TRACEPARENT);
	const traceId = match?.[1];
	const spanId = match?.[2];
	if (!traceId || !spanId || /^0+$/.test(traceId) || /^0+$/.test(spanId))
		return;
	return traceId;
}

export function childTraceparent(parent: string): string {
	const traceId = traceIdOf(parent);
	if (!traceId) throw new Error("invalid traceparent");
	const flags = parent.slice(-2);
	return `00-${traceId}-${randomBytes(8).toString("hex")}-${flags}`;
}

/** Accept a W3C parent from the caller or root a new trace. Every hop keeps
 *  the trace ID and creates a new span on outbound requests. */
export function beginTrace(headers: Headers): FleetTrace {
	const incoming = headers.get("traceparent");
	const traceId = traceIdOf(incoming);
	const traceparent = traceId
		? (incoming ?? "")
		: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
	return {
		traceparent,
		traceId: traceId ?? traceparent.slice(3, 35),
		requestId:
			safeCorrelationId(headers.get("x-klh-request-id")) ?? randomUUID(),
	};
}

function setLabel(
	headers: Headers,
	key: string,
	value: string | undefined,
): void {
	if (value && SAFE_LABEL.test(value)) headers.set(key, value);
}

const OWNED_HEADERS = [
	"x-klh-service",
	"x-klh-hop",
	"x-klh-refusal",
	"x-klh-upstream-kind",
	"x-klh-trace-id",
	"x-klh-request-id",
	"x-klh-upstream-request-id",
	"x-klh-attempts",
	"x-klh-upstream-status",
] as const;

/** Shared emitter: these fields identify the emitting layer. Clear a
 * forwarded layer's values first so a missing field cannot be misattributed.
 * Native Retry-After and LiteLLM's own call ID remain separate. */
export function stampHopHeaders(headers: Headers, fields: HopFields): void {
	for (const name of OWNED_HEADERS) headers.delete(name);
	setLabel(headers, "x-klh-service", fields.service);
	setLabel(headers, "x-klh-hop", fields.hop);
	setLabel(headers, "x-klh-refusal", fields.refusal);
	setLabel(headers, "x-klh-upstream-kind", fields.upstreamKind);
	if (fields.traceId && /^[0-9a-f]{32}$/.test(fields.traceId))
		headers.set("x-klh-trace-id", fields.traceId);
	const requestId = safeCorrelationId(fields.requestId);
	if (requestId) headers.set("x-klh-request-id", requestId);
	const callId = safeCorrelationId(fields.callId);
	const upstreamId = safeCorrelationId(fields.upstreamId);
	if (upstreamId) headers.set("x-klh-upstream-request-id", upstreamId);
	if (callId) headers.set("x-litellm-call-id", callId);
	const attempts = fields.attempts;
	if (attempts !== undefined && Number.isSafeInteger(attempts) && attempts >= 0)
		headers.set("x-klh-attempts", String(attempts));
	const upstreamStatus = fields.upstreamStatus;
	if (
		upstreamStatus !== undefined &&
		Number.isSafeInteger(upstreamStatus) &&
		upstreamStatus >= 100 &&
		upstreamStatus <= 599
	)
		headers.set("x-klh-upstream-status", String(upstreamStatus));
}

export function stampResponse(response: Response, fields: HopFields): Response {
	const headers = new Headers(response.headers);
	// fetch may already have decoded the body. Forwarding the original length
	// or encoding would corrupt that response. Hop-by-hop metadata belongs to
	// the connection that produced the response, never the next connection.
	for (const name of [
		"content-encoding",
		"content-length",
		"connection",
		"keep-alive",
		"transfer-encoding",
		"te",
		"trailer",
		"upgrade",
	])
		headers.delete(name);
	// LiteLLM can include spend, key and upstream URL metadata. Its call ID is
	// the sole diagnostic exception; the typed fields below re-emit it safely.
	for (const name of [...headers.keys()]) {
		if (name.startsWith("llm_provider-") || name.startsWith("x-litellm-"))
			headers.delete(name);
	}
	stampHopHeaders(headers, fields);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
