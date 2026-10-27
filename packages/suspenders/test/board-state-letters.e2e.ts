// test/board-state-letters.test.ts — W891: the state letter rides every
// state pill (tasks table, kanban cards, drawer) and the fleet lanes rows,
// colored by the klh semantic state tokens: F red, R blue, D green, Q gray.
// Functional tests eval the shipped CORE chunk bytes (the String.raw export)
// — the same taskPill/stateHue/stLetter the served page runs; page-level
// asserts cover the token CSS and the RENDERS-chunk sink.
import { expect, test } from "@playwright/test";
import { CORE } from "../hooks/board-html/core.ts";
import { RENDERS } from "../hooks/board-html/renders.ts";
import { HTML } from "../hooks/bin/fleet-board-html.ts";

// drive the shipped CORE bytes; the chunk is self-contained at def time
// (top-level var/function declarations only)
const chunk = new Function(
	`${CORE}\nreturn { taskPill, stateHue, stLetter, workTone };`,
)();

test.describe("state letters (W891) — taskPill", () => {
	test("READY → R blue (info token)", () => {
		expect(chunk.taskPill("READY")).toBe(
			'<span class="pill ready" data-tone="ready"><b class="stl info">R</b>ready</span>',
		);
	});

	test("FAILED → F red (danger token)", () => {
		expect(chunk.taskPill("FAILED")).toBe(
			'<span class="pill fail" data-tone="failed"><b class="stl danger">F</b>failed</span>',
		);
	});

	test("DONE → D green (ok token)", () => {
		expect(chunk.taskPill("DONE")).toBe(
			'<span class="pill done" data-tone="done"><b class="stl ok">D</b>done</span>',
		);
	});

	test("CLAIMED/RUNNING → raw word, C/R accent", () => {
		expect(chunk.taskPill("CLAIMED")).toBe(
			'<span class="pill run" data-tone="working"><b class="stl accent">C</b>claimed</span>',
		);
		expect(chunk.taskPill("RUNNING")).toBe(
			'<span class="pill run" data-tone="working"><b class="stl accent">R</b>running</span>',
		);
	});

	test("BLOCKED/PAUSED → initial + danger", () => {
		expect(chunk.taskPill("BLOCKED")).toContain('<b class="stl danger">B</b>');
		expect(chunk.taskPill("PAUSED")).toContain('<b class="stl danger">P</b>');
	});

	test("CANCELLED → C dim", () => {
		expect(chunk.taskPill("CANCELLED")).toContain('<b class="stl dim">C</b>');
	});

	test("null state → ? dim, never throws", () => {
		expect(chunk.taskPill(null)).toBe(
			'<span class="pill ready" data-tone="ready"><b class="stl dim">?</b>?</span>',
		);
	});

	test("work states keep six distinct semantic tones and split label", () => {
		expect(
			["READY", "CLAIMED", "BLOCKED", "FAILED", "DONE", "SHATTERED"].map(
				chunk.workTone,
			),
		).toEqual(["ready", "working", "blocked", "failed", "done", "split"]);
		expect(chunk.taskPill("SHATTERED")).toContain('data-tone="split"');
		expect(chunk.taskPill("SHATTERED")).toContain("split</span>");
		expect(chunk.workTone('READY" onmouseover="x')).toBe("ready");
		expect(chunk.workTone("WAITING")).toBe("blocked");
		expect(chunk.taskPill("WAITING")).toContain('data-tone="blocked"');
	});
});

test.describe("state letters (W891) — lanes rows + tokens", () => {
	test("quiet → Q gray (the owner's fourth letter)", () => {
		expect(chunk.stateHue("quiet")).toBe("dim");
		expect(chunk.stLetter("quiet")).toBe('<b class="stl dim">Q</b>');
	});

	test("flagged lanes read 'waiting for you' → W danger", () => {
		expect(chunk.stLetter("waiting for you")).toBe(
			'<b class="stl danger">W</b>',
		);
	});

	test("RENDERS chunk feeds the lanes status span through the shared sink", () => {
		expect(RENDERS).toContain("setNodes(status, stLetter(label) + esc(label))");
	});

	test("page CSS: hue classes resolve through the klh tokens", () => {
		expect(HTML).toContain(".stl.info { color:var(--klh-info); }");
		expect(HTML).toContain(".stl.ok { color:var(--klh-ok-ink); }");
		expect(HTML).toContain(".stl.danger { color:var(--klh-danger-ink); }");
		expect(HTML).toContain(".stl.accent { color:var(--klh-accent); }");
		expect(HTML).toContain(".stl.dim { color:var(--klh-dim); }");
	});
});
