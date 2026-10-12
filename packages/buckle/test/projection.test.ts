// test/projection.test.ts — W461 stage 3: the lane/route read model —
// idempotent ingest, gap reconciliation, scoped queries, pagination.
import { describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import type { Observation } from "../src/observe.ts";
import { LaneProjection, OutboxTailer } from "../src/projection.ts";

const SRC = "buckle://nas/boot1";
let seq = 0;
const obs = (
	type: Observation["type"],
	data: Record<string, unknown>,
	source = SRC,
): Observation => ({
	specversion: "1.0",
	type,
	source,
	id: String(++seq),
	time: new Date().toISOString(),
	data: data as Observation["data"],
});

const ADMIT = {
	rid: "r1",
	lane: "autow461",
	actor: "k",
	dialect: "openai",
	model: "m",
	traceparent: "00-a-b-01",
};

describe("LaneProjection", () => {
	test("ingest is idempotent by source+id; edges project admitted→ended", () => {
		const db = `/tmp/buckle-proj-${Date.now()}.db`;
		const p = new LaneProjection(db);
		const batch = [
			obs("lane.request.admitted", ADMIT),
			obs("lane.request.started", ADMIT),
			obs("lane.request.ended", {
				...ADMIT,
				outcome: "policy",
				status: 200,
				attempts: 1,
			}),
		];
		expect(p.ingest(batch)).toBe(3);
		expect(p.ingest(batch)).toBe(0); // same ids — deduped at the door
		const snap = p.snapshot();
		expect(snap.requests).toBe(1);
		expect(snap.lanes).toBe(1);
		expect(snap.groups[0]?.active).toBe(0);
		expect(snap.edges[0]?.outcome).toBe("policy");
		expect(snap.edges[0]?.attempts).toBe(1);
		p.close();
	});

	test("a sequence gap closes that observer's stuck active edges as unknown", () => {
		const db = `/tmp/buckle-proj-gap-${Date.now()}.db`;
		const p = new LaneProjection(db);
		p.ingest([obs("lane.request.admitted", { ...ADMIT, rid: "rA" })]);
		// seq jumps (crash / rotation lost events) → rA can never end
		seq += 5;
		p.ingest([obs("lane.request.admitted", { ...ADMIT, rid: "rB" })]);
		const snap = p.snapshot();
		// rA (pre-gap) reconciled; rB (this batch) is legitimately active
		expect(snap.groups[0]?.active).toBe(1);
		const rA = snap.edges.find((e) => e.rid === "rA");
		expect(rA?.outcome).toBe("unknown");
		expect(rA?.endedAt).not.toBeNull();
		p.close();
	});

	test("W706: relayed origin + peer project onto the edge", () => {
		const db = `/tmp/buckle-proj-hop-${Date.now()}.db`;
		const p = new LaneProjection(db);
		p.ingest([
			obs("lane.request.admitted", { ...ADMIT, origin: "hubA", peer: "hubA" }),
			obs("lane.request.admitted", { ...ADMIT, rid: "rLocal", origin: "local" }),
		]);
		const snap = p.snapshot();
		const relayed = snap.edges.find((e) => e.rid === "r1");
		expect(relayed?.origin).toBe("hubA");
		expect(relayed?.peer).toBe("hubA");
		const local = snap.edges.find((e) => e.rid === "rLocal");
		expect(local?.origin).toBe("local");
		expect(local?.peer).toBeNull();
		// the W706 origin filter is its own axis, distinct from the observer
		expect(p.snapshot({ originFilter: "hubA" }).requests).toBe(1);
		p.close();
	});

	test("scoped queries: origin filter, errorOnly, keyset pagination + resync", () => {
		const db = `/tmp/buckle-proj-scope-${Date.now()}.db`;
		const p = new LaneProjection(db);
		const rows: Observation[] = [];
		for (let i = 0; i < 25; i++) {
			rows.push(
				obs(
					"lane.request.admitted",
					{ ...ADMIT, rid: `r${i}` },
					i < 10 ? SRC : "buckle://desktop/boot2",
				),
			);
			rows.push(
				obs(
					"lane.request.ended",
					{
						...ADMIT,
						rid: `r${i}`,
						outcome: i % 5 === 0 ? "errored" : "policy",
						status: i % 5 === 0 ? 502 : 200,
					},
					i < 10 ? SRC : "buckle://desktop/boot2",
				),
			);
		}
		p.ingest(rows);
		const all = p.snapshot();
		expect(all.groups).toHaveLength(2);
		expect(all.lanes).toBe(1); // one lane observed through two origins
		expect(all.errors).toBe(5);
		const nas = p.snapshot({ source: "buckle://desktop/boot2" });
		expect(nas.requests).toBe(15);
		const errs = p.snapshot({ errorOnly: true });
		expect(errs.requests).toBe(5);
		// keyset pagination with resync when the cursor predates retention
		const page1 = p.snapshot({ limit: 10 });
		expect(page1.edges).toHaveLength(10);
		expect(page1.nextCursor).not.toBeNull();
		const page2 = p.snapshot({ limit: 10, cursor: page1.nextCursor });
		expect(page2.edges).toHaveLength(10);
		expect(page2.edges[0]?.rid).not.toBe(page1.edges[0]?.rid);
		const gone = p.snapshot({ cursor: "1:r0" });
		expect(gone.resync).toBe(true);
		p.close();
	});
});

describe("OutboxTailer", () => {
	test("tails complete lines only, tolerates rotation and torn tails", async () => {
		const dir = `/tmp/buckle-tail-${Date.now()}`;
		const path = `${dir}/obs.jsonl`;
		const p = new LaneProjection(`${dir}/proj.db`);
		const t = new OutboxTailer(p, path);
		await Bun.write(path, "");
		expect(await t.poll()).toBe(0);
		// each write simulates the outbox having grown (full file rewritten)
		const line1 = `${JSON.stringify(obs("lane.request.admitted", ADMIT))}\n`;
		await Bun.write(path, `${line1}{"torn":`);
		expect(await t.poll()).toBe(1); // torn tail waits
		await Bun.write(
			path,
			`${line1}{"torn":}\n${JSON.stringify(obs("lane.request.started", ADMIT))}\n`,
		);
		expect(await t.poll()).toBe(1);
		const snap = p.snapshot();
		expect(snap.requests).toBe(1);
		expect(snap.edges[0]?.startedAt).not.toBeNull();
		await rm(dir, { recursive: true, force: true });
	});

	test("a torn line completes via append — no carry doubling, nothing dropped", async () => {
		const dir = `/tmp/buckle-tail-append-${Date.now()}`;
		const path = `${dir}/obs.jsonl`;
		const p = new LaneProjection(`${dir}/proj.db`);
		const t = new OutboxTailer(p, path);
		const a = obs("lane.request.admitted", { ...ADMIT, rid: "r1" });
		const b = obs("lane.request.started", { ...ADMIT, rid: "r1" });
		const c = obs("lane.request.ended", {
			...ADMIT,
			rid: "r1",
			outcome: "ok",
			status: 200,
			attempts: 1,
		});
		const torn = JSON.stringify(b).slice(0, 24);
		await Bun.write(path, `${JSON.stringify(a)}\n${torn}`);
		expect(await t.poll()).toBe(1); // a lands; torn b waits
		expect(await t.poll()).toBe(0); // polls while torn stay quiet
		await appendFile(path, `${JSON.stringify(b).slice(24)}\n`);
		expect(await t.poll()).toBe(1); // b parses whole, not carry-glued
		await appendFile(path, `${JSON.stringify(c)}\n`);
		expect(await t.poll()).toBe(1);
		const snap = p.snapshot();
		expect(snap.requests).toBe(1);
		expect(snap.edges[0]?.startedAt).not.toBeNull();
		expect(snap.edges[0]?.endedAt).not.toBeNull();
		expect(snap.edges[0]?.outcome).toBe("ok");
		p.close();
		await rm(dir, { recursive: true, force: true });
	});
});
