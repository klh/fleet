import { expect, test } from "@playwright/test";
import { readWireJson } from "../hooks/lib/runners/api/wire.ts";

test("wire limit counts actual UTF-8 bytes before decoding JSON @unit", async () => {
	await expect(
		readWireJson(new Response(JSON.stringify("ü".repeat(8))), 16),
	).rejects.toThrow("runner.body_too_large");
	await expect(readWireJson(new Response(null))).rejects.toThrow(
		"runner.invalid_body",
	);
});

test("a stalled body and hanging cancellation cannot pin the handler @unit", async () => {
	const stream = new ReadableStream<Uint8Array>({
		cancel() {
			return new Promise<void>(() => {});
		},
	});
	const started = Date.now();
	await expect(readWireJson(new Response(stream), 16, 10)).rejects.toThrow(
		"runner.body_timeout",
	);
	expect(Date.now() - started).toBeLessThan(1_000);
});
