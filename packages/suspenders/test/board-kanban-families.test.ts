// test/board-kanban-families.test.ts — W819: the lanes kanban groups shattered
// families — non-terminal children render directly beneath the parent card
// (dashed border in the parent's --prefer color) instead of as scattered
// state-column siblings. Pure client pieces (kanbanFamIndex/kanbanFamilies/
// kanbanCard) eval from the shipped TASKS chunk bytes with core helpers
// injected; page-level asserts cover the kkid CSS.
import { describe, expect, test } from "bun:test";
import { HTML } from "../hooks/bin/fleet-board-html.ts";
import { TASKS } from "../hooks/board-html/tasks.ts";

type Item = Record<string, unknown>;

// mirrors of the shared chunk helpers (core.ts) — passed INTO the sandbox so
// no helper source is quoted inside this file (the established idiom:
// board-prefer.test.ts, board-splines.test.ts)
const esc = (s: unknown): string =>
	String(s ?? "").replace(
		/[&<>"']/g,
		(c) =>
			(
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				}) as Record<string, string>
			)[c],
	);

const taskPill = (state: unknown): string =>
	`<span class="pill ${String(state).toLowerCase()}">${esc(state)}</span>`;
const agoShort = (s: unknown): string => `${s || 0}s`;

function chunkSandbox(): {
	kanbanFamilies: (pool: Item[]) => {
		nested: Record<string, { a: string; d: number; c: string }>;
		under: Record<string, Item[]>;
	};
	kanbanCard: (t: Item, fam?: unknown) => string;
	displayState: (t: Item) => string;
} {
	const fn = new Function(
		"esc",
		"taskPill",
		"agoShort",
		"laneStamp",
		"window",
		`${TASKS}\nreturn { kanbanFamilies, kanbanCard, displayState };`,
	);
	return fn(esc, taskPill, agoShort, (s: string) => s, {
		__execPrefs: [],
		addEventListener: () => {},
	});
}

const P = "/r/.git";
const sh = (id: string, age: number): Item => ({
	project: P,
	id,
	state: "SHATTERED",
	age_s: age,
});

describe("board kanban shattered families (W819)", () => {
	test("READY task with unmet dependency displays BLOCKED and cannot start", () => {
		const { displayState, kanbanCard } = chunkSandbox();
		const gated = {
			project: P,
			id: "W539.1",
			title: "pilot",
			state: "READY",
			blocked_by: ["W459"],
		};
		expect(displayState(gated)).toBe("BLOCKED");
		expect(kanbanCard(gated)).toContain("waiting on W459");
		expect(kanbanCard(gated)).not.toContain('data-start="W539.1"');
		expect(displayState({ ...gated, blocked_by: [] })).toBe("READY");
	});
	test("FAILED task shows its recorded failure note safely", () => {
		const { kanbanCard } = chunkSandbox();
		const html = kanbanCard({
			project: P,
			id: "W843",
			title: "usage budget",
			state: "FAILED",
			failure_note: "resume budget exhausted <script>alert(1)</script>",
			tail: { text: "belt: no_route — upstream returned 401" },
		});
		expect(html).toContain('class="kfailure"');
		expect(html).toContain("resume budget exhausted &lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain("upstream returned 401");
	});
	test("card puts status and date above item ID and age, with plain model text", () => {
		const { kanbanCard } = chunkSandbox();
		const html = kanbanCard({
			project: P,
			id: "W934.2.2",
			title: "consult benchmark",
			state: "FAILED",
			age_s: 240,
			updated_at_utc: "2026-10-20T08:32:04.182Z",
			model: "claude-sonnet-5",
			origin: "Muramasa.localdomain:claude",
			failure_note:
				"resume budget exhausted after 3 launches; inspect the lane",
		});
		expect(html.indexOf('class="krow"')).toBeLessThan(
			html.indexOf('class="kcardident"'),
		);
		expect(html).toContain('class="kmodel"');
		expect(html).not.toContain('class="kmodel loc"');
		expect(html).toContain("resume budget exhausted after 3 launches");
		expect(html).not.toContain("inspect the lane");
	});
	test("non-terminal child nests under resident SHATTERED parent with parent color + depth", () => {
		const { kanbanFamilies } = chunkSandbox();
		const parent = { ...sh("W1", 9), tag_color: "#0058A3" };
		const kid = { project: P, id: "W1.1", state: "READY", age_s: 1 };
		const fam = kanbanFamilies([parent, kid]);
		expect(fam.nested["W1.1"]).toEqual({ a: "W1", d: 1, c: "#0058A3" });
		expect(fam.under.W1).toEqual([kid]);
	});

	test("terminal children stay in their state columns", () => {
		const { kanbanFamilies } = chunkSandbox();
		const parent = sh("W1", 9);
		const done = { project: P, id: "W1.1", state: "DONE", age_s: 1 };
		const fam = kanbanFamilies([parent, done]);
		expect(fam.nested["W1.1"]).toBeUndefined();
		expect(fam.under.W1).toBeUndefined();
	});

	test("child whose parent is absent from the pool stays put", () => {
		const { kanbanFamilies } = chunkSandbox();
		const orphan = { project: P, id: "W7.3", state: "READY", age_s: 1 };
		const fam = kanbanFamilies([orphan]);
		expect(fam.nested["W7.3"]).toBeUndefined();
	});

	test("parent not SHATTERED — child stays put (only SHATTERED anchors)", () => {
		const { kanbanFamilies } = chunkSandbox();
		const claimed = { project: P, id: "W2", state: "CLAIMED", age_s: 9 };
		const kid = { project: P, id: "W2.1", state: "READY", age_s: 1 };
		const fam = kanbanFamilies([claimed, kid]);
		expect(fam.nested["W2.1"]).toBeUndefined();
	});

	test("grandchild follows its parent in the depth-first subtree", () => {
		const { kanbanFamilies } = chunkSandbox();
		const parent = sh("W1", 9);
		const a = { project: P, id: "W1.1", state: "FAILED", age_s: 5 };
		const b = { project: P, id: "W1.2", state: "READY", age_s: 2 };
		const g = { project: P, id: "W1.2.1", state: "READY", age_s: 9 };
		const fam = kanbanFamilies([parent, a, b, g]);
		expect(fam.under.W1?.map((t) => t.id)).toEqual(["W1.2", "W1.2.1", "W1.1"]);
		expect(fam.nested["W1.2.1"]).toEqual({ a: "W1", d: 2, c: "" });
	});

	test("shattered child of a shattered parent nests too", () => {
		const { kanbanFamilies } = chunkSandbox();
		const parent = sh("W1", 9);
		const mid = sh("W1.1", 5);
		const leaf = { project: P, id: "W1.1.1", state: "READY", age_s: 1 };
		const fam = kanbanFamilies([parent, mid, leaf]);
		expect(fam.nested["W1.1"]).toEqual({ a: "W1", d: 1, c: "" });
		expect(fam.nested["W1.1.1"]).toEqual({ a: "W1", d: 2, c: "" });
		expect(fam.under.W1?.map((t) => t.id)).toEqual(["W1.1", "W1.1.1"]);
	});

	test("kanbanCard kid: kkid class + parent --prefer + kidmark; non-kid bytes unchanged", () => {
		const { kanbanCard, kanbanFamilies } = chunkSandbox();
		const parent = { ...sh("W1", 9), tag_color: "#0058A3" };
		const kid = { project: P, id: "W1.1", state: "READY", age_s: 1 };
		const fam = kanbanFamilies([parent, kid]);
		const card = kanbanCard(kid, fam);
		expect(card).toContain(
			'<div class="kcard kkid" style="--prefer:#0058A3;margin-left:14px" data-kid="W1.1"',
		);
		expect(card).toContain('<span class="kidmark">↳</span>');
		// non-kid path keeps the W812 byte contract
		expect(kanbanCard(parent, fam)).toContain(
			'<div class="kcard" style="--prefer:#0058A3" data-kid="W1"',
		);
		// depth indent caps at two levels
		const grand = { project: P, id: "W1.1.1", state: "READY", age_s: 1 };
		const fam2 = kanbanFamilies([parent, kid, grand]);
		expect(kanbanCard(grand, fam2)).toContain("margin-left:28px");
	});

	test("kid style passes esc() — hostile color cannot break out", () => {
		const { kanbanCard, kanbanFamilies } = chunkSandbox();
		const parent = { ...sh("W1", 9), tag_color: '#000"><script>' };
		const kid = { project: P, id: "W1.1", state: "READY", age_s: 1 };
		const fam = kanbanFamilies([parent, kid]);
		const card = kanbanCard(kid, fam);
		expect(card).not.toContain('"><script>');
		expect(card).toContain("&quot;&gt;&lt;script&gt;");
	});

	test("page CSS: kkid rides a dashed border", () => {
		expect(HTML).toContain(
			".kcard.kkid { border-style:dashed; position:relative; }",
		);
	});
});
