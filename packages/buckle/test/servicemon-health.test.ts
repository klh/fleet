import { describe, expect, test } from "bun:test";
import { servicemon } from "../src/servicemon.ts";

describe("observability health semantics", () => {
	test("health verdict changes invalidate cached telemetry and ETags", async () => {
		let healthy = true;
		const handle = servicemon({
			service: "test",
			port: 0,
			refreshS: 60,
			healthy: () => healthy,
		}).fetch(() => new Response("ok"));
		const first = await handle(new Request("http://localhost/status"));
		expect((await first.json()).healthy).toBe(true);
		healthy = false;
		const failed = await handle(
			new Request("http://localhost/status", {
				headers: { "if-none-match": first.headers.get("etag") ?? "" },
			}),
		);
		expect(failed.status).toBe(200);
		expect((await failed.json()).healthy).toBe(false);
		healthy = true;
		expect(
			(await (await handle(new Request("http://localhost/status"))).json())
				.healthy,
		).toBe(true);
	});

	test("a throwing health callback fails closed without escaping the request", async () => {
		const handle = servicemon({
			service: "test",
			port: 0,
			healthy: () => {
				throw new Error("probe unavailable");
			},
		}).fetch(() => new Response("ok"));
		const response = await handle(new Request("http://localhost/status"));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.healthy).toBe(false);
		expect(body.last_error.message).toBe("probe unavailable");
	});

	test("HEAD telemetry returns GET headers without a body", async () => {
		const handle = servicemon({ service: "test", port: 0 }).fetch(
			() => new Response("ok"),
		);
		for (const path of ["/status", "/metrics"]) {
			const response = await handle(
				new Request(`http://localhost${path}`, { method: "HEAD" }),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).not.toBeNull();
			expect(await response.text()).toBe("");
		}
	});
});
