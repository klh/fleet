import { expect, test } from "bun:test";
import {
	beginTrace,
	childTraceparent,
	safeCorrelationId,
	safeFailureKind,
	stampResponse,
	traceIdOf,
} from "../src/http-trace.ts";

test("trace context roots, forwards and creates a child span", () => {
	const root = beginTrace(new Headers());
	expect(traceIdOf(root.traceparent)).toBe(root.traceId);
	const child = childTraceparent(root.traceparent);
	expect(traceIdOf(child)).toBe(root.traceId);
	expect(child).not.toBe(root.traceparent);
	const forwarded = beginTrace(
		new Headers({ traceparent: child, "x-klh-request-id": root.requestId }),
	);
	expect(forwarded).toEqual({
		traceparent: child,
		traceId: root.traceId,
		requestId: root.requestId,
	});
});

test("untrusted or malformed correlation data never becomes a header", () => {
	expect(
		traceIdOf("00-00000000000000000000000000000000-1234567890abcdef-01"),
	).toBeUndefined();
	expect(safeCorrelationId("x\r\nsecret: value")).toBeUndefined();
	expect(safeCorrelationId("bad/value")).toBeUndefined();
	expect(safeCorrelationId("x".repeat(129))).toBeUndefined();
	const response = stampResponse(new Response("no", { status: 429 }), {
		service: "buckle",
		hop: "upstream",
		refusal: "rate_limited",
		upstreamId: "bad\nrequest",
		callId: "call-123",
		attempts: 2,
		upstreamStatus: 429,
	});
	expect(response.headers.get("x-klh-service")).toBe("buckle");
	expect(response.headers.get("x-klh-refusal")).toBe("rate_limited");
	expect(response.headers.get("x-klh-upstream-request-id")).toBeNull();
	expect(response.headers.get("x-litellm-call-id")).toBe("call-123");
	expect(response.headers.get("x-klh-attempts")).toBe("2");
	expect(response.headers.get("x-klh-upstream-status")).toBe("429");
});

test("failure kind excludes messages and unsafe transport codes", () => {
	expect(safeFailureKind(new Error("secret prompt"))).toBe("error");
	const err = Object.assign(new TypeError("private URL"), {
		code: "ECONNRESET",
	});
	expect(safeFailureKind(err)).toBe("typeerror:econnreset");
	expect(
		safeFailureKind(Object.assign(new Error("x"), { code: "bad\nkey" })),
	).toBe("error");
});

test("outer hop clears stale inner refusal and private upstream metadata", async () => {
	const inner = new Response("decoded", {
		headers: {
			"x-klh-service": "litellm",
			"x-klh-refusal": "provider-rate-limit",
			"x-klh-upstream-request-id": "provider-1",
			"x-litellm-key-spend": "12.34",
			"llm_provider-api-base": "https://internal.example",
			"content-encoding": "gzip",
			"content-length": "1234",
		},
	});
	const outer = stampResponse(inner, { service: "buckle", hop: "outbound" });
	expect(await outer.text()).toBe("decoded");
	expect(outer.headers.get("x-klh-service")).toBe("buckle");
	expect(outer.headers.get("x-klh-refusal")).toBeNull();
	expect(outer.headers.get("x-klh-upstream-request-id")).toBeNull();
	expect(outer.headers.get("x-litellm-key-spend")).toBeNull();
	expect(outer.headers.get("llm_provider-api-base")).toBeNull();
	expect(outer.headers.get("content-encoding")).toBeNull();
	expect(outer.headers.get("content-length")).toBeNull();
});
