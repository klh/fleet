// Error trace presentation at the Buckle HTTP boundary. Every non-success
// response gets a correlation header; JSON errors also carry it in the body
// because CLI clients commonly print the body but discard response headers.
import { randomBytes } from "node:crypto";
import {
	safeCorrelationId,
	safeHost,
	safeProviderErrorToken,
	traceIdOf,
} from "@klh/telemetry/src/http-trace.ts";
import { z } from "zod";
import { PROBLEM_SLUGS } from "./citizenship.ts";

const TRACE_ID = /^[0-9a-f]{32}$/;
const HUB_LABEL = /^[a-zA-Z0-9][\w.-]{0,63}$/;
const MAX_JSON_ERROR_BYTES = 64 * 1024;
const SECRET_PREFIX = /^(?:sk-|bksk_|ghp_|AKIA|Bearer)/i;
const SafeIdSchema = z
	.string()
	.max(128)
	.refine(
		(value) => Boolean(safeCorrelationId(value)) && !SECRET_PREFIX.test(value),
	);

const FleetErrorHopSchema = z.object({
	hub: z
		.string()
		.regex(HUB_LABEL)
		.refine((value) => !SECRET_PREFIX.test(value)),
	service: z.literal("buckle"),
	status: z.number().int().min(400).max(599),
	code: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
		.refine((value) => !SECRET_PREFIX.test(value))
		.optional(),
	rid: SafeIdSchema.optional(),
	target: z
		.string()
		.regex(/^[A-Za-z0-9.[\]:-]{1,270}$/)
		.refine((value) => !SECRET_PREFIX.test(value))
		.optional(),
	upstream_status: z.number().int().min(100).max(599).optional(),
	upstream_request_id: SafeIdSchema.optional(),
	call_id: SafeIdSchema.optional(),
});
const FleetErrorTraceSchema = z.object({
	id: z.string().regex(TRACE_ID),
	hops: z.array(FleetErrorHopSchema).min(1).max(4),
});

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function traceId(req: Request, resp: Response): string {
	const stamped = resp.headers.get("x-klh-trace-id");
	if (stamped && TRACE_ID.test(stamped)) return stamped;
	return (
		traceIdOf(req.headers.get("traceparent")) ?? randomBytes(16).toString("hex")
	);
}

function currentHop(resp: Response, hub: string, code: string | null) {
	const rid = safeCorrelationId(resp.headers.get("x-belt-rid"));
	const upstreamRequestId = safeCorrelationId(
		resp.headers.get("x-klh-upstream-request-id"),
	);
	const callId = safeCorrelationId(resp.headers.get("x-litellm-call-id"));
	const status = Number(resp.headers.get("x-klh-upstream-status"));
	let target: string | undefined;
	try {
		const route = object(JSON.parse(resp.headers.get("x-belt-route") ?? ""));
		const row = object(route?.target);
		const host = safeHost(row?.host);
		const port = row?.port;
		if (
			host &&
			typeof port === "number" &&
			Number.isInteger(port) &&
			port > 0 &&
			port <= 65535
		)
			target = `${host}:${port}`;
	} catch {
		// A missing route header is expected for auth and admin errors.
	}
	return {
		hub,
		service: "buckle" as const,
		status: resp.status,
		...(code ? { code } : {}),
		...(rid ? { rid } : {}),
		...(target ? { target } : {}),
		...(Number.isInteger(status) && status >= 100 && status <= 599
			? { upstream_status: status }
			: {}),
		...(upstreamRequestId ? { upstream_request_id: upstreamRequestId } : {}),
		...(callId ? { call_id: callId } : {}),
	};
}

/** A peer's trace is admitted only when both its stamped header and its
 * bounded body agree with the trace ID sent on this request. Providers never
 * get to author the fleet hop chain. */
export function peerErrorTrace(
	resp: Response,
	wire: unknown,
	expectedId: string,
): string | null {
	if (
		resp.headers.get("x-klh-service") !== "buckle" ||
		resp.headers.get("x-klh-trace-id") !== expectedId
	)
		return null;
	const parsed = FleetErrorTraceSchema.safeParse(object(wire)?.fleet_trace);
	if (!parsed.success || parsed.data.id !== expectedId) return null;
	return JSON.stringify(parsed.data);
}

async function smallJson(resp: Response): Promise<JsonObject | null> {
	if (!resp.headers.get("content-type")?.includes("json")) return null;
	const reader = resp.clone().body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_JSON_ERROR_BYTES) return null;
			chunks.push(value);
		}
		return object(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))));
	} catch {
		return null;
	} finally {
		void reader.cancel().catch(() => {});
	}
}

function fallbackBody(
	req: Request,
	resp: Response,
): {
	body: JsonObject;
	contentType: string;
} {
	const path = new URL(req.url).pathname;
	const message = `gateway returned HTTP ${resp.status} without a JSON error body`;
	if (path.endsWith("/v1/messages"))
		return {
			body: { type: "error", error: { type: "api_error", message } },
			contentType: "application/json",
		};
	if (path.endsWith("/v1/chat/completions") || path.endsWith("/v1/responses"))
		return {
			body: { error: { type: "api_error", message } },
			contentType: "application/json",
		};
	return {
		body: {
			type: `/problems/${PROBLEM_SLUGS[resp.status] ?? "problem"}`,
			title: "Gateway Error",
			status: resp.status,
			code: "buckle.unstructured_error",
			detail: message,
			why: message,
		},
		contentType: "application/problem+json",
	};
}

/** Add a bounded, provider-neutral trace to every error emitted by this
 * listener. It preserves the existing Anthropic/OpenAI/RFC error envelope. */
export async function traceErrorResponse(
	req: Request,
	resp: Response,
	hubLabel: string,
): Promise<Response> {
	if (resp.status < 400) return resp;
	const id = traceId(req, resp);
	const hub = HUB_LABEL.test(hubLabel) ? hubLabel : "local";
	const headers = new Headers(resp.headers);
	headers.set("x-klh-trace-id", id);
	headers.set("x-klh-error-origin", hub);
	const parsed = await smallJson(resp);
	const fallback = parsed ? null : fallbackBody(req, resp);
	const body = parsed ?? fallback?.body;
	if (!body) throw new Error("error trace body unavailable");
	if (fallback) {
		headers.set("content-type", fallback.contentType);
	}
	// smallJson reads a clone; the original tee branch must be closed even when
	// parsing succeeds or it retains the whole error body under backpressure.
	void resp.body?.cancel().catch(() => {});
	const code = safeProviderErrorToken(
		body.code ?? object(body.error)?.code ?? null,
	);
	const peerHeader = resp.headers.get("x-klh-peer-error-trace");
	let prior: z.infer<typeof FleetErrorTraceSchema> | null = null;
	try {
		if (peerHeader && peerHeader.length > 4096)
			throw new Error("oversized peer trace");
		const parsed = FleetErrorTraceSchema.safeParse(
			JSON.parse(peerHeader ?? ""),
		);
		if (parsed.success && parsed.data.id === id) prior = parsed.data;
	} catch {
		// No downstream peer on locally generated errors.
	}
	const hops = prior?.hops.slice(-3) ?? [];
	const trace = {
		id,
		hops: [...hops, currentHop(resp, hub, code)],
	};
	body.fleet_trace = trace;
	body.trace_id = id;
	const origin = trace.hops[0]?.hub ?? hub;
	const path = [...trace.hops]
		.reverse()
		.map((hop) =>
			[
				hop.hub,
				`${hop.status}${hop.code ? `/${hop.code}` : ""}`,
				hop.target ? `to=${hop.target}` : "",
				hop.upstream_status ? `up=${hop.upstream_status}` : "",
				hop.call_id ? `call=${hop.call_id}` : "",
			]
				.filter(Boolean)
				.join(":"),
		)
		.join(" > ");
	const marker = `[trace=${id}; origin=${origin}; hops=${path}]`;
	if (typeof body.detail === "string") {
		const detail = body.detail.replace(
			/ \[trace=[0-9a-f]{32};[^\]]{0,600}\]$/,
			"",
		);
		const separator = detail.indexOf(" — ");
		body.detail =
			separator >= 0
				? `${detail.slice(0, separator)} ${marker} — ${detail.slice(separator + 3, separator + 2051)}`
				: `${marker} — ${detail.slice(0, 2048)}`;
		if (typeof body.why === "string") body.why = body.detail;
	} else {
		const error = object(body.error);
		if (error) {
			error.trace_id = id;
			if (typeof error.message === "string")
				error.message = `${marker} — ${error.message.slice(0, 2048)}`;
		}
	}
	headers.delete("x-klh-peer-error-trace");
	headers.set("x-klh-error-origin", origin);
	headers.delete("content-length");
	headers.delete("content-encoding");
	return new Response(JSON.stringify(body), {
		status: resp.status,
		statusText: resp.statusText,
		headers,
	});
}
