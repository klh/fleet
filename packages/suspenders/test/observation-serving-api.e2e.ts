import { expect, test } from "@playwright/test";
import { boardFixture } from "./helpers/board-fixture.ts";

const f = await boardFixture(0, test.afterAll);

// per-(source, bootId) sequence counters — ingest detects gaps per key, so
// every helper event must take the next seq for ITS (source, boot) pair
const seqs = new Map<string, number>();
const seqFor = (source: string, bootId: string) => {
	const key = `${source}/${bootId}`;
	const n = (seqs.get(key) ?? 0) + 1;
	seqs.set(key, n);
	return n;
};
const ev = (over: Record<string, unknown> = {}) => {
	const source = (over.source as string) ?? "foreign-store";
	const bootId = (over.bootId as string) ?? "test-boot";
	return {
		id: crypto.randomUUID(),
		source,
		bootId,
		seq: seqFor(source, bootId),
		type: "request.ended",
		projectId: "/proj-a/.git",
		laneId: "lane-a1",
		requestId: `req-${crypto.randomUUID().slice(0, 8)}`,
		sourceTime: Date.now(),
		outcome: "ok",
		latencyMs: 120,
		...over,
	};
};
const ingest = (events: unknown[]) =>
	f.post("/api/observation-plane/ingest", { events });

test("ingest requires the write token and reports honest accounting", async () => {
	const denied = await fetch(`${f.BASE}/api/observation-plane/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ events: [ev()] }),
	});
	expect(denied.status).toBe(403);
	// same source/boot → next seq per event; the replay re-posts THE batch
	const batch = [ev(), ev({ laneId: "lane-a2", type: "request.started" })];
	const first = await ingest(batch);
	expect(first.status).toBe(200);
	expect(first.json.ok).toBe(true);
	expect(first.json.accepted).toBe(2);
	expect(first.json.duplicates).toBe(0);
	expect(first.json.store).toBeTruthy();
	const replay = await ingest(batch);
	expect(replay.json.accepted).toBe(0);
	expect(replay.json.duplicates).toBe(2);
	const mixed = await ingest([{ garbage: 1 }, ev({ laneId: "lane-a3" })]);
	expect(mixed.status).toBe(200);
	expect(mixed.json.accepted).toBe(1);
	expect(mixed.json.invalid).toBe(1);
	const capped = await ingest(Array.from({ length: 201 }, () => ev()));
	expect(capped.status).toBe(400);
	expect(capped.json.error).toContain("Batch exceeds");
	const big = await f.post("/api/observation-plane/ingest", {
		events: [],
		pad: "x".repeat(300_000),
	});
	expect(big.status).toBe(413);
	const wrongMethod = await fetch(`${f.BASE}/api/observation-plane/ingest`);
	expect(wrongMethod.status).toBe(405);
}, 15_000);

test("scoped projection queries enforce the visibility split server-side", async () => {
	// this install's observer identity (minted at first ingest) — lanes whose
	// presence carries ITS source get authority-derived status for owns
	const store = (await ingest([ev({ laneId: "lane-a4" })])).json
		.store as string;
	await ingest([
		ev({
			source: store,
			bootId: "board-boot",
			type: "lane.admitted",
			projectId: "/proj-own/.git",
			laneId: "lane-own",
		}),
		ev({
			source: store,
			bootId: "board-boot",
			type: "lane.presence",
			projectId: "/proj-own/.git",
			laneId: "lane-own",
		}),
	]);
	const observes = await fetch(`${f.BASE}/api/observation-plane/lanes`).then(
		(r) => r.json(),
	);
	expect(observes.ok).toBe(true);
	expect(observes.visibility).toBe("observes");
	expect(observes.counts.lanes).toBe(5);
	for (const lane of observes.lanes) {
		expect(lane.status).toBe("unknown");
		expect(lane.detail).toBeNull();
	}
	const ownsDenied = await fetch(
		`${f.BASE}/api/observation-plane/lanes?visibility=owns`,
	);
	expect(ownsDenied.status).toBe(403);
	const owns = await fetch(
		`${f.BASE}/api/observation-plane/lanes?visibility=owns`,
		{ headers: { "x-klh-write-token": f.TOKEN } },
	).then((r) => r.json());
	expect(owns.visibility).toBe("owns");
	const ownLane = owns.lanes.find(
		(l: { laneId: string }) => l.laneId === "lane-own",
	);
	expect(ownLane?.status).toBe("active");
	const foreignLane = owns.lanes.find(
		(l: { laneId: string }) => l.laneId === "lane-a1",
	);
	expect(foreignLane?.status).toBe("unknown");
	expect(foreignLane?.detail).not.toBeNull();
	const scoped = await fetch(
		`${f.BASE}/api/observation-plane/lanes?projects=${encodeURIComponent("/proj-a/.git")}`,
	).then((r) => r.json());
	expect(scoped.counts.lanes).toBe(4);
	for (const lane of scoped.lanes) expect(lane.projectId).toBe("/proj-a/.git");
	const noScope = await fetch(
		`${f.BASE}/api/observation-plane/lanes?visibility=authorized`,
	);
	expect(noScope.status).toBe(400);
	const authorized = await fetch(
		`${f.BASE}/api/observation-plane/lanes?visibility=authorized&projects=${encodeURIComponent("/proj-a/.git")}`,
		{ headers: { "x-klh-write-token": f.TOKEN } },
	).then((r) => r.json());
	const authLane = authorized.lanes.find(
		(l: { laneId: string }) => l.laneId === "lane-a1",
	);
	expect(authLane?.detail).not.toBeNull();
	expect(
		authorized.lanes.find((l: { laneId: string }) => l.laneId === "lane-own"),
	).toBeUndefined();
	const bogus = await fetch(
		`${f.BASE}/api/observation-plane/lanes?visibility=bogus`,
	);
	expect(bogus.status).toBe(400);
}, 15_000);

test("stream snapshots the scope, pushes filtered deltas, denies escalation", async () => {
	const denied = await fetch(
		`${f.BASE}/api/observation-plane/stream?visibility=owns`,
	);
	expect(denied.status).toBe(403);
	const ac = new AbortController();
	const stream = await fetch(
		`${f.BASE}/api/observation-plane/stream?projects=${encodeURIComponent("/proj-s/.git")}`,
		{ signal: ac.signal, headers: { accept: "text/event-stream" } },
	);
	expect(stream.status).toBe(200);
	expect(stream.headers.get("content-type")).toContain("text/event-stream");
	if (!stream.body) throw new Error("stream body missing");
	const reader = stream.body.getReader();
	const seen: string[] = [];
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
	// snapshot arrives first — the scope is empty at subscribe
	expect(await readUntil("event: snapshot")).toBe(true);
	// an OUT-OF-SCOPE ingest must not even wake the stream (the probe is
	// scoped: an observes viewer never learns when foreign projects ingest)
	await ingest([
		ev({ projectId: "/proj-t/.git", laneId: "lane-t1", type: "lane.admitted" }),
	]);
	await f.sleep(1300);
	expect(seen.join("").includes("event: delta")).toBe(false);
	// an in-scope ingest pushes within a poll interval, scoped content only
	await ingest([
		ev({ projectId: "/proj-s/.git", laneId: "lane-s1", type: "lane.admitted" }),
	]);
	expect(await readUntil("event: delta")).toBe(true);
	expect(seen.join("")).toContain("lane-s1");
	expect(seen.join("")).not.toContain("proj-t");
	ac.abort();
}, 15_000);
