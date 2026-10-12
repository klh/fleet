import { expect, test } from "bun:test";
import { probeService, type ProbeDeps } from "../hooks/board/service-probe.ts";

const depsFor = (response: () => Response): ProbeDeps => ({
	fetch: async () => response(),
	launchctl: async () => ({ code: 1, out: "" }),
	now: () => new Date(),
});

test("LiteLLM exact declared JSON liveness passes only its configured service probe", async () => {
	const deps = depsFor(() => Response.json("I'm alive!"));
	expect(await probeService("litellm-4100", deps)).toMatchObject({
		state: "up",
		up: true,
		detail: "HTTP 200 · process liveness",
	});
	expect(await probeService("belt-gateway-4000", deps)).toMatchObject({
		state: "degraded",
		up: false,
	});
});

test("LiteLLM contract rejects arbitrary scalars and misleading success objects", async () => {
	for (const body of [
		"alive",
		"I'm alive! ",
		true,
		1,
		null,
		[],
		{ ok: true },
		{ ok: false },
	]) {
		expect(
			await probeService(
				"litellm-4100",
				depsFor(() => Response.json(body)),
			),
		).toMatchObject({ state: "degraded", up: false });
	}
});

test("LiteLLM contract requires successful JSON response, not redirect or plain text", async () => {
	for (const response of [
		() => Response.json("I'm alive!", { status: 201 }),
		() => Response.json("I'm alive!", { status: 503 }),
		() => Response.redirect("/", 302),
		() => new Response("I'm alive!"),
		() => new Response(null, { status: 204 }),
		() =>
			new Response("broken", {
				headers: { "content-type": "application/json" },
			}),
	]) {
		expect(await probeService("litellm-4100", depsFor(response))).toMatchObject(
			{ state: "degraded", up: false },
		);
	}
});

test("LiteLLM contract bounds streamed JSON to 1KiB and cancels overflow", async () => {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(" ".repeat(1025)));
		},
		cancel() {
			cancelled = true;
		},
	});
	expect(
		await probeService(
			"litellm-4100",
			depsFor(
				() =>
					new Response(stream, {
						headers: { "content-type": "application/json" },
					}),
			),
		),
	).toMatchObject({ state: "degraded", up: false });
	expect(cancelled).toBe(true);
	const valid = JSON.stringify("I'm alive!");
	expect(
		await probeService(
			"litellm-4100",
			depsFor(
				() =>
					new Response(`${" ".repeat(1024 - valid.length)}${valid}`, {
						headers: { "content-type": "application/json; charset=utf-8" },
					}),
			),
		),
	).toMatchObject({ state: "up", up: true });
});
