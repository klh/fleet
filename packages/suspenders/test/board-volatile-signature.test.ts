// test/board-volatile-signature.test.ts — W998.3: the kanban structural
// signature must exclude every volatile age/stamp element (kage text + open
// age tooltip, kcardstamp <time> datetime/title/text, ktail text) so
// per-second age churn doesn't force whole-card replacement, while real
// changes (title, a gained/lost stamp or tail div) still count as
// structural. Functional tests eval the shipped TASKS chunk bytes with the
// shared chunk helpers injected (board-spend-cells.test.ts pattern); the
// live browser behavior rides the e2e spec.
import { describe, expect, test } from "bun:test";
import { TASKS } from "../hooks/board-html/tasks.ts";
import { CORE } from "../hooks/board-html/core.ts";

// mirrors of the shared chunk helpers (core.ts) — passed INTO the sandbox so
// no helper source is quoted inside this file
const esc = (s: unknown): string =>
	String(s ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[c],
	);

const taskPill = (state: unknown): string =>
	`<span class="pill ${String(state).toLowerCase()}">${esc(state)}</span>`;

const coreFn = (name: string) =>
	new Function(`${CORE}\nreturn ${name};`)() as (...args: unknown[]) => unknown;

type Item = Record<string, unknown>;

interface StubEl {
	textContent: string;
	attrs: Record<string, string>;
	setAttribute: (key: string, value: string) => void;
	getAttribute: (key: string) => string;
}

function stubEl(): StubEl {
	const el: StubEl = {
		textContent: "",
		attrs: {},
		setAttribute(key, value) {
			el.attrs[key] = value;
		},
		getAttribute(key) {
			return el.attrs[key] ?? "";
		},
	};
	return el;
}

function chunkSandbox(): {
	kanbanCard: (t: Item) => string;
	kanbanStructural: (html: string) => string;
	updateKanbanVolatile: (el: unknown, shownAll: Item[]) => void;
} {
	const fn = new Function(
		"esc",
		"taskPill",
		"agoShort",
		"ago",
		"workTone",
		"msAgo",
		"window",
		`${TASKS}\nreturn { kanbanCard, kanbanStructural, updateKanbanVolatile };`,
	);
	return fn(
		esc,
		taskPill,
		coreFn("agoShort"),
		coreFn("ago"),
		coreFn("workTone"),
		coreFn("msAgo"),
		{ __execPrefs: [], addEventListener: () => {} },
	);
}

const ITEM = {
	id: "W9",
	title: "ikea item",
	state: "CLAIMED",
	owner_sid: "s1",
	age_s: 10,
	updated_at_utc: "2026-10-23T05:00:00.000Z",
};

describe("kanban volatile signature (W998.3)", () => {
	test("age-only churn leaves the structural signature identical despite the kage tooltip", () => {
		const { kanbanCard, kanbanStructural } = chunkSandbox();
		// the W998 regression shape: the kage span carries a title attribute,
		// its text + tooltip tick every second
		const now = kanbanCard({ ...ITEM, age_s: 10 });
		const later = kanbanCard({ ...ITEM, age_s: 4210 });
		expect(kanbanStructural(now)).toBe(kanbanStructural(later));
		// sanity: the volatile bits really are in the rendered card
		expect(now).toContain('title="open 10s ago">10s</span>');
		expect(later).toContain('title="open ');
	});

	test("update-instant churn stays volatile; the stamp span shell remains structural", () => {
		const { kanbanCard, kanbanStructural } = chunkSandbox();
		const early = kanbanCard({ ...ITEM });
		const later = kanbanCard({
			...ITEM,
			updated_at_utc: "2026-10-23T07:30:00.000Z",
		});
		// datetime/title/relative text move with the instant without forcing a
		// whole-card replacement (the in-place refresh keeps them accurate)
		expect(kanbanStructural(early)).toBe(kanbanStructural(later));
		// a card WITHOUT the stamp span differs — gaining/losing it is real
		const noStamp = kanbanCard({ ...ITEM, updated_at_utc: null });
		expect(kanbanStructural(noStamp)).not.toBe(kanbanStructural(early));
	});

	test("real product changes stay structural (title, tail div)", () => {
		const { kanbanCard, kanbanStructural } = chunkSandbox();
		const base = kanbanCard({ ...ITEM });
		expect(
			kanbanStructural(kanbanCard({ ...ITEM, title: "renamed" })),
		).not.toBe(base);
		expect(
			kanbanStructural(kanbanCard({ ...ITEM, tail: { text: "fresh tail" } })),
		).not.toBe(base);
	});

	test("rename containing '· observed' stays structural (W998.3.1)", () => {
		const { kanbanCard, kanbanStructural } = chunkSandbox();
		// the W998.3 global '· observed' regex collapsed BOTH of these to one
		// signature — the stale card never rebuilt and the title never refreshed
		const oldFinding = kanbanStructural(
			kanbanCard({ ...ITEM, title: "Product · observed old finding" }),
		);
		expect(
			kanbanStructural(
				kanbanCard({ ...ITEM, title: "Product · observed new finding" }),
			),
		).not.toBe(oldFinding);
		// even an ISO-looking tail in TITLE TEXT stays structural: only the
		// execution klane's title attribute normalizes
		const isoTitle = (iso: string) =>
			kanbanStructural(
				kanbanCard({ ...ITEM, title: `Product · observed ${iso}` }),
			);
		expect(isoTitle("2026-10-23T05:00:00.000Z")).not.toBe(
			isoTitle("2026-10-23T05:00:05.000Z"),
		);
	});

	test("per-poll observation instants stay out of the signature", () => {
		const { kanbanCard, kanbanStructural } = chunkSandbox();
		// execution evidence is re-observed every poll: the klane tooltip's
		// `observed <ISO>` must not churn the signature; the evidence state
		// itself does
		const withExec = (ms: number) =>
			kanbanCard({
				...ITEM,
				execution: {
					state: "unknown",
					observed_at: ms,
					source: "work-claim-only",
					progress: null,
				},
			});
		expect(kanbanStructural(withExec(1792739145955))).toBe(
			kanbanStructural(withExec(1792739149169)),
		);
		// the board summary's `· checked <ISO>` suffix churns per poll
		const summary = (iso: string) =>
			`<p class="dim" title="Harness presence is not productive output">1 claims · 1 owners · 0 live harnesses · 0 paused · 0 blocked · 0 dead · 1 unknown · 0 transitioning · checked ${iso}</p>`;
		expect(kanbanStructural(summary("2026-10-23T07:05:41.834Z"))).toBe(
			kanbanStructural(summary("2026-10-23T07:05:45.834Z")),
		);
	});

	test("only the ISO tail of the execution klane tooltip normalizes (W998.3.1)", () => {
		const { kanbanCard, kanbanStructural } = chunkSandbox();
		const exec = (src: string, ms: number) =>
			kanbanCard({
				...ITEM,
				execution: {
					state: "unknown",
					observed_at: ms,
					source: src,
					progress: null,
				},
			});
		// the observed instant churns per poll — volatile, tooltip refreshes in place
		expect(kanbanStructural(exec("work-claim-only", 1792739145955))).toBe(
			kanbanStructural(exec("work-claim-only", 1792739149169)),
		);
		// arbitrary attribute content stays structural — a different source
		// (or any non-ISO tail) is a real change
		expect(kanbanStructural(exec("work-claim-only", 1))).not.toBe(
			kanbanStructural(exec("dispatch", 1)),
		);
	});

	test("spend strip: live wall age is volatile, token totals stay structural", () => {
		const { kanbanCard, kanbanStructural } = chunkSandbox();
		const spend = (wall_ms: number, fresh: number) => ({
			fresh,
			cached: 0,
			out: 0,
			requests: 1,
			wall_ms,
			agent_ms: wall_ms,
			model_groups: {},
		});
		const card = (wall_ms: number, fresh: number) =>
			kanbanCard({ ...ITEM, spend: spend(wall_ms, fresh) });
		// wall_ms accumulates with lane age — minute-granular churn excluded
		expect(kanbanStructural(card(117, 0))).toBe(
			kanbanStructural(card(6112, 0)),
		);
		// a real spend change (token totals) still counts
		expect(kanbanStructural(card(117, 5_000))).not.toBe(
			kanbanStructural(card(117, 0)),
		);
	});

	test("updateKanbanVolatile refreshes age tooltip + stamp datetime/title in place", () => {
		const { updateKanbanVolatile } = chunkSandbox();
		const ageEl = stubEl();
		const stampEl = stubEl();
		const tailEl = stubEl();
		const card = {
			getAttribute: (name: string) => (name === "data-kid" ? ITEM.id : null),
			querySelector: (sel: string) => {
				if (sel === ".kage") return ageEl;
				if (sel === ".kcardstamp time") return stampEl;
				if (sel === ".ktail") return tailEl;
				return null;
			},
		};
		const container = { querySelectorAll: () => [card] };
		// 8 minutes back — the label rounds inside agoShort, a ms drift can't
		// flip the minute
		const updated = new Date(Date.now() - 8 * 60_000).toISOString();
		updateKanbanVolatile(container, [
			{ ...ITEM, age_s: 130, updated_at_utc: updated },
		]);
		expect(ageEl.textContent).toBe("2m");
		expect(ageEl.getAttribute("title")).toBe("open 2 minutes ago");
		expect(stampEl.getAttribute("datetime")).toBe(updated);
		expect(stampEl.getAttribute("title")).toContain("UTC ");
		expect(stampEl.getAttribute("title")).toContain(
			new Date(updated).toISOString(),
		);
		expect(stampEl.getAttribute("title")).toMatch(/^updated /);
		expect(stampEl.textContent).toBe("8m");
	});
});
