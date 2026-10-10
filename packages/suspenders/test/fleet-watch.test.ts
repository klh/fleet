// test/fleet-watch.test.ts — W522 fleet-watch: the pure layer, hermetic.
// mergeLanes (union of coord-fleet projection + .fleet registry liveness +
// board rows, per-field degradation), selectTasks (active-first order),
// frame building (bounded width/height, ANSI-safe truncation, prefer-color
// dots, glyph vocabulary) and emitFrame's diff contract (first frame full,
// unchanged lines never rewritten, shrink clears the stale bottom).
import { describe, expect, test } from "bun:test";
import { mergeLanes } from "../hooks/lib/watch/sources.ts";
import type {
	BoardTask,
	CoordFleet,
	WorkLane,
} from "../hooks/lib/watch/sources.ts";
import {
	buildFrame,
	emitFrame,
	fmtAge,
	laneGlyph,
	selectTasks,
	stateGlyph,
	truncate,
	visibleLen,
} from "../hooks/lib/watch/frame.ts";

const task = (over: Partial<BoardTask> = {}): BoardTask => ({
	project: "/tmp/proj",
	id: "W1",
	title: "t",
	state: "READY",
	owner_sid: null,
	owner_label: null,
	age_s: 30,
	tag: null,
	tag_color: null,
	model: null,
	locality: null,
	...over,
});

describe("mergeLanes", () => {
	const coord: CoordFleet = {
		head: "abc1234",
		lanes: [
			{ sid: "autow522", name: null, intent: "W522 work", state: "RUNNING" },
			{ sid: "autowX", name: "fred", intent: null, state: "PAUSED" },
		],
	};
	const work: WorkLane[] = [
		{ sid: "autow522", item: "W522", live: true, host: null },
		{ sid: "autowY", item: "W9", live: false, host: "nas" },
	];
	const tasks = [
		task({ id: "W522", state: "CLAIMED", age_s: 180, tag_color: "#0058A3" }),
		task({ id: "W9", state: "RUNNING", age_s: 42 }),
	];

	test("union of feeds, per-field degradation", () => {
		const rows = mergeLanes(coord, work, tasks);
		expect(rows.length).toBe(3);
		const a = rows.find((r) => r.sid === "autow522")!;
		expect(a.live).toBe(true);
		expect(a.item).toBe("W522");
		expect(a.itemState).toBe("CLAIMED");
		expect(a.ageS).toBe(180);
		expect(a.tagColor).toBe("#0058A3");
		expect(a.intent).toBe("W522 work");
		expect(a.state).toBe("RUNNING");
		const x = rows.find((r) => r.sid === "autowX")!;
		expect(x.live).toBeNull();
		expect(x.item).toBeNull();
		expect(x.state).toBe("PAUSED");
		const y = rows.find((r) => r.sid === "autowY")!;
		expect(y.live).toBe(false);
		expect(y.item).toBe("W9");
		expect(y.state).toBe("RUNNING");
	});

	test("registry sid prefixes coord sid (full vs short sid join)", () => {
		const rows = mergeLanes(
			{
				head: null,
				lanes: [
					{ sid: "autow522", name: null, intent: null, state: "RUNNING" },
				],
			},
			[
				{
					sid: "autow522-p98b319584008df14",
					item: "W522",
					live: true,
					host: null,
				},
			],
			[task({ id: "W522", state: "CLAIMED", age_s: 95 })],
		);
		expect(rows.length).toBe(1);
		expect(rows[0]?.live).toBe(true);
		expect(rows[0]?.item).toBe("W522");
	});
	test("all feeds down → no rows, no throw", () => {
		expect(mergeLanes(null, null, []).length).toBe(0);
	});

	test("claim age + title flow from the board row", () => {
		const rows = mergeLanes(coord, work, [
			task({
				id: "W522",
				state: "CLAIMED",
				age_s: 95,
				title: "build: fleet sidebar TUI",
			}),
		]);
		const a = rows.find((r) => r.sid === "autow522")!;
		expect(a.ageS).toBe(95);
		expect(a.title).toBe("build: fleet sidebar TUI");
	});
});

describe("selectTasks", () => {
	const rows = [
		task({ id: "R1", state: "READY", age_s: 5 }),
		task({ id: "D1", state: "DONE", age_s: 500 }),
		task({ id: "C1", state: "CLAIMED", age_s: 300 }),
		task({ id: "C2", state: "RUNNING", age_s: 100 }),
		task({ id: "B1", state: "BLOCKED", age_s: 9000 }),
	];
	test("active first (longest-held lead), READY trails, DONE drops", () => {
		const s = selectTasks(rows, 10);
		expect(s.map((r) => r.id)).toEqual(["C1", "C2", "B1", "R1"]);
	});
	test("cap", () => {
		expect(selectTasks(rows, 2).map((r) => r.id)).toEqual(["C1", "C2"]);
	});
});

describe("fmtAge", () => {
	test("vocabulary", () => {
		expect(fmtAge(45)).toBe("45s");
		expect(fmtAge(90)).toBe("1m");
		expect(fmtAge(3700)).toBe("1h");
		expect(fmtAge(90000)).toBe("1d");
		expect(fmtAge(-1)).toBe("—");
	});
});

describe("truncate/visibleLen", () => {
	const styled = `\x1b[36mW522\x1b[0m ${"x".repeat(80)}`;
	test("visible length strips ANSI", () => {
		expect(visibleLen(styled)).toBe(85);
	});
	test("cut is ANSI-aware and re-opens reset", () => {
		const cut = truncate(styled, 10);
		expect(visibleLen(cut)).toBeLessThanOrEqual(10);
		expect(cut.endsWith("\x1b[0m")).toBe(true);
	});
});

describe("buildFrame", () => {
	const fix = {
		head: "abc1234",
		lanes: [
			{
				sid: "autow522",
				name: null,
				intent: "W522 work",
				state: "RUNNING",
				live: true,
				item: "W522",
				itemState: "CLAIMED",
				ageS: 95,
				tagColor: "#0058A3",
				title: "build: fleet sidebar TUI",
			},
		],
		tasks: [
			task({
				id: "W522",
				state: "CLAIMED",
				age_s: 95,
				tag_color: "#0058A3",
				title: "build: fleet sidebar TUI — lanes, tasks, agents",
			}),
			task({ id: "W530", state: "READY", age_s: 2 }),
		],
		totalTasks: 2,
		boardOk: true,
		boardMs: 12,
		now: Date.UTC(2026, 9, 7, 18, 0, 0),
		width: 48,
		height: 12,
		top: 10,
		fleetRoot: "/fleet",
	};
	test("header + rule + section bars + footer", () => {
		const lines = buildFrame(fix);
		expect(lines[0]).toContain("fleet-watch");
		expect(lines[0]).toContain("@abc1234");
		expect(lines[1]).toContain("─");
		expect(lines.some((l) => l.includes("lanes"))).toBe(true);
		expect(lines.at(-1)).toContain("/fleet");
		expect(lines.at(-1)).toContain("board ok");
	});
	test("no-wrap guarantee: every line ≤ width-1 visible cols", () => {
		for (const l of buildFrame(fix))
			expect(visibleLen(l)).toBeLessThanOrEqual(fix.width - 1);
	});
	test("prefer tag color drives the truecolor dot", () => {
		expect(buildFrame(fix).some((l) => l.includes("38;2;0;88;163"))).toBe(true);
	});
	test("board down degrades the footer, frame still builds", () => {
		const lines = buildFrame({ ...fix, boardOk: false });
		expect(lines.at(-1)).toContain("board down");
	});
	test("height cap bounds the frame with a showing note", () => {
		const tall = {
			...fix,
			tasks: Array.from({ length: 40 }, (_, i) =>
				task({ id: `W${String(i)}`, state: "READY", age_s: i }),
			),
			totalTasks: 40,
		};
		const lines = buildFrame({ ...tall, height: 8 });
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("showing");
	});
});

describe("emitFrame diff contract", () => {
	const frame = ["a", "b", "c"];
	test("first TTY frame writes everything, EOL-cleared", () => {
		let out = "";
		emitFrame(null, frame, true, (s) => {
			out += s;
		});
		expect(out).toContain("a\x1b[K\nb\x1b[K\nc\x1b[K");
	});
	test("piped (--once) frame is a plain join", () => {
		let out = "\x00";
		emitFrame(null, frame, false, (s) => {
			out += s;
		});
		expect(out).toBe("\x00a\nb\nc");
	});
	test("unchanged frame rewrites no content", () => {
		let out = "";
		emitFrame(frame, frame, true, (s) => {
			out += s;
		});
		expect(out).not.toContain("a");
		expect(out).not.toContain("b");
		expect(out).toContain("\x1b[K");
	});
	test("one changed line rewrites only that line", () => {
		let out = "";
		emitFrame(frame, ["a", "B", "c"], true, (s) => {
			out += s;
		});
		expect(out).toContain("\x1b[2KB");
		expect(out).not.toContain("\x1b[2Ka");
		expect(out).not.toContain("\x1b[2Kc");
	});
	test("shrink clears the stale bottom", () => {
		let out = "";
		emitFrame(frame, ["a"], true, (s) => {
			out += s;
		});
		expect(out.endsWith("\x1b[J")).toBe(true);
	});
	test("grow appends the new rows", () => {
		let out = "";
		emitFrame(frame, ["a", "b", "c", "d"], true, (s) => {
			out += s;
		});
		expect(out).toContain("\x1b[2Kd");
	});
});

describe("glyph vocabulary matches work.ts", () => {
	test("state glyphs", () => {
		expect(stateGlyph("READY")[0]).toBe("·");
		expect(stateGlyph("CLAIMED")[0]).toBe("◐");
		expect(stateGlyph("RUNNING")[0]).toBe("▶");
		expect(stateGlyph("BLOCKED")[0]).toBe("⚠");
		expect(stateGlyph("PAUSED")[0]).toBe("⏸");
		expect(stateGlyph("DONE")[0]).toBe("✓");
	});
	test("lane glyphs", () => {
		expect(laneGlyph("PAUSED")[0]).toBe("⏸");
		expect(laneGlyph("RESUME_READY")[0]).toBe("↻");
		expect(laneGlyph("BLOCKED")[0]).toBe("⚠");
		expect(laneGlyph("whatever")[0]).toBe("▶");
	});
});
