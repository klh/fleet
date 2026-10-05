import { expect, test } from "bun:test";
import {
	ageHuman,
	decisionLabel,
	decisionLine,
	groupByProject,
	relTime,
	shortProject,
	stateGlyph,
	taskDescription,
	taskLabel,
	taskSummary,
	trunc,
} from "../src/model";
import type { TaskRow } from "../src/model";

const NOW = 1_800_000_000_000;

function row(over: Partial<TaskRow> = {}): TaskRow {
	return {
		project: "/p/repo/.git",
		id: "W7",
		title: "do the thing",
		state: "CLAIMED",
		owner_sid: "autow7",
		owner_label: "lane7",
		requires: "shell,git",
		scope: null,
		parent_id: null,
		age_s: 4500,
		open_decisions: 0,
		tail: null,
		unblocked_by: null,
		...over,
	};
}

test("stateGlyph maps the board vocabulary", () => {
	expect(stateGlyph("READY")).toBe("▶");
	expect(stateGlyph("CLAIMED")).toBe("◐");
	expect(stateGlyph("RUNNING")).toBe("●");
	expect(stateGlyph("BLOCKED")).toBe("⊘");
	expect(stateGlyph("DONE")).toBe("✓");
	expect(stateGlyph("SHATTERED")).toBe("⊞");
	expect(stateGlyph("WEIRD")).toBe("·");
});

test("shortProject strips the git dir", () => {
	expect(shortProject("/home/k/dev/klh/fleet/.git")).toBe("fleet");
	expect(shortProject("/p/r/.git/")).toBe("r");
	expect(shortProject("fleet")).toBe("fleet");
});

test("ageHuman scales", () => {
	expect(ageHuman(45)).toBe("45s");
	expect(ageHuman(120)).toBe("2m");
	expect(ageHuman(4500)).toBe("1h15m");
	expect(ageHuman(100_000)).toBe("27h46m");
	expect(ageHuman(200_000)).toBe("2d07h");
});

test("relTime uses now", () => {
	expect(relTime(NOW - 60_000, NOW)).toBe("1m");
	expect(relTime(NOW + 5_000, NOW)).toBe("0s");
});

test("trunc caps with ellipsis", () => {
	expect(trunc("abcdef", 4)).toBe("abc…");
	expect(trunc("ab", 4)).toBe("ab");
});

test("taskLabel + taskDescription carry state/owner/age/decisions", () => {
	const t = row({ open_decisions: 2 });
	expect(taskLabel(t)).toBe("W7 ◐ do the thing");
	expect(taskDescription(t)).toBe("CLAIMED · lane7 · 1h15m · 2?");
	expect(taskDescription(row({ owner_sid: null, owner_label: null }))).toBe(
		"CLAIMED · unclaimed · 1h15m",
	);
});

test("taskSummary lists unblocked + tail", () => {
	const t = row({
		unblocked_by: "W6",
		tail: { text: "line one\nline two", ts: "t" },
	});
	const s = taskSummary(t);
	expect(s).toContain("W7 ◐ do the thing");
	expect(s).toContain("unblocked by W6");
	expect(s).toContain("tail: line one");
});

test("groupByProject keeps feed order per project", () => {
	const a = row({ id: "W1", project: "/p/a/.git" });
	const b = row({ id: "W2", project: "/p/b/.git" });
	const c = row({ id: "W3", project: "/p/a/.git" });
	const groups = groupByProject([a, b, c]);
	expect(groups.map((g) => g.project)).toEqual(["/p/a/.git", "/p/b/.git"]);
	expect(groups[0]?.rows.map((r) => r.id)).toEqual(["W1", "W3"]);
});

test("decisionLabel + decisionLine render state and target", () => {
	const d = {
		id: 12,
		project: null,
		task_id: "W7",
		task_title: null,
		asked_by_label: "lane7",
		question: "ship now?",
		options: [],
		state: "OPEN",
		answer_note: null,
		created_ts: NOW,
		age_s: 30,
	};
	expect(decisionLabel(d)).toBe("#12 ship now?");
	expect(decisionLine(d)).toContain("[OPEN] ship now? — W7");
});
