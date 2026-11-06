import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import { FeedStore } from "../hooks/board-html/feed-store.ts";
import {
	histUrlOf,
	projQueryOf,
} from "../hooks/board-html/klh-decisions-mediator.ts";
import {
	KlhDecisions,
	type DecisionRow,
	type DecisionsSlice,
	type HistoryRow,
} from "../hooks/board-html/klh-decisions.ts";
import {
	DataFeedSchema,
	DecisionsFeedSchema,
	SpendSeriesFeedSchema,
	TasksFeedSchema,
} from "../hooks/board-html/feed-schemas.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const fixture = await boardFixture(0, test.afterAll);
const a = "/projects/selected/.git";
const b = "/projects/other/.git";
const db = new Database(`${fixture.HOME}/.cache/claude-governor/governor.db`);
test.afterAll(() => db.close());
db.transaction(() => {
	for (let i = 0; i < 207; i++) {
		const project = i < 2 ? a : b;
		const state = i === 1 ? "ANSWERED" : "OPEN";
		const event = db
			.query(
				"INSERT INTO events (ts, source, kind, payload) VALUES (?, 'scope-test', 'BROADCAST', '{}')",
			)
			.run(Date.now());
		db.query(
			"INSERT INTO decisions (event_id, target, asked_by, project, question, state, created_at) VALUES (?, 'scope-test', 'scope-test', ?, ?, ?, ?)",
		).run(
			event.lastInsertRowid,
			project,
			`${project} question ${i}`,
			state,
			Date.now(),
		);
	}
})();

async function feed(query = "") {
	const response = await fetch(`${fixture.BASE}/api/decisions${query}`);
	expect(response.ok).toBe(true);
	return response.json();
}

test.describe("decision API project scope", () => {
	test("filters before the global row limit and scopes counts", async () => {
		const data = await feed(`?project=${encodeURIComponent(a)}`);
		expect(data.count).toBe(1);
		expect(data.byProject).toEqual({ [a]: 1 });
		expect(data.decisions).toHaveLength(1);
		expect(data.decisions[0].project).toBe(a);
	});
	test("history shares scope and unknown scope is empty", async () => {
		const data = await feed(`?history=1&project=${encodeURIComponent(a)}`);
		expect(data.decisions.map((d) => d.state).sort()).toEqual([
			"ANSWERED",
			"OPEN",
		]);
		expect(data.decisions.every((d) => d.project === a)).toBe(true);
		const empty = await feed("?project=unknown&history=1");
		expect(empty.count).toBe(0);
		expect(empty.byProject).toEqual({});
		expect(empty.decisions).toEqual([]);
	});
	test("polled feeds satisfy the shared zod contracts and answer If-None-Match", async () => {
		for (const [path, schema] of [
			["/api/data", DataFeedSchema],
			["/api/decisions", DecisionsFeedSchema],
			["/api/tasks", TasksFeedSchema],
			["/api/spend-series", SpendSeriesFeedSchema],
		] as const) {
			const first = await fetch(`${fixture.BASE}${path}`);
			const etag = first.headers.get("etag") ?? "";
			expect(etag).toMatch(/^W\//);
			expect(schema.safeParse(await first.json()).success).toBe(true);
			const again = await fetch(`${fixture.BASE}${path}`, {
				headers: { "if-none-match": etag },
			});
			// 304 while the slice is unchanged; a moved slice re-sends a body
			if (again.status !== 304) {
				expect(again.status).toBe(200);
				expect(again.headers.get("etag")).not.toBe(etag);
			}
			await again.arrayBuffer();
		}
	});
	test("default and explicit all retain the global feed", async () => {
		const global = await feed();
		const all = await feed("?project=all");
		expect(global.count).toBe(200);
		expect(all.decisions.map((d) => d.id)).toEqual(
			global.decisions.map((d) => d.id),
		);
	});
});

/** The leaf's private slice-driven filters (light-DOM Lit, no DOM needed
 * for the pure row logic — Lit defers DOM access until connect). */
type LeafP = {
	slice: DecisionsSlice;
	openDecs(): DecisionRow[];
	byId(id: string): DecisionRow | null;
	histRows(): HistoryRow[];
};
const leaf = (): LeafP => new KlhDecisions() as unknown as LeafP;

/** /api/decisions payload shape guard (the feed schema gates the wire). */
const decAcceptStub = (j: unknown): void => {
	if (
		!j ||
		typeof (j as { ts?: unknown }).ts !== "number" ||
		!Array.isArray((j as { decisions?: unknown }).decisions)
	)
		throw new Error("bad payload");
};

/** A resolved dec response for the stubbed fetch. */
const decResponse = (ts: number, project: string): unknown => ({
	ok: true,
	status: 200,
	headers: new Headers(),
	json: async () => ({ ts, decisions: [{ project }] }),
});

test.describe("decision client project scope", () => {
	test("history keeps only the selected project's archived rows", () => {
		const el = leaf();
		el.slice = {
			...el.slice,
			project: a,
			hist: {
				loaded: true,
				err: null,
				okAt: Date.now(),
				data: {
					decisions: [
						{ project: a, state: "ANSWERED", question: "selected answer" },
						{ project: b, state: "ANSWERED", question: "foreign answer" },
					],
				},
			},
		};
		const rows = el.histRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.question).toBe("selected answer");
	});
	test("cards and selected lookup exclude foreign and archived decisions", () => {
		const el = leaf();
		el.slice = {
			...el.slice,
			project: a,
			dec: {
				loaded: true,
				err: null,
				okAt: Date.now(),
				data: {
					decisions: [
						{ id: "1", project: a, state: "OPEN" },
						{ id: "2", project: b, state: "OPEN" },
						{ id: "3", project: a, state: "ANSWERED" },
					],
				},
			},
		};
		expect(el.openDecs()).toHaveLength(1);
		expect(el.byId("2")).toBeNull();
		el.slice.project = "all";
		expect(el.openDecs()).toHaveLength(2);
	});
	test("feed URLs re-scope with the project and splice history correctly", () => {
		// the FeedStore's own scope-discard (stale cross-project responses
		// dropped, current scope re-fetched) is pinned in
		// work-completion-cross-repo.test.ts; these pins hold the dec/hist
		// URL contract the old projQuery/history url() owned
		expect(projQueryOf(a)).toBe(`?project=${encodeURIComponent(a)}`);
		expect(projQueryOf("all")).toBe("");
		expect(projQueryOf("")).toBe("");
		expect(histUrlOf(a, true)).toBe(
			`/api/decisions?project=${encodeURIComponent(a)}&history=1`,
		);
		expect(histUrlOf("all", true)).toBe("/api/decisions?history=1");
		expect(histUrlOf(a, false)).toBe("");
	});
	test("pollDec discards old project response and immediately fetches current scope", async () => {
		// the chunk's poll fns are gone: their scope contract lives in the
		// FeedStore the mediator binds — settle() under a moved scope drops
		// the stale answer and re-requests the current one
		const pending: { url: string; resolve: (r: unknown) => void }[] = [];
		let scope = a;
		const store = new FeedStore({
			fetch: (url: string) =>
				new Promise((resolve) =>
					pending.push({ url, resolve }),
				) as unknown as Promise<Response>,
			setTimer: null,
			clearTimer: null,
			hidden: () => false,
		});
		store.define("dec", {
			url: () => `/api/decisions${projQueryOf(scope)}`,
			accept: decAcceptStub,
		});
		store.kick("dec", true);
		expect(pending[0]?.url).toContain(encodeURIComponent(a));
		scope = b; // project filter moved mid-flight
		pending[0]?.resolve(decResponse(1, a));
		await Bun.sleep(20);
		expect(store.get("dec")?.data).toBeNull();
		expect(pending[1]?.url).toContain(encodeURIComponent(b));
		pending[1]?.resolve(decResponse(2, b));
		await Bun.sleep(20);
		const landed = store.get("dec")?.data as {
			decisions: { project: string }[];
		};
		expect(landed.decisions[0]?.project).toBe(b);
	});
});
