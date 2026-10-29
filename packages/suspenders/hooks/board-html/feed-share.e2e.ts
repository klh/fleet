// hooks/board-html/feed-share.e2e.ts — the cross-tab contract of FeedStore
// share(): one Web Lock leader polls, followers never fetch and land the
// leader's BroadcastChannel snapshots, a foreign follower scope rides a
// leader shadow feed, and closing the leader hands polling to a follower.
import { expect, test } from "@playwright/test";
import {
	type ChannelLike,
	type FeedSpec,
	FeedStore,
	type LockLike,
} from "./feed-store.ts";

type Tab = {
	store: FeedStore;
	fetched: string[];
	pending: { url: string; resolve: (r: unknown) => void }[];
	timers: { fn: () => void; ms: number; id: number }[];
	close: () => void;
};

/** One fake browser: a shared clock, a FIFO Web Lock and a channel bus. */
function browser() {
	let clock = 1_000_000;
	let seq = 0;
	const waiters: { tab: Tab; cb: () => Promise<unknown> }[] = [];
	let holder: Tab | null = null;
	const grant = () => {
		if (holder || !waiters.length) return;
		const w = waiters.shift();
		if (!w) return;
		holder = w.tab;
		void w.cb();
	};
	const members = new Set<{ tab: Tab; ch: ChannelLike }>();
	function open(defs: Record<string, FeedSpec>) {
		const tab = {} as Tab;
		tab.fetched = [];
		tab.pending = [];
		tab.timers = [];
		const store = new FeedStore({
			fetch: (url) => {
				tab.fetched.push(url);
				return new Promise((resolve) =>
					tab.pending.push({ url, resolve }),
				) as Promise<Response>;
			},
			now: () => clock,
			random: () => 1,
			setTimer: (fn, ms) => {
				seq++;
				tab.timers.push({ fn, ms, id: seq });
				return seq;
			},
			clearTimer: (id) => {
				const i = tab.timers.findIndex((t) => t.id === id);
				if (i >= 0) tab.timers.splice(i, 1);
			},
			hidden: () => false,
		});
		for (const [n, s] of Object.entries(defs))
			store.define(n, { timeoutMs: 777_777, ...s });
		const ch: ChannelLike = {
			onmessage: null,
			postMessage: (m) => {
				const copy = structuredClone(m);
				for (const o of members)
					if (o.ch !== ch)
						queueMicrotask(() => o.ch.onmessage?.({ data: copy }));
			},
		};
		const member = { tab, ch };
		members.add(member);
		const locks: LockLike = {
			request: (_n, cb) => {
				waiters.push({ tab, cb });
				queueMicrotask(grant);
				return new Promise(() => {});
			},
		};
		tab.store = store;
		tab.close = () => {
			members.delete(member);
			const i = waiters.findIndex((w) => w.tab === tab);
			if (i >= 0) waiters.splice(i, 1);
			if (holder === tab) holder = null;
			queueMicrotask(grant);
		};
		store.share({ locks, channel: ch, name: "t" });
		return tab;
	}
	return {
		open,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}
const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const reply = (t: Tab, i: number, body: unknown) =>
	t.pending[i].resolve({
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => body,
	});
const pollTimers = (t: Tab) => t.timers.filter((x) => x.ms !== 777_777);

test.describe("@unit", () => {
	test("one leader polls; followers land its snapshots and never fetch", async () => {
		const b = browser();
		const scope = "/api/data";
		const seen: unknown[] = [];
		const tabs = [0, 1, 2, 3].map((i) =>
			b.open({
				data: {
					url: () => scope,
					ok: (d) => {
						if (i > 0) seen.push(d);
					},
				},
			}),
		);
		await flush();
		expect(tabs.map((t) => t.store.role)).toEqual([
			"leader",
			"follower",
			"follower",
			"follower",
		]);
		for (const t of tabs) t.store.kick("data", true); // boot kicks
		await flush();
		expect(tabs[0].fetched).toEqual(["/api/data"]);
		reply(tabs[0], 0, { ts: 1, n: 1 });
		await flush();
		expect(seen).toEqual([
			{ ts: 1, n: 1 },
			{ ts: 1, n: 1 },
			{ ts: 1, n: 1 },
		]);
		for (const t of tabs.slice(1)) {
			expect(t.fetched).toEqual([]);
			expect(t.store.get("data")?.requests).toBe(0);
			expect(pollTimers(t)).toEqual([]); // followers schedule no polls
		}
		// the leader's next poll fans out again
		b.advance(1000);
		pollTimers(tabs[0])[0].fn();
		reply(tabs[0], 1, { ts: 2, n: 2 });
		await flush();
		expect(tabs[1].store.get("data")?.data).toEqual({ ts: 2, n: 2 });
	});

	test("a follower on a foreign scope rides one leader shadow feed", async () => {
		const b = browser();
		const leader = b.open({ data: { url: () => "/api/data?project=a" } });
		const f1 = b.open({ data: { url: () => "/api/data?project=b" } });
		const f2 = b.open({ data: { url: () => "/api/data?project=b" } });
		await flush();
		f1.store.kick("data", true);
		f2.store.kick("data", true);
		await flush();
		// lead() loads its own scope; ONE shadow serves both followers (the
		// second want lands while it is busy)
		expect(leader.fetched).toEqual([
			"/api/data?project=a",
			"/api/data?project=b",
		]);
		reply(leader, 1, { ts: 5 });
		await flush();
		expect(f1.store.get("data")?.data).toEqual({ ts: 5 });
		expect(f2.store.get("data")?.data).toEqual({ ts: 5 });
		expect(leader.store.get("data")?.loaded).toBe(false); // own scope pending
		expect(leader.store.names()).toEqual(["data"]); // shadows stay internal
		// a not-yet-due want is not a fetch
		f1.store.kick("data", false);
		await flush();
		expect(leader.fetched.length).toBe(2);
	});

	test("closing the leader hands polling to a follower within one interval", async () => {
		const b = browser();
		const a = b.open({ data: { url: () => "/api/data", everyMs: 2000 } });
		const c = b.open({ data: { url: () => "/api/data", everyMs: 2000 } });
		await flush();
		a.store.kick("data", true);
		c.store.kick("data", true);
		await flush();
		reply(a, 0, { ts: 1 });
		await flush();
		expect(c.store.get("data")?.loaded).toBe(true);
		expect(c.fetched).toEqual([]);
		a.close();
		await flush();
		expect(c.store.role).toBe("leader");
		const t = pollTimers(c);
		expect(t.length).toBe(1);
		expect(t[0].ms).toBeLessThanOrEqual(2000);
		b.advance(t[0].ms);
		t[0].fn();
		expect(c.fetched).toEqual(["/api/data"]);
	});

	test("a follower that missed the payload re-asks with need", async () => {
		const b = browser();
		const a = b.open({ data: { url: () => "/api/data" } });
		const c = b.open({ data: { url: () => "/api/data" } });
		await flush();
		a.store.kick("data", true);
		await flush();
		reply(a, 0, { ts: 9 });
		await flush();
		// c never asked, so the leader posted nothing (no peers yet)
		expect(c.store.get("data")?.loaded).toBe(false);
		c.store.kick("data", true); // need=true: answered from the cache
		await flush();
		expect(a.fetched.length).toBe(1);
		expect(c.store.get("data")?.data).toEqual({ ts: 9 });
	});

	test("no Web Locks or channel = solo; the store polls as before", () => {
		const s = new FeedStore({
			fetch: () => new Promise(() => {}) as Promise<Response>,
			setTimer: null,
			clearTimer: null,
			hidden: () => false,
		});
		s.define("data", { url: () => "/api/data" });
		s.share({ locks: null, channel: null });
		expect(s.role).toBe("solo");
		s.kick("data");
		expect(s.get("data")?.requests).toBe(1);
	});
});
