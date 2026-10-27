// W1081 — chain-walk: every error envelope from the router identifies its
// emitting layer from headers alone (x-klh-service / x-klh-hop /
// x-klh-refusal). Spawns the real :4000 shim and walks the early paths —
// no upstream needed for 404, health, or bad-json.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routerRuntimeRevision } from "../bin/router-runtime-revision.ts";
import { freePort, scratchWorld, waitUp } from "@klh/test-kit";

const { home, env, clean } = scratchWorld({ prefix: "w1081-router-" });
mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
mkdirSync(join(home, ".claude-insights"), { recursive: true });
writeFileSync(
	join(home, ".claude", "local-llm", "prefs.json"),
	JSON.stringify({ allow_cloud: false, cost_speed: "balanced" }),
);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;

beforeAll(async () => {
	proc = Bun.spawn(
		["bun", new URL("../bin/router-shim.ts", import.meta.url).pathname],
		{
			env: {
				...env,
				BELT_ROUTER_PORT: String(port),
				BELT_UPSTREAM_KEY: "bksk_test-scoped-fake",
			},
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	await waitUp(`${base}/health`);
});

afterAll(() => {
	proc?.kill();
	clean();
});

test("W1081 chain-walk: unknown path → 404 attributed to belt ingress", async () => {
	const r = await fetch(`${base}/nope`);
	expect(r.status).toBe(404);
	expect(r.headers.get("x-klh-service")).toBe("belt");
	expect(r.headers.get("x-klh-hop")).toBe("ingress");
	expect(r.headers.get("x-klh-refusal")).toBe("no_route");
});

test("W1081 chain-walk: health envelope names the belt probe face", async () => {
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

test("W1081 chain-walk: bad json → 400 attributed to belt ingress", async () => {
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer bksk_test-scoped-fake",
		},
		body: "{not json",
	});
	expect(r.status).toBe(400);
	expect(r.headers.get("x-klh-service")).toBe("belt");
	expect(r.headers.get("x-klh-refusal")).toBe("bad_json");
});
