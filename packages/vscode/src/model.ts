// model.ts — board feed types + pure label/tree logic (no vscode import —
// bun-testable). Shapes mirror packages/suspenders/docs/board-api.md v3.

export interface TaskTail {
	text: string;
	ts: string;
}

export interface TaskRow {
	project: string;
	id: string;
	title: string;
	state: string;
	owner_sid: string | null;
	owner_label: string | null;
	requires: string | null;
	scope: string | null;
	parent_id: string | null;
	age_s: number;
	open_decisions: number;
	tail: TaskTail | null;
	unblocked_by: string | null;
}

export interface TasksFeed {
	ok: boolean;
	projects: string[];
	tasks: TaskRow[];
}

export interface EventRow {
	id: number;
	ts: number;
	kind: string;
	source: string;
	note: string | null;
	sha: string | null;
}

export interface DecisionRow {
	id: number;
	project: string | null;
	task_id: string | null;
	task_title: string | null;
	asked_by_label: string | null;
	question: string;
	options: unknown[];
	state: string;
	answer_note: string | null;
	created_ts: number;
	age_s: number;
}

export interface DecisionsFeed {
	ts: number;
	count: number;
	byProject: Record<string, number>;
	decisions: DecisionRow[];
}

export interface TaskDetail {
	ok: boolean;
	task: TaskRow;
	events: EventRow[];
	decisions: DecisionRow[];
}

export interface ActivityFeed {
	ok: boolean;
	projects: string[];
	events: (EventRow & { target: string | null; project: string })[];
}

const GLYPHS: Record<string, string> = {
	READY: "▶",
	CLAIMED: "◐",
	RUNNING: "●",
	BLOCKED: "⊘",
	DONE: "✓",
	SHATTERED: "⊞",
};

export function stateGlyph(state: string): string {
	return GLYPHS[state] ?? "·";
}

export function shortProject(project: string): string {
	return (
		(project
			.replace(/\/\.git\/?$/, "")
			.split("/")
			.pop() ??
			project) ||
		project
	);
}

export function ageHuman(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
	return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

export function relTime(ts: number, now: number): string {
	return ageHuman(Math.max(0, Math.round((now - ts) / 1000)));
}

export function trunc(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export interface ProjectGroup {
	project: string;
	rows: TaskRow[];
}

export function groupByProject(rows: TaskRow[]): ProjectGroup[] {
	const groups = new Map<string, TaskRow[]>();
	for (const r of rows) {
		const list = groups.get(r.project);
		if (list) list.push(r);
		else groups.set(r.project, [r]);
	}
	return [...groups.entries()].map(([project, items]) => ({
		project,
		rows: items,
	}));
}

export function taskLabel(t: TaskRow): string {
	return `${t.id} ${stateGlyph(t.state)} ${trunc(t.title, 60)}`;
}

export function taskDescription(t: TaskRow): string {
	const owner = t.owner_label ?? t.owner_sid ?? "unclaimed";
	const parts = [t.state, owner, ageHuman(t.age_s)];
	if (t.open_decisions > 0) parts.push(`${t.open_decisions}?`);
	return parts.join(" · ");
}

export function taskSummary(t: TaskRow): string {
	const lines = [
		`${t.id} ${stateGlyph(t.state)} ${t.title}`,
		`project: ${shortProject(t.project)} · state: ${t.state} · age: ${ageHuman(t.age_s)}`,
		`owner: ${t.owner_label ?? t.owner_sid ?? "—"}`,
	];
	if (t.unblocked_by) lines.push(`unblocked by ${t.unblocked_by}`);
	if (t.open_decisions > 0) lines.push(`open decisions: ${t.open_decisions}`);
	if (t.tail?.text) lines.push(``, `tail: ${trunc(t.tail.text, 200)}`);
	return lines.join("\n");
}

export function decisionLabel(d: DecisionRow): string {
	return `#${d.id} ${trunc(d.question, 60)}`;
}

export function decisionLine(d: DecisionRow): string {
	const where = d.task_id ?? (shortProject(d.project ?? "") || "—");
	const answered = d.answer_note
		? ` · answered: ${trunc(d.answer_note, 80)}`
		: ``;
	return `#${d.id} [${d.state}] ${trunc(d.question, 90)} — ${where}${answered}`;
}
