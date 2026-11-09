import { parseRetryAfterHeader } from "@klh/buckle/src/resilience.ts";
import { traceIdOf } from "@klh/telemetry/src/http-trace.ts";
import { z } from "zod";
import { redactSecrets } from "../knowledge/knowledge.ts";
import { redactMatches, scrubRules } from "./scrub.ts";

const ErrorFieldsSchema = z
	.object({
		code: z.string().optional(),
		type: z.string().optional(),
		message: z.string().optional(),
	})
	.strip();
const ReviewProblemSchema = z
	.object({
		code: z.string().optional(),
		type: z.string().optional(),
		detail: z.string().optional(),
		message: z.string().optional(),
		trace_id: z.string().optional(),
		error: z.union([ErrorFieldsSchema, z.string()]).optional(),
		fleet_trace: z.object({ id: z.string() }).strip().optional(),
	})
	.strip();

async function boundedBody(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const decoder = new TextDecoder();
	let raw = "",
		bytes = 0,
		expired = false;
	const timer = setTimeout(() => {
		expired = true;
		void reader.cancel().catch(() => {});
		// Diagnostic reads must stay below the review walk's fast-failure threshold.
	}, 250);
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (expired) return null;
			if (done) return JSON.parse(raw + decoder.decode());
			bytes += value.byteLength;
			if (bytes > 16_384) return null;
			raw += decoder.decode(value, { stream: true });
		}
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		void reader.cancel().catch(() => {});
	}
}

/** No provider prose is emitted: it may echo the prompt or arbitrary secrets. */
export async function reviewHttpFailure(
	response: Response,
	secret?: string,
): Promise<Error> {
	const body = await boundedBody(response);
	const parsed = ReviewProblemSchema.safeParse(body);
	const p = parsed.success ? parsed.data : null;
	const nested = typeof p?.error === "object" ? p.error : null;
	const fields = [`Review LLM HTTP ${response.status}`];
	const code = p?.code ?? nested?.code ?? nested?.type ?? p?.type;
	if (
		code &&
		/^[a-zA-Z0-9_.:/-]{1,100}$/.test(code) &&
		(!secret || !code.includes(secret)) &&
		redactSecrets(redactMatches(code, scrubRules())).text === code
	)
		fields.push(`code=${code}`);
	const trace =
		traceIdOf(response.headers.get("traceparent")) ??
		p?.trace_id ??
		p?.fleet_trace?.id;
	if (trace && /^[0-9a-f]{32}$/.test(trace) && !/^0+$/.test(trace))
		fields.push(`trace=${trace}`);
	const retry = parseRetryAfterHeader(response.headers.get("retry-after"));
	if (retry !== undefined && Number.isSafeInteger(retry))
		fields.push(`retry_after_ms=${retry}`);
	const detail = [
		code,
		p?.detail,
		p?.message,
		typeof p?.error === "string" ? p.error : nested?.message,
	].join(" ");
	if (
		/context.{0,30}(length|window|limit)|context_length_exceeded/i.test(detail)
	)
		fields.push("category=context_limit");
	return new Error(fields.join(" "));
}
