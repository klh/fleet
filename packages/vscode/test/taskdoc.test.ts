import { expect, test } from "bun:test";
import { renderTaskDetail } from "../src/taskdoc";
import type { TaskDetail } from "../src/model";

function detail(): TaskDetail {
	return {
		ok: true,
		task: {
			project: "/p/repo/.git",
			id: "W7",
			title: "do the thing",
			state: "RUNNING",
			owner_sid: "autow7",
			owner_label: "lane7",
			requires: "shell,git",
			scope: "src/x",
			parent_id: null,
			age_s: 120,
			open_decisions: 1,
			tail: { text: "→ Bash: bun test test/", ts: "t" },
			unblocked_by: null,
		},
		events: [
			{
				id: 9,
				ts: 1_800_000_000_000,
				kind: "work.claim",
				source: "autow7",
				note: null,
				sha: null,
			},
		],
		decisions: [
			{
				id: 12,
				project: "/p/repo/.git",
				task_id: "W7",
				task_title: "do the thing",
				asked_by_label: "lane7",
				question: "ship now?",
				options: [],
				state: "OPEN",
				answer_note: null,
				created_ts: 0,
				age_s: 45,
			},
		],
	};
}

test("renderTaskDetail renders the sections", () => {
	const text = renderTaskDetail(detail());
	for (const frag of [
		"W7 — do the thing",
		"state:    RUNNING ●",
		"owner:    lane7",
		"age:      2m",
		"requires: shell,git",
		"scope:    src/x",
		"open decisions: 1",
		"→ Bash: bun test test/",
		"[OPEN] ship now? — W7",
		"[work.claim] autow7",
	]) {
		expect(text).toContain(frag);
	}
	expect(text.endsWith("\n")).toBe(true);
});

test("empty sections render (none)", () => {
	const d = detail();
	d.events = [];
	d.decisions = [];
	d.task.tail = null;
	const text = renderTaskDetail(d);
	expect(text).toContain("(no lane output yet)");
	expect(text).toContain("(none)");
});

test("sha is trimmed to 10 chars", () => {
	const d = detail();
	const ev = d.events[0];
	if (ev) ev.sha = "abcdef1234567890";
	const text = renderTaskDetail(d);
	expect(text).toContain("(abcdef1234)");
});
