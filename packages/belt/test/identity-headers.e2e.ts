// W1081 — chain-walk: every error envelope from the router identifies its
// emitting layer from headers alone (x-klh-service / x-klh-hop /
// x-klh-refusal). Spawns the real :4000 shim and walks the early paths —
// no upstream needed for 404, health, or bad-json.
import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routerRuntimeRevision } from "../bin/router-runtime-revision.ts";

const home = mkdtempSync(join(tmpdir(), "w1081-router-"));
mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
mkdirSync(join(home, ".claude-insights"), { recursive: true });
writeFileSync(
	join(home, ".claude", "local-llm", "prefs.json"),
	JSON.stringify({ allow_cloud: false, cost_speed: "balanced" }),
);

const port = (() => {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const free = server.port;
	server.stop(true);
	return free;
})();
const base = `http://127.0.0.1:${port}`;
let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;

test.beforeAll(async () => {
	proc = Bun.spawn(
		["bun", new URL("../bin/router-shim.ts", import.meta.url).pathname],
		{
			env: {
				...process.env,
				HOME: home,
				BELT_ROUTER_PORT: String(port),
			},
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(`${base}/health`)).ok) return;
		} catch {
			// Waiting for the child to bind.
		}
		await Bun.sleep(50);
	}
	throw new Error("router did not start");
});

test.afterAll(() => {
	proc?.kill();
});

test("W1081 chain-walk: unknown path → 404 attributed to belt ingress @unit", async () => {
	const r = await fetch(`${base}/nope`);
	expect(r.status).toBe(404);
	expect(r.headers.get("x-klh-service")).toBe("belt");
	expect(r.headers.get("x-klh-hop")).toBe("ingress");
	expect(r.headers.get("x-klh-refusal")).toBe("no_route");
});

test("W1081 chain-walk: health envelope names the belt probe face @unit", async () => {
	const r = await fetch(`${base}/health`);
	expect(r.status).toBe(200);
	expect(r.headers.get("x-klh-service")).toBe("belt-router");
	expect(r.headers.get("x-klh-hop")).toBe("probe");
	expect(r.headers.get("x-belt-runtime-revision")).toBe(
		routerRuntimeRevision(
			new URL("../bin/router-shim.ts", import.meta.url).pathname,
		),
	);
});

test("W1081 chain-walk: bad json → 400 attributed to belt ingress @unit", async () => {
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{not json",
	});
	expect(r.status).toBe(400);
	expect(r.headers.get("x-klh-service")).toBe("belt");
	expect(r.headers.get("x-klh-refusal")).toBe("bad_json");
});
