// test/board-prefer.test.ts — W518: the board renders the .prefer tag + color
// carried on work items (W517's lib resolves the repo's .prefer). The kanban
// card border and the task-list dot ride the --prefer token; absent prefer =
// no affordance. Functional tests eval the shipped TASKS chunk bytes (the
// String.raw export) with the shared chunk helpers (core.ts esc/taskPill/
// agoShort) injected as parameters; page-level asserts cover the token CSS.
import { describe, expect, test } from "bun:test";
import { TASKS } from "../hooks/board-html/tasks.ts";
import { HTML } from "../hooks/bin/fleet-board-html.ts";

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
	preferOf: (t: Item) => { tag: string; color: string } | null;
} {
	const fn = new Function(
		"esc",
		"taskPill",
		"agoShort",
		"window",
		`${TASKS}\nreturn { taskRow, kanbanCard, preferOf };`,
	);
	return fn(esc, taskPill, agoShort, { __execPrefs: [] });
}

const IKEA = {
	id: "W9",
	title: "ikea item",
	state: "CLAIMED",
	owner_sid: "s1",
	age_s: 10,
	tag: "ikea",
	tag_color: "#0058A3",
};

describe("board prefer render (W518)", () => {
	test("taskRow: prefer dot with tag tooltip", () => {
		const { taskRow } = chunkSandbox();
		const row = taskRow(IKEA, null);
		expect(row).toContain(
			'<span class="pdot" style="--prefer:#0058A3" title="prefer: ikea">',
		);
	});

	test("taskRow: no prefer, no dot", () => {
		const { taskRow } = chunkSandbox();
		const row = taskRow(
			{ id: "W1", title: "plain", state: "READY", age_s: 1 },
			null,
		);
		expect(row).not.toContain("pdot");
	});

	test("kanbanCard: border token present with prefer, absent without", () => {
		const { kanbanCard } = chunkSandbox();
		const card = kanbanCard(IKEA);
		expect(card).toContain(
			'<div class="kcard" style="--prefer:#0058A3" data-kid="W9"',
		);
		const plain = kanbanCard({
			id: "W2",
			title: "p",
			state: "CLAIMED",
			owner_sid: "s1",
			age_s: 1,
		});
		expect(plain).toContain('<div class="kcard" data-kid="W2"');
		expect(plain).not.toContain("--prefer");
	});

	test("prefer fields pass through esc() — hostile color cannot break out", () => {
		const { kanbanCard } = chunkSandbox();
		const card = kanbanCard({
			id: "W3",
			title: "x",
			state: "CLAIMED",
			owner_sid: "s1",
			age_s: 1,
			tag: 'evil" onload="',
			tag_color: '#000"><script>',
		});
		expect(card).not.toContain('"><script>');
		expect(card).toContain("&quot;&gt;&lt;script&gt;");
	});

	test("page CSS: kcard border + pdot ride --prefer", () => {
		expect(HTML).toContain(
			".kcard { border:1px solid var(--prefer, var(--klh-edge-soft))",
		);
		expect(HTML).toContain(".pdot { display:inline-block");
	});
});
