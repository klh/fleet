// test/observe.test.ts — W461 stage 2: the observation outbox (envelope,
// sequence, bounded persistence) and the admitted/started/ended emissions
// through the proxy path.
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { ObservationOutbox } from "../src/observe.ts";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const DATA = {
	rid: "r1",
	lane: "autow461",
	actor: "k1",
	dialect: "openai",
	model: "glm-5.3-flash",
	traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
};

describe("ObservationOutbox", () => {
	test("monotonic ids per boot; stable source+id dedup pair", () => {
		const dir = `/tmp/buckle-obs-${Date.now()}`;
		const box = new ObservationOutbox({
			path: `${dir}/obs.jsonl`,
			hubId: "nas",
			bootId: "boot1",
		});
		box.emit("lane.request.admitted", DATA);
		box.emit("lane.request.started", DATA);
		expect(box.source).toBe("buckle://nas/boot1");
		expect(box.stats().seq).toBe(2);
	});

	test("persists CloudEvents-shaped NDJSON, oldest generation first", async () => {
		const dir = `/tmp/buckle-obs-${Date.now()}-r`;
		const path = `${dir}/obs.jsonl`;
		const box = new ObservationOutbox({ path, maxBytes: 256, bootId: "b1" });
		for (let i = 0; i < 20; i++)
			box.emit("lane.request.admitted", { ...DATA, rid: `r${i}` });
		await new Promise((r) => setTimeout(r, 50)); // writer drains
		const obs = await ObservationOutbox.read(path);
		expect(obs.length).toBeGreaterThan(0);
		expect(obs.every((o) => o.specversion === "1.0")).toBe(true);
		expect(obs[0]?.type).toBe("lane.request.admitted");
		// ids never repeat within a boot, even across rotations
		const ids = obs.map((o) => o.id);
		expect(new Set(ids).size).toBe(ids.length);
		await rm(dir, { recursive: true, force: true });
	});

	test("bounded queue drops oldest explicitly", () => {
		const box = new ObservationOutbox({
			path: `/tmp/buckle-obs-drop-${Date.now()}/obs.jsonl`,
		});
		for (let i = 0; i < 2000; i++)
			box.emit("lane.request.admitted", { ...DATA, rid: `r${i}` });
		expect(box.stats().dropped).toBeGreaterThan(0);
	});
});

describe("observation emissions through the proxy", () => {
	async function rig(
		handler: (req: Request, body: Record<string, unknown> | null, n: number) => Response,
	): Promise<{ outbox: ObservationOutbox; path: string }> {
		const upstream = await startMockUpstream(handler);
		const path = `/tmp/buckle-obs-emit-${Date.now()}/obs.jsonl`;
		const outbox = new ObservationOutbox({ path, bootId: "bt" });
		const deps: AppDeps = {
			...testDeps({
				groups: () => ["glm-5.3-flash"],
				deployments: (g) => [{ group: g, url: upstream.url, dialect: "openai" as const }],
			} satisfies UpstreamPool),
			observations: outbox,
		};
		const app = createApp(deps);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
				body: JSON.stringify({ model: "glm-5.3-flash", stream: false }),
			}),
		);
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 50));
		return { outbox, path };
	}

	test("admitted → started → ended, correlated by rid + traceparent", async () => {
		const { path } = await rig(() => Response.json({ id: "1", choices: [] }));
		const obs = await ObservationOutbox.read(path);
		const types = obs.map((o) => o.type);
		expect(types).toEqual([
			"lane.request.admitted",
			"lane.request.started",
			"lane.request.ended",
		]);
		expect(obs.every((o) => o.data.rid === obs[0]?.data.rid)).toBe(true);
		expect(obs[0]?.data.traceparent).toBe(
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		);
		const ended = obs[2];
		expect(ended?.data.outcome).toBe("policy");
		expect(ended?.data.status).toBe(200);
		expect(ended?.data.attempts).toBe(1);
	});

	test("a refused route still ends (outcome errored, never stuck active)", async () => {
		const upstream = await startMockUpstream(() => Response.json({ id: "1" }));
		const path = `/tmp/buckle-obs-deny-${Date.now()}/obs.jsonl`;
		const outbox = new ObservationOutbox({ path, bootId: "bt" });
		const deps: AppDeps = {
			...testDeps({
				groups: () => ["glm-5.3-flash"],
				deployments: () => [],
			} satisfies UpstreamPool),
			observations: outbox,
		};
		const app = createApp(deps);
		await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({ model: "glm-5.3-flash", stream: false }),
			}),
		);
		await new Promise((r) => setTimeout(r, 50));
		const obs = await ObservationOutbox.read(path);
		const types = obs.map((o) => o.type);
		expect(types).toEqual(["lane.request.admitted", "lane.request.ended"]);
		expect(obs[1]?.data.outcome).toBe("errored");
		upstream.close();
	});
});
