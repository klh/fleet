// taskdoc.ts — the task-detail text document: a pure renderer over a
// TaskDetail (bun-tested); the fleet-task content provider serving it
// lives in extension.ts.

import type { TaskDetail } from "./model";
import {
	ageHuman,
	decisionLine,
	relTime,
	shortProject,
	stateGlyph,
} from "./model";

export function renderTaskDetail(d: TaskDetail): string {
	const t = d.task;
	const out: string[] = [
		`${t.id} — ${t.title}`,
		``,
		`project:  ${shortProject(t.project)} (${t.project})`,
		`state:    ${t.state} ${stateGlyph(t.state)}`,
		`owner:    ${t.owner_label ?? t.owner_sid ?? "—"}`,
		`age:      ${ageHuman(t.age_s)}`,
		`requires: ${t.requires ?? "—"}`,
		`scope:    ${t.scope ?? "—"}`,
	];
	if (t.parent_id) out.push(`parent:   ${t.parent_id}`);
	if (t.unblocked_by) out.push(`unblocked by ${t.unblocked_by}`);
	if (t.open_decisions > 0) out.push(`open decisions: ${t.open_decisions}`);
	out.push(``, `tail`, `----`);
	out.push(t.tail?.text ? indent(t.tail.text) : `(no lane output yet)`);
	out.push(``, `decisions`, `---------`);
	if (d.decisions.length === 0) out.push(`(none)`);
	for (const dec of d.decisions) out.push(decisionLine(dec));
	out.push(``, `events (newest first)`, `---------------------`);
	if (d.events.length === 0) out.push(`(none)`);
	for (const ev of d.events) {
		const sha = ev.sha ? ` (${ev.sha.slice(0, 10)})` : ``;
		const note = ev.note ? ` — ${ev.note}` : ``;
		out.push(
			`#${ev.id} ${relTime(ev.ts, Date.now())} ago [${ev.kind}] ${ev.source}${note}${sha}`,
		);
	}
	return `${out.join("\n")}\n`;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n");
}
