// hooks/board-html/feed-store.e2e.ts — the board feed store contract: one
// request in flight per feed, page-wide concurrency cap, adaptive cadence
// (slow stretch, jittered backoff, Retry-After), hidden pause, scope
// discard/refetch, rescope abort, ts/ETag no-op change detection.
import { expect, test } from "@playwright/test";
import { type FeedSpec, FeedStore } from "./feed-store.ts";

type Pending = {
	url: string;
	init: RequestInit;
	resolve: (r: unknown) => void;
	reject: (e: unknown) => void;
};

function rig(over: Record<string, unknown> = {}) {
	const pending: Pending[] = [];
	const timers: { fn: () => void; ms: number; id: number }[] = [];
	let clock = 1_000_000;
	let hidden = false;
	let seq = 0;
	const store = new FeedStore({
		fetch: (url, init) =>
			new Promise((resolve, reject) =>
				pending.push({ url, init, resolve, reject }),
			) as Promise<Response>,
		now: () => clock,
		random: () => 1,
		setTimer: (fn, ms) => {
			seq++;
			timers.push({ fn, ms, id: seq });
			return seq;
		},
		clearTimer: (id) => {
			const i = timers.findIndex((t) => t.id === id);
			if (i >= 0) timers.splice(i, 1);
		},
		hidden: () => hidden,
		...over,
	});
	const reply = (
		i: number,
		body: unknown,
		init: Record<string, unknown> = {},
	) =>
		pending[i].resolve({
			ok: (init.status ?? 200) === 200,
			status: init.status ?? 200,
			headers: new Headers((init.headers as Record<string, string>) ?? {}),
			json: async () => body,
		});
	// a sentinel abort timeout tells request timers from next-poll timers
	const TIMEOUT = 777_777;
	const pollTimers = () => timers.filter((t) => t.ms !== TIMEOUT);
	return {
		store,
		def: (name: string, spec: FeedSpec) =>
			store.define(name, { timeoutMs: TIMEOUT, ...spec }),
		fire: (t: { fn: () => void; id: number }) => {
			timers.splice(timers.indexOf(t as (typeof timers)[number]), 1);
			t.fn();
		},
		pending,
		timers,
		pollTimers,
		reply,
		advance: (ms: number) => {
			clock += ms;
		},
		setHidden: (v: boolean) => {
			hidden = v;
		},
	};
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test.describe("@unit", () => {
	test("one request in flight per feed; kick while busy is a no-op", async () => {
		const r = rig();
		r.def("data", { url: () => "/api/data" });
		r.store.kick("data");
		r.store.kick("data");
		r.store.kickDue();
		expect(r.pending).toHaveLength(1);
		r.reply(0, { ts: 1 });
		await flush();
		expect(r.store.get("data")?.busy).toBe(false);
		expect(r.store.get("data")?.data).toEqual({ ts: 1 });
	});

	test("page-wide concurrency cap queues FIFO and drains on settle", async () => {
		const r = rig({ maxInFlight: 2 });
		for (const n of ["a", "b", "c"]) r.def(n, { url: () => `/${n}` });
		r.store.kickDue();
		expect(r.pending.map((p) => p.url)).toEqual(["/a", "/b"]);
		r.reply(0, { ts: 1 });
		await flush();
		expect(r.pending.map((p) => p.url)).toEqual(["/a", "/b", "/c"]);
	});

	test("scope change mid-flight discards the stale answer and fetches the new scope", async () => {
		const r = rig();
		let scope = "a";
		const seen: unknown[] = [];
		r.def("dec", {
			url: () => `/api/decisions?project=${scope}`,
			ok: (d) => seen.push(d),
		});
		r.store.kick("dec");
		scope = "b";
		r.reply(0, { ts: 1, p: "a" });
		await flush();
		expect(seen).toEqual([]);
		expect(r.pending[1].url).toContain("project=b");
		r.reply(1, { ts: 1, p: "b" });
		await flush();
		// same ts but a different URL still counts as a change
		expect(seen).toEqual([{ ts: 1, p: "b" }]);
	});

	test("rescope aborts in-flight requests and refetches at once", async () => {
		const r = rig();
		r.def("tasks", { url: () => "/api/tasks" });
		r.store.kick("tasks");
		const first = r.pending[0].init.signal as AbortSignal;
		r.store.rescope();
		expect(first.aborted).toBe(true);
		expect(r.pending).toHaveLength(2);
		r.pending[0].reject(new Error("aborted"));
		r.reply(1, { ts: 5 });
		await flush();
		expect(r.store.get("tasks")?.err).toBeNull();
		expect(r.store.get("tasks")?.data).toEqual({ ts: 5 });
	});

	test("unchanged ts reports changed=false; 304 keeps the last data", async () => {
		const r = rig();
		const changes: boolean[] = [];
		r.def("data", { url: () => "/api/data" });
		r.store.subscribe("data", (_st, changed) => changes.push(changed));
		r.store.kick("data");
		r.reply(0, { ts: 7 }, { headers: { etag: 'W/"x"' } });
		await flush();
		r.store.kick("data");
		expect(
			(r.pending[1].init.headers as Record<string, string>)["if-none-match"],
		).toBe('W/"x"');
		r.reply(1, null, { status: 304 });
		await flush();
		r.store.kick("data");
		r.reply(2, { ts: 7 });
		await flush();
		expect(changes).toEqual([true, false, false]);
		expect(r.store.get("data")?.data).toEqual({ ts: 7 });
		expect(r.store.get("data")?.notModified).toBe(1);
	});

	test("cadence stretches to 2x a slow round-trip, capped at maxMs", async () => {
		const r = rig();
		r.def("data", { url: () => "/api/data", maxMs: 30000 });
		r.store.kick("data");
		r.advance(3000); // slow server: 3s round-trip
		r.reply(0, { ts: 1 });
		await flush();
		expect(r.pollTimers().map((t) => t.ms)).toEqual([6000]);
		r.fire(r.pollTimers()[0]);
		r.advance(40000);
		r.reply(1, { ts: 2 });
		await flush();
		expect(r.pollTimers().map((t) => t.ms)).toEqual([30000]);
	});

	test("errors back off exponentially with full jitter; success resets", async () => {
		const r = rig();
		const errs: string[] = [];
		r.def("data", { url: () => "/api/data", fail: (e) => errs.push(e) });
		const delays: number[] = [];
		for (let i = 0; i < 3; i++) {
			r.store.kick("data");
			r.reply(i, {}, { status: 500 });
			await flush();
			delays.push(r.pollTimers()[0].ms);
		}
		expect(errs).toEqual(["HTTP 500", "HTTP 500", "HTTP 500"]);
		expect(delays).toEqual([2000, 4000, 8000]); // random()=1 → the cap
		r.store.kick("data");
		r.reply(3, { ts: 1 });
		await flush();
		expect(r.pollTimers()[0].ms).toBe(1000);
		expect(r.store.get("data")?.fails).toBe(0);
	});

	test("429/503 Retry-After floors the backoff", async () => {
		const r = rig();
		r.def("data", { url: () => "/api/data" });
		r.store.kick("data");
		r.reply(0, {}, { status: 503, headers: { "retry-after": "20" } });
		await flush();
		expect(r.pollTimers()[0].ms).toBe(20000);
	});

	test("hidden pauses scheduling; kickDue resumes only due feeds", async () => {
		const r = rig();
		r.def("data", { url: () => "/api/data" });
		r.store.kick("data");
		r.setHidden(true);
		r.reply(0, { ts: 1 });
		await flush();
		expect(r.pollTimers()).toHaveLength(0);
		r.store.kickDue();
		expect(r.pending).toHaveLength(1);
		r.setHidden(false);
		r.store.kickDue(); // not yet due (1s cadence)
		expect(r.pending).toHaveLength(1);
		r.advance(1000);
		r.store.kickDue();
		expect(r.pending).toHaveLength(2);
	});

	test("inactive feeds (url null) never fetch; bad payloads surface as errors", async () => {
		const r = rig();
		let active = false;
		r.def("tasks", {
			url: () => (active ? "/api/tasks" : null),
			accept: (j) => {
				if (!Array.isArray((j as { tasks?: unknown }).tasks))
					throw new Error("bad /api/tasks payload");
			},
		});
		r.store.kickDue();
		expect(r.pending).toHaveLength(0);
		active = true;
		r.store.kickDue();
		r.reply(0, { ok: true });
		await flush();
		expect(r.store.get("tasks")?.err).toBe("bad /api/tasks payload");
	});
});
