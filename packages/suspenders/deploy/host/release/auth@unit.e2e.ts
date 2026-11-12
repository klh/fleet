import { withDeadline, boundedBody } from "./http.ts";
import { expect, test } from "@playwright/test";
import { productionDriver } from "./registry.ts";
const bytes = (value: string) => new TextEncoder().encode(value);
const command = async (argv: string[]) =>
	argv[1] === "api"
		? bytes('{"login":"fixture-user"}')
		: bytes("fixture-secret-never-output");

test("production token body ignoring abort is deadline-bounded and releases its reader @unit", async () => {
	const body = new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => {});
		},
		cancel() {
			return new Promise(() => {});
		},
	});
	const driver = await productionDriver(
		"/fixture",
		async (url) => {
			expect(url.startsWith("https://ghcr.io/token?")).toBe(true);
			return new Response(body);
		},
		{ command, timeoutMs: 50 },
	);
	const outcome = await Promise.race([
		driver.read(`sha256:${"a".repeat(64)}`).then(
			() => "success",
			() => "refused",
		),
		new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150)),
	]);
	expect(outcome).toBe("refused");
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(body.locked).toBe(false);
});
test("production token oversized body with never-cancel refuses without leaking secret diagnostics @unit", async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(64 * 1024 + 1));
		},
		cancel() {
			return new Promise(() => {});
		},
	});
	const driver = await productionDriver(
		"/fixture",
		async () => new Response(body),
		{ command, timeoutMs: 50 },
	);
	const error = await driver.read(`sha256:${"a".repeat(64)}`).then(
		() => "",
		(error) => String(error),
	);
	expect(error).not.toBe("");
	expect(error).not.toContain("fixture-secret-never-output");
	expect(body.locked).toBe(false);
});

test("parent abort bounds token/body work before its longer local deadline @unit", async () => {
	const abort = new AbortController();
	const body = new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => {});
		},
		cancel() {
			return new Promise(() => {});
		},
	});
	const response = new Response(body);
	const operation = withDeadline(
		(_signal, wait) => boundedBody(response, 65536, wait),
		1000,
		abort.signal,
	);
	setTimeout(() => abort.abort(), 20);
	const outcome = await Promise.race([
		operation.then(
			() => "success",
			() => "refused",
		),
		new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150)),
	]);
	expect(outcome).toBe("refused");
	expect(body.locked).toBe(false);
});
