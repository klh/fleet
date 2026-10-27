// test/board-spend-cells.test.ts — W776: the board's tasks table + kanban
// cards render per-item attribution (spend.fresh/cached/out + wall_ms) from
// the /api/tasks feed. Functional tests eval the shipped TASKS chunk bytes
// with the shared chunk helpers injected (board-prefer.test.ts pattern);
// the payload side is covered live (itemAttribution in lane-spend.test.ts).
import { describe, expect, test } from "bun:test";
import { TASKS } from "../hooks/board-html/tasks.ts";
import { CORE } from "../hooks/board-html/core.ts";

// mirrors of the shared chunk helpers (core.ts) — passed INTO the sandbox so
// no helper source is quoted inside this file
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
// W998: ago/agoShort/msAgo now eval from the CORE chunk bytes (the workTone
// idiom) — kanbanCard's compact stamp rides them, so mirrors would drift.
const coreFn = (name: string) =>
	new Function(`${CORE}\nreturn ${name};`)() as (...args: unknown[]) => unknown;
const agoShort = coreFn("agoShort") as (s: unknown) => string;
const ago = coreFn("ago") as (s: unknown) => string;
const msAgo = coreFn("msAgo") as (ts: number) => number;
const workTone = coreFn("workTone") as (state: string) => string;

type Item = Record<string, unknown>;

function chunkSandbox(): {
	taskRow: (t: Item, parentId?: string | null) => string;
	taskTreeHtml: (pool: Item[]) => string;
	kanbanCard: (t: Item) => string;
	laneStamp: (s: string) => string;
} {
	const fn = new Function(
		"esc",
		"taskPill",
		"agoShort",
		"ago",
		"workTone",
		"msAgo",
		"window",
		`${TASKS}\nreturn { taskRow, taskTreeHtml, kanbanCard, laneStamp };`,
	);
	return fn(esc, taskPill, agoShort, ago, workTone, msAgo, {
		__execPrefs: [],
		addEventListener: () => {},
	});
}

const SPEND = {
	fresh: 138_593,
	cached: 30_000,
	out: 45_880,
	requests: 172,
	wall_ms: 8_562_294,
	agent_ms: 4_000_000,
	model_groups: {},
};

describe("board spend cells (W776)", () => {
	test("taskRow: tok + wall cells render when spend rides the feed", () => {
		const { taskRow } = chunkSandbox();
		const row = taskRow({ ...IKEA_ROW, spend: SPEND }, null);
		// W887: the tok cell carries the micro-strip as its tooltip
		expect(row).toContain(
			'<td class="num" title="2h23m · 322 tok/m · 18% cache">214k</td>',
		); // 138593+30000+45880
		expect(row).toContain('<td class="num">2h23m</td>');
	});

	test("taskRow: no spend → '-' cells, never fabricated numbers", () => {
		const { taskRow } = chunkSandbox();
		const row = taskRow(IKEA_ROW, null);
		expect(row).toContain('<td class="num">-</td>');
		expect(row).not.toContain("kspend");
	});

	test("kanbanCard: kspend line when spend rides the feed", () => {
		const { kanbanCard } = chunkSandbox();
		const card = kanbanCard({ ...IKEA_ROW, spend: SPEND });
		expect(card).toContain("kspend");
		expect(card).toContain("214k tok · 2h23m");
	});

	test("kanbanCard: micro-strip carries spark placeholder + strip text (W887)", () => {
		const { kanbanCard } = chunkSandbox();
		const card = kanbanCard({ ...IKEA_ROW, spend: SPEND });
		expect(card).toContain("kspark");
		expect(card).toContain('data-spark="|W9"');
		expect(card).toContain("322 tok/m");
		expect(card).toContain("18% cache");
	});

	test("taskRow: strip text rides the tok cell tooltip (W887)", () => {
		const { taskRow } = chunkSandbox();
		const row = taskRow({ ...IKEA_ROW, spend: SPEND }, null);
		expect(row).toContain("322 tok/m · 18% cache");
	});

	test("lane timestamps ride the shared dual-stamp vocabulary (W902)", () => {
		const { laneStamp, kanbanCard } = chunkSandbox();
		const stamp = laneStamp("2026-10-19T15:44:54Z");
		expect(stamp).toMatch(
			/<time datetime="2026-10-19T15:44:54\.000Z" title="2026-10-19T15:44:54Z \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\)">10-19T15:44:54Z \(\d{2}:\d{2} local\)<\/time>/,
		);
		// the kanban CARD swaps the wide DD.MM.YY HH:MM stamp for a relative
		// age; the full instant survives on the <time> title
		const card = kanbanCard({
			...IKEA_ROW,
			updated_at_utc: new Date(Date.now() - 3 * 3_600_000).toISOString(),
		});
		expect(card).toMatch(
			/<span class="kcardstamp dim"><time datetime="[^"]+" title="updated [^"]+ · UTC [^"]+">3h<\/time><\/span>/,
		);
		expect(card).not.toMatch(/\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}/);
	});

	test("card age keeps its open-age label with the update stamp separate (W998)", () => {
		const { kanbanCard } = chunkSandbox();
		const card = kanbanCard({
			...IKEA_ROW,
			updated_at_utc: new Date(Date.now() - 3_600_000).toISOString(),
		});
		expect(card).toContain('title="open 10s ago">10s</span>');
	});

	test("Tasks keeps deep children under their own project parent", () => {
		const { taskTreeHtml } = chunkSandbox();
		const base = { title: "test", state: "SHATTERED", age_s: 60 };
		const html = taskTreeHtml([
			{ ...base, project: "p2", id: "W934" },
			{ ...base, project: "p1", id: "W934.2.2", parent_id: "W934.2" },
			{ ...base, project: "p1", id: "W934" },
			{ ...base, project: "p1", id: "W934.2", parent_id: "W934" },
		]);
		const p1 = html.indexOf('data-proj="p1"');
		const child = html.indexOf('data-task="W934.2"');
		const grandchild = html.indexOf('data-task="W934.2.2"');
		expect(p1).toBeGreaterThan(-1);
		expect(child).toBeGreaterThan(p1);
		expect(grandchild).toBeGreaterThan(child);
		expect(html).toContain("--indent:24px");
	});

	test("request histogram starts left and advances in three-minute bins", () => {
		type Node = {
			tag: string;
			attrs: Record<string, string>;
			children: Node[];
			textContent: string;
			setAttribute: (key: string, value: string) => void;
			appendChild: (node: Node) => void;
			addEventListener: (
				event: string,
				listener: (event: unknown) => void,
			) => void;
		};
		const createElementNS = (_ns: string, tag: string): Node => ({
			tag,
			attrs: {},
			children: [],
			textContent: "",
			setAttribute(key, value) {
				this.attrs[key] = value;
			},
			appendChild(node) {
				this.children.push(node);
			},
			addEventListener() {},
		});
		const fn = new Function("document", "window", `${TASKS}\nreturn sparkSvg;`);
		const sparkSvg = fn(
			{ createElementNS },
			{ addEventListener: () => {} },
		) as (points: number[][], w: number, h: number) => Node;
		const thisMinute = Math.floor(Date.now() / 60_000) * 60_000;
		const chart = sparkSvg(
			[
				[thisMinute - 4 * 60_000, 30, 70, 12],
				[thisMinute, 100, 0, 20],
			],
			180,
			28,
		);
		const bars = chart.children.filter((node) => node.tag === "rect");
		expect(bars).toHaveLength(3);
		expect(bars.map((bar) => bar.attrs.class)).toEqual([
			"spark-fresh",
			"spark-cached",
			"spark-fresh",
		]);
		expect(bars[0].attrs["data-fresh"]).toBe("30");
		expect(bars[0].attrs["data-cached"]).toBe("70");
		expect(bars[0].attrs["data-out"]).toBe("12");
		const positions = [...new Set(bars.map((bar) => Number(bar.attrs.x)))];
		expect(positions).toHaveLength(2);
		expect(positions[0]).toBeLessThan(5);
		expect(positions[1] - positions[0]).toBeGreaterThan(5);
		expect(chart.children.some((node) => node.tag === "polyline")).toBe(false);
		expect(
			sparkSvg([[thisMinute - 100 * 60_000, 100, 0, 0]], 180, 28).children,
		).toHaveLength(1);
	});

	test("hovering a spend bar shows the bucket's values in a compact overlay", () => {
		const elements = new Map<string, Record<string, unknown>>();
		const doc = {
			createElement: () => ({
				style: {},
				offsetWidth: 120,
				offsetHeight: 70,
				setAttribute() {},
			}),
			body: {
				appendChild(node: Record<string, unknown>) {
					elements.set(String(node.id), node);
				},
			},
		};
		const fn = new Function(
			"document",
			"window",
			"byId",
			`${TASKS}\nreturn showSparkTip;`,
		);
		const show = fn(
			doc,
			{ innerWidth: 300, addEventListener() {} },
			(id: string) => elements.get(id),
		) as (
			event: { clientX: number; clientY: number },
			bar: { getAttribute: (name: string) => string },
		) => void;
		const values: Record<string, string> = {
			"data-at": String(new Date(2026, 9, 20, 10, 30).getTime()),
			"data-minutes": "3",
			"data-fresh": "30",
			"data-cached": "70",
			"data-out": "12",
		};
		show(
			{ clientX: 295, clientY: 100 },
			{ getAttribute: (name) => values[name] },
		);
		const tip = elements.get("ksparkTip");
		expect(tip?.textContent).toContain("Fresh input  30");
		expect(tip?.textContent).toContain("Cached input  70");
		expect(tip?.textContent).toContain("Output  12");
		expect(tip?.hidden).toBe(false);
		const left = (tip?.style as { left: string } | undefined)?.left;
		expect(Number.parseInt(String(left), 10)).toBeLessThan(180);
	});

	test("drawer failure detail renders the full note while the card keeps its compact first segment (W998)", () => {
		// drawer path never slices the note (unclamped .failure-detail p,
		// scrollable drawer); the card path keeps split(';')[0]
		expect(TASKS).toContain("esc(String(t.failure_note))");
		expect(TASKS).toContain(".split(';')[0]");
	});
});

const IKEA_ROW = {
	id: "W9",
	title: "ikea item",
	state: "CLAIMED",
	owner_sid: "s1",
	age_s: 10,
};
