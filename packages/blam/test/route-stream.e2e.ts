import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { probeStream } from "../bench/runner/route-stream.ts";

const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const answer = event({
	model: "glm-5.3-flash",
	choices: [{ delta: { content: '{"ok":true}' } }],
	usage: {
		prompt_tokens: 100,
		completion_tokens: 5,
		prompt_tokens_details: { cached_tokens: 80 },
	},
});

test.describe("live routing stream evidence @unit", () => {
	test("an absent cache counter stays unknown", async () => {
		const body = event({
			model: "glm-5.3-flash",
			choices: [{ delta: { content: '{"ok":true}' } }],
			usage: { prompt_tokens: 100, completion_tokens: 5 },
		});
		const stub = serveStub(() => new Response(`${body}data: [DONE]\n\n`));
		try {
			const sample = await probeStream(
				stub.url,
				"fixture",
				"glm-5.3-flash",
				"fixture",
				1000,
			);
			expect(sample.cacheReported).toBe(false);
			expect(sample.error).toBeNull();
		} finally {
			stub.close();
		}
	});
	test("deadline abort is recorded without a fabricated first output", async () => {
		const stub = serveStub(async () => {
			await Bun.sleep(80);
			return new Response(answer);
		});
		try {
			const sample = await probeStream(
				stub.url,
				"fixture",
				"glm-5.3-flash",
				"fixture",
				10,
			);
			expect(sample.error).toBe("deadline");
			expect(sample.timedOut).toBe(true);
			expect(sample.firstOutputMs).toBeNull();
		} finally {
			stub.close();
		}
	});
	test("redirects do not forward the scoped key", async () => {
		const destination = serveStub(() => new Response(answer));
		const source = serveStub(() => Response.redirect(destination.url));
		try {
			const sample = await probeStream(
				source.url,
				"fixture",
				"glm-5.3-flash",
				"fixture",
				1000,
			);
			expect(sample.error).not.toBeNull();
			expect(destination.requests).toHaveLength(0);
		} finally {
			source.close();
			destination.close();
		}
	});
	for (const [name, body, fails] of [
		["complete", `${answer}data: [DONE]\n\n`, false],
		["truncated", answer, true],
		[
			"role only",
			`${event({ choices: [{ delta: { role: "assistant" } }] })}data: [DONE]\n\n`,
			true,
		],
		[
			"in-band error",
			`${answer}${event({ error: { message: "failure" } })}data: [DONE]\n\n`,
			true,
		],
	] as const) {
		test(name, async () => {
			const stub = serveStub(
				() =>
					new Response(body, {
						headers: { "content-type": "text/event-stream" },
					}),
			);
			try {
				const result = await probeStream(
					stub.url,
					"fixture",
					"glm-5.3-flash",
					"fixture",
					1000,
				);
				expect(result.error !== null).toBe(fails);
				if (!fails) {
					expect(result.usage?.cache_r).toBe(80);
					expect(result.cacheReported).toBe(true);
					expect(result.firstByteMs).not.toBeNull();
					expect(result.firstOutputMs).not.toBeNull();
				}
				expect(stub.requests[0].body?.reasoning_effort).toBe("low");
			} finally {
				stub.close();
			}
		});
	}
});
