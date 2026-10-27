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

// W1203: sparklines derive bins + time window from the MEASURED track.
describe("measured-width spark windows (W1203)", () => {
	type SparkNode = {
		tag: string;
		attrs: Record<string, string>;
		children: SparkNode[];
		setAttribute: (key: string, value: string) => void;
		appendChild: (node: SparkNode) => void;
		addEventListener: () => void;
	};
	const createElementNS = (_ns: string, tag: string): SparkNode => ({
		tag,
		attrs: {},
		children: [],
		setAttribute(key, value) {
			this.attrs[key] = String(value);
		},
		getAttribute(key: string) {
			return key in this.attrs ? this.attrs[key] : null;
		},
		appendChild(node) {
			this.children.push(node);
		},
		addEventListener() {},
	});
	const evalSpark = <T>(expr: string, extra: Record<string, unknown> = {}): T =>
		new Function(
			"document",
			"window",
			...Object.keys(extra),
			`${TASKS}\nreturn ${expr};`,
		)(
			{ createElementNS },
			{ __execPrefs: [], addEventListener: () => {} },
			...Object.values(extra),
		) as T;
	const paintHarness = () => {
		const axis = {
			style: {} as Record<string, string>,
			firstElementChild: { textContent: "" },
			lastElementChild: { textContent: "" },
		};
		const painted: SparkNode[] = [];
		const attrs: Record<string, string> = { "data-spark": "p\u0000W9" };
		let track = 180;
		const el = {
			getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
			setAttribute: (n: string, v: string) => {
				attrs[n] = v;
			},
			get clientWidth() {
				return track;
			},
			closest: () => null,
			contains: () => false,
			get firstChild(): null {
				return null;
			},
			appendChild: (n: SparkNode) => {
				painted.push(n);
			},
			parentElement: {
				querySelector: (s: string) => (s === ".ksparkaxis" ? axis : null),
			},
		};
		const root = {
			querySelectorAll: (s: string) => (s === ".kspark" ? [el] : []),
		};
		const faces = evalSpark<{
			paintSparks: (r: unknown) => void;
			spendSeries: Record<string, number[][]>;
		}>("({ paintSparks, spendSeries })", { byId: () => null });
		faces.spendSeries["p\u0000W9"] = [
			[Date.now() - 90 * 60_000, 10, 0, 0],
			[Date.now(), 0, 5, 1],
		];
		return {
			paint: faces.paintSparks,
			root,
			axis,
			painted,
			setTrack: (w: number) => {
				track = w;
			},
		};
	};

	test("window length derives from the measured width: wider track, longer window", () => {
		const sparkSvg =
			evalSpark<(p: number[][], w: number, h: number) => SparkNode>("sparkSvg");
		const last = Date.now();
		const narrow = sparkSvg(
			[
				[last - 60 * 60_000, 100, 0, 0],
				[last - 30 * 60_000, 30, 0, 0],
				[last, 0, 40, 10],
			],
			180,
			28,
		); // 60m span < 90m window → left-aligned short data
		const wide = sparkSvg(
			[
				[last - 240 * 60_000, 100, 0, 0],
				[last - 179 * 60_000, 20, 0, 0], // first in-window point → bin 0
				[last - 30 * 60_000, 30, 0, 0],
				[last, 0, 40, 10],
			],
			360,
			28,
		); // 240m span > 180m window → end-pinned
		expect(narrow.attrs["data-bin-min"]).toBe("3");
		expect(wide.attrs["data-bin-min"]).toBe("3");
		// the first bar's data-at IS the window start — wider track, more history
		const nb = narrow.children.filter((n) => n.tag === "rect");
		const wb = wide.children.filter((n) => n.tag === "rect");
		// narrow track left-aligns the short span (start = first point);
		// wide track end-pins the 180m window (start = last − window)
		expect(Number(nb[0].attrs["data-at"])).toBe(last - 60 * 60_000);
		expect(Number(wb[0].attrs["data-at"])).toBe(last - 180 * 60_000);
		expect(narrow.attrs["data-window-end"]).toBe(String(last + 30 * 60_000));
		expect(wide.attrs["data-window-end"]).toBe(String(last));
		expect(wide.attrs.width).toBe("360");
		expect(wide.attrs.viewBox).toBe("0 0 360 28");
	});

	test("the newest point rides the last bin when the span divides the window", () => {
		const sparkSvg =
			evalSpark<(p: number[][], w: number, h: number) => SparkNode>("sparkSvg");
		const t0 = Date.now() - 90 * 60_000;
		const pts: number[][] = [
			[t0, 10, 0, 0],
			[t0 + 90 * 60_000, 0, 5, 1],
		];
		const chart = sparkSvg(pts, 180, 28); // 30 bins × 3m = the 90m span
		const bars = chart.children.filter((n) => n.tag === "rect");
		expect(bars).toHaveLength(2);
		// unclamped slot 30 would drop the newest point (pre-W1203 behavior)
		expect(bars[1].attrs.x).toBe("175.0"); // 29×6 + (6−4)/2
		expect(chart.attrs["data-window-end"]).toBe(String(t0 + 90 * 60_000));
	});

	test("bars keep a fixed pixel width at every track width", () => {
		const sparkSvg =
			evalSpark<(p: number[][], w: number, h: number) => SparkNode>("sparkSvg");
		const t0 = Date.now() - 16 * 60 * 60_000;
		const pts: number[][] = [
			[t0, 100, 0, 0],
			[t0 + 8 * 60 * 60_000, 30, 0, 0],
			[t0 + 16 * 60 * 60_000, 0, 40, 10],
		];
		for (const w of [180, 224, 360]) {
			const chart = sparkSvg(pts, w, 28);
			const bars = chart.children.filter((n) => n.tag === "rect");
			expect(bars.length).toBeGreaterThan(0);
			for (const bar of bars) expect(bar.attrs.width).toBe("4.0");
		}
	});

	test("a track narrower than one bin paints nothing", () => {
		const sparkSvg =
			evalSpark<(p: number[][], w: number, h: number) => SparkNode>("sparkSvg");
		const t0 = Date.now() - 90 * 60_000;
		const chart = sparkSvg([[t0, 10, 0, 0]], 3, 28);
		expect(chart.children).toHaveLength(0);
		expect(chart.attrs.width).toBe("3");
	});

	test("pre-window points drop instead of piling into the first bin", () => {
		const sparkSvg =
			evalSpark<(p: number[][], w: number, h: number) => SparkNode>("sparkSvg");
		const last = Date.now();
		const pts: number[][] = [
			[last - 8 * 60 * 60_000, 900, 0, 0], // 8h-old spike
			[last - 60_000, 10, 5, 1],
		];
		const chart = sparkSvg(pts, 180, 28); // window = the newest 90m
		const bars = chart.children.filter((n) => n.tag === "rect");
		expect(bars).toHaveLength(2); // one bin: fresh + cached rects
		expect(bars[0].attrs["data-fresh"]).toBe("10"); // the spike never lands
		expect(bars[0].attrs.x).toBe("175.0"); // and the newest hugs the right edge
	});

	test("paintSparks sizes to the measured track and labels the window", () => {
		const h = paintHarness();
		h.paint(h.root);
		expect(h.painted).toHaveLength(1);
		expect(h.painted[0].attrs.width).toBe("180");
		expect(h.axis.style.display).toBe("flex");
		expect(h.axis.firstElementChild.textContent).toMatch(/\d/);
		expect(h.axis.lastElementChild.textContent).toMatch(/m\/bin$/);
	});

	test("a narrow track repaint hides the sparkline and drops the axis", () => {
		const h = paintHarness();
		h.paint(h.root); // paints at the 180px stub track
		h.setTrack(3);
		h.paint(h.root); // width rides the sig — the resize pass hides instead
		expect(h.painted).toHaveLength(1); // no second chart
		expect(h.axis.style.display).toBe("none");
	});
});

const IKEA_ROW = {
	id: "W9",
	title: "ikea item",
	state: "CLAIMED",
	owner_sid: "s1",
	age_s: 10,
};
