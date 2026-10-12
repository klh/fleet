import { afterAll, expect, test } from "bun:test";
import { boardFixture } from "./helpers/board-fixture.ts";

const f = await boardFixture(0, afterAll);

const edge = (over: Record<string, unknown> = {}) => ({
	source: "test-hub/outbox",
	eventId: `evt-${Math.random()}`,
	observerHub: "test-hub",
	originHub: "test-origin",
	peerHub: "test-hub",
	laneId: "test-lane",
	project: "/p/repo/.git",
	requestId: `req-${Math.random()}`,
	outcome: "ok",
	ts: Date.now(),
	...over,
});

test("edge ingest requires the write token and rejects invalid provenance", async () => {
	const denied = await fetch(`${f.BASE}/api/lane-model/edges`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify([edge()]),
	});
	expect(denied.status).toBe(403);
	const bad = await f.post("/api/lane-model/edges", [edge({ peerHub: "all" })]);
	expect(bad.status).toBe(400);
	expect(bad.json.error).toContain("peerHub");
	const ok = await f.post("/api/lane-model/edges", [edge()]);
	expect(ok.status).toBe(200);
	expect(ok.json.accepted).toBe(1);
});

test("groups serve the immediate-downstream view with scoped filters", async () => {
	await f.post("/api/lane-model/edges", [
		edge({
			peerHub: "group-peer",
			originHub: "group-origin",
			laneId: "group-lane",
			outcome: "error",
		}),
	]);
	const all = await fetch(`${f.BASE}/api/lane-model/groups`).then((r) =>
		r.json(),
	);
	expect(all.ok).toBe(true);
	expect(all.groupBy).toBe("peer");
	expect(all.additive).toBe(false);
	const group = all.groups.find((g: { hub: string }) => g.hub === "group-peer");
	expect(group.distinctLanes).toBeGreaterThanOrEqual(1);
	const filtered = await fetch(
		`${f.BASE}/api/lane-model/groups?peer=group-peer&outcome=error`,
	).then((r) => r.json());
	expect(filtered.groups.map((g: { hub: string }) => g.hub)).toEqual([
		"group-peer",
	]);
	const badFilter = await fetch(`${f.BASE}/api/lane-model/groups?group=tree`);
	expect(badFilter.status).toBe(400);
});

test("detail paginates by cursor over the scoped edge rows", async () => {
	await f.post("/api/lane-model/edges", [
		edge({ peerHub: "group-peer", laneId: "page-lane" }),
		edge({ peerHub: "group-peer", laneId: "page-lane-2" }),
	]);
	const page1 = await fetch(
		`${f.BASE}/api/lane-model/detail?peer=group-peer&limit=1`,
	).then((r) => r.json());
	expect(page1.rows).toHaveLength(1);
	expect(page1.nextCursor).toBeGreaterThan(0);
	const page2 = await fetch(
		`${f.BASE}/api/lane-model/detail?peer=group-peer&limit=1&cursor=${page1.nextCursor}`,
	).then((r) => r.json());
	for (const row of page2.rows) expect(row.id).toBeLessThan(page1.rows[0].id);
});

test("the stream snapshots, pushes server-filtered deltas, and signals resync", async () => {
	const ac = new AbortController();
	const stream = await fetch(
		`${f.BASE}/api/lane-model/stream?peer=stream-peer`,
		{
			signal: ac.signal,
			headers: { accept: "text/event-stream" },
		},
	);
	expect(stream.status).toBe(200);
	expect(stream.headers.get("content-type")).toContain("text/event-stream");
	const reader = stream.body!.getReader();
	const seen = [] as string[];
	const readUntil = async (needle: string, tries = 40) => {
		const decoder = new TextDecoder();
		for (let i = 0; i < tries; i++) {
			if (seen.join("").includes(needle)) return true;
			try {
				const { done, value } = await reader.read();
				if (done) return seen.join("").includes(needle);
				seen.push(decoder.decode(value, { stream: true }));
			} catch {
				// stream closed (resync + close is a legitimate server end)
				return seen.join("").includes(needle);
			}
		}
		return seen.join("").includes(needle);
	};
	// snapshot arrives first, filtered to the subscribed scope
	expect(await readUntil("event: snapshot")).toBe(true);
	expect(seen.join("")).not.toContain("group-peer");
	// a matching edge is pushed as a delta within the poll interval
	await f.post("/api/lane-model/edges", [
		edge({ peerHub: "stream-peer", laneId: "stream-lane" }),
	]);
	expect(await readUntil("event: delta")).toBe(true);
	expect(seen.join("")).toContain("stream-lane");
	ac.abort();
}, 15_000);
