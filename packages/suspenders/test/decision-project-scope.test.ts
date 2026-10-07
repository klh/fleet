import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createContext, runInContext } from "node:vm";
import { CORE } from "../hooks/board-html/core.ts";
import { DECISIONS } from "../hooks/board-html/decisions.ts";
import { HISTORY } from "../hooks/board-html/history.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const fixture = await boardFixture(0, afterAll);
const a = "/projects/selected/.git";
const b = "/projects/other/.git";
const db = new Database(`${fixture.HOME}/.cache/claude-governor/governor.db`);
afterAll(() => db.close());
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

describe("decision API project scope", () => {
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
	test("default and explicit all retain the global feed", async () => {
		const global = await feed();
		const all = await feed("?project=all");
		expect(global.count).toBe(200);
		expect(all.decisions.map((d) => d.id)).toEqual(
			global.decisions.map((d) => d.id),
		);
	});
});

function client() {
	const pending: { url: string; resolve: (response: unknown) => void }[] = [];
	const context = {
		sel: { value: a },
		AbortSignal,
		Date,
		encodeURIComponent,
		decBusy: false,
		histBusy: false,
		histOpen: true,
		curTab: "decisions",
		lastDec: null,
		histData: null,
		decLoaded: false,
		histLoaded: false,
		decErr: null,
		histErr: null,
		decOkAt: 0,
		histOkAt: 0,
		fetch: (url: string) =>
			new Promise((resolve) => pending.push({ url, resolve })),
	};
	createContext(context);
	runInContext(CORE + DECISIONS + HISTORY, context);
	runInContext(
		"renderAll = function() {}; renderHist = function() {}; noteProjects = function() {}; noteNew = function() {};",
		context,
	);
	Object.assign(context, {
		renderAll() {},
		renderHist() {},
		noteProjects() {},
		noteNew() {},
	});
	return {
		context: context as typeof context &
			Record<string, (...args: unknown[]) => unknown>,
		pending,
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("decision client project scope", () => {
	test("history renders only the selected project's archived rows and count", () => {
		const { context } = client();
		const elements = Object.fromEntries(
			["histState", "histErr", "histBody"].map((id) => [
				id,
				{ textContent: "", rendered: "" },
			]),
		);
		Object.assign(context, {
			document: { getElementById: (id: string) => elements[id] },
			histLoaded: true,
			histData: {
				decisions: [
					{ project: a, state: "ANSWERED", question: "selected answer" },
					{ project: b, state: "ANSWERED", question: "foreign answer" },
				],
			},
		});
		runInContext(
			HISTORY +
				"clearErr = function() {}; sigSet = function(el, sig, html) { el.rendered = html; }; renderHist();",
			context,
		);
		expect(elements.histState.textContent).toBe("1 archived");
		expect(elements.histBody.rendered).toContain("selected answer");
		expect(elements.histBody.rendered).not.toContain("foreign answer");
	});
	test("cards and selected lookup exclude foreign and archived decisions", () => {
		const { context } = client();
		Object.assign(context, {
			lastDec: {
				decisions: [
					{ id: 1, project: a, state: "OPEN" },
					{ id: 2, project: b, state: "OPEN" },
					{ id: 3, project: a, state: "ANSWERED" },
				],
			},
		});
		expect(context.openDecs()).toHaveLength(1);
		expect(context.decById(2)).toBeNull();
		context.sel.value = "all";
		expect(context.openDecs()).toHaveLength(2);
	});
	for (const [poll, field] of [
		["pollDec", "lastDec"],
		["pollHist", "histData"],
	]) {
		test(`${poll} discards old project response and immediately fetches current scope`, async () => {
			const { context, pending } = client();
			context[poll]();
			context.sel.value = b;
			pending[0].resolve({
				ok: true,
				json: async () => ({ ts: 1, decisions: [{ project: a }] }),
			});
			await flush();
			expect(context[field]).toBeNull();
			expect(pending).toHaveLength(2);
			expect(pending[1].url).toContain(encodeURIComponent(b));
			pending[1].resolve({
				ok: true,
				json: async () => ({ ts: 2, decisions: [{ project: b }] }),
			});
			await flush();
			expect(context[field]).toEqual({ ts: 2, decisions: [{ project: b }] });
		});
	}
});
