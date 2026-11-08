import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { requestReviewLeg } from "../hooks/lib/gates/review-prompt.ts";

test("review diagnostics bound error bodies and discard unsafe prose @unit", async () => {
	const { reviewHttpFailure } = await import(
		"../hooks/lib/gates/review-http-error.ts"
	);
	for (const body of [
		"<html>private body</html>",
		JSON.stringify({ detail: "private body" }),
		JSON.stringify({
			detail: "x".repeat(20_000),
			code: "oversized_should_not_parse",
		}),
	]) {
		const error = await reviewHttpFailure(new Response(body, { status: 502 }));
		expect(error.message).toBe("Review LLM HTTP 502");
	}
	const trace = "1234567890abcdef1234567890abcdef";
	const nested = await reviewHttpFailure(
		Response.json(
			{ error: { code: "invalid_model", message: "private body" } },
			{
				status: 400,
				headers: { traceparent: `00-${trace}-1234567890abcdef-01` },
			},
		),
	);
	expect(nested.message).toContain("code=invalid_model");
	expect(nested.message).toContain(`trace=${trace}`);
	const redacted = await reviewHttpFailure(
		Response.json({ code: "fixture-private-value" }, { status: 401 }),
		"fixture-private-value",
	);
	expect(redacted.message).toBe("Review LLM HTTP 401");
});

test("review diagnostic body deadline cancels an unfinished stream @unit", async () => {
	const { reviewHttpFailure } = await import(
		"../hooks/lib/gates/review-http-error.ts"
	);
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const error = await reviewHttpFailure(new Response(stream, { status: 503 }));
	expect(error.message).toBe("Review LLM HTTP 503");
	expect(cancelled).toBe(true);
});

test("review HTTP errors retain safe provenance instead of only status @unit", async () => {
	const trace = "1234567890abcdef1234567890abcdef";
	const secret = "fixture-private-value";
	const stub = serveStub(() =>
		Response.json(
			{
				code: "context_length_exceeded",
				trace_id: trace,
				detail: `Maximum context length exceeded; authorization=${secret}; fixture prompt`,
			},
			{ status: 400, headers: { "retry-after": "2" } },
		),
	);
	try {
		let message = "";
		try {
			await requestReviewLeg({
				url: stub.url,
				model: "fixture",
				key: secret,
				prompt: "fixture prompt",
				timeoutMs: 1000,
			});
		} catch (error) {
			message = error instanceof Error ? error.message : "";
		}
		expect(message).toContain("Review LLM HTTP 400");
		expect(message).toContain("code=context_length_exceeded");
		expect(message).toContain(`trace=${trace}`);
		expect(message).toContain("retry_after_ms=2000");
		expect(message).toContain("category=context_limit");
		expect(message).not.toContain(secret);
		expect(message).not.toContain("fixture prompt");
		expect(stub.requests).toHaveLength(1);
	} finally {
		stub.close();
	}
});
