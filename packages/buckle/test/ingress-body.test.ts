import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readIngressJson } from "../src/ingress-body.ts";
import { startServer } from "../src/server.ts";

test("a stalled request body times out and cancels its reader", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const request = new Request("http://localhost/v1/messages", {
		method: "POST",
		body,
		duplex: "half",
	});
	await expect(readIngressJson(request, 30, 1024)).rejects.toMatchObject({
		code: "timeout",
	});
	expect(cancelled).toBe(true);
});

test("bounded ingress parses valid JSON and rejects excess bytes", async () => {
	const valid = new Request("http://localhost/v1/messages", {
		method: "POST",
		body: '{"model":"canary"}',
	});
	expect(await readIngressJson(valid, 1000, 1024)).toEqual({ model: "canary" });
	const oversized = new Request("http://localhost/v1/messages", {
		method: "POST",
		body: '{"model":"a-long-model"}',
	});
	await expect(readIngressJson(oversized, 1000, 4)).rejects.toMatchObject({
		code: "too_large",
	});
});

test("real Buckle returns 408 for an incomplete request body", async () => {
	const path = `/tmp/buckle-ingress-${process.pid}-${Date.now()}.yaml`;
	await Bun.write(path, "groups: {}\n");
	const gate = startServer({
		port: 0,
		dbPath: ":memory:",
		upstreamsPath: path,
		ingressBodyTimeoutMs: 50,
		auth: { rootKey: "ingress-fixture-root" },
	});
	try {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"model":'));
			},
		});
		const response = await fetch(`http://127.0.0.1:${gate.port}/v1/messages`, {
			method: "POST",
			headers: {
				authorization: "Bearer ingress-fixture-root",
				"content-type": "application/json",
			},
			body,
			duplex: "half",
		});
		expect(response.status).toBe(408);
	} finally {
		gate.stop(true);
		rmSync(path, { force: true });
	}
}, 5_000);
