// test/board-spend-cells.test.ts — W776: the board's tasks table + kanban
// cards render per-item attribution (spend.fresh/cached/out + wall_ms) from
// the /api/tasks feed. Functional tests eval the shipped TASKS chunk bytes
// with the shared chunk helpers injected (board-prefer.test.ts pattern);
// the payload side is covered live (itemAttribution in lane-spend.test.ts).
import { describe, expect, test } from "bun:test";
import { TASKS } from "../hooks/board-html/tasks.ts";

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
const agoShort = (s: unknown): string => `${s || 0}s`;

type Item = Record<string, unknown>;

function chunkSandbox(): {
	taskRow: (t: Item, parentId?: string | null) => string;
	kanbanCard: (t: Item) => string;
} {
	const fn = new Function(
		"esc",
		"taskPill",
		"agoShort",
		"window",
		`${TASKS}\nreturn { taskRow, kanbanCard };`,
	);
	return fn(esc, taskPill, agoShort, {
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
		expect(row).toContain('<td class="num">214k</td>'); // 138593+30000+45880
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
});

const IKEA_ROW = {
	id: "W9",
	title: "ikea item",
	state: "CLAIMED",
	owner_sid: "s1",
	age_s: 10,
};
