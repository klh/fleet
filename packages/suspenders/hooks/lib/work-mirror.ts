// work-mirror.ts — the .workgraph.jsonl graph mirror, extracted from
// bin/work.ts (W515: work.ts sat at the 1500-line ceiling when the allocate
// verb landed). beads-inspired: every SUCCESSFUL mutating command atomically
// re-exports the project graph beside the git common dir, and read verbs
// fall back to that file when governor.db cannot serve the project. The DB
// always wins when it holds the project's rows; reads never write.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { openMemoryStore, projectRootOf, type GovernorStore } from "./govdb.ts";

export const MIRROR_NAME = ".workgraph.jsonl";
const MIRROR_MAX_AGE = 15 * 60_000;

type Item = Record<string, string | number | null>;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string): string => (tty ? `\x1b[2m${s}\x1b[0m` : s);

const mirrorPath = (project: string): string =>
	`${projectRootOf(project)}/${MIRROR_NAME}`;

// tolerant parse: an absent, truncated, or hand-mangled mirror is never a hard
// failure — reads then just have nothing to fall back to
function readMirror(
	project: string,
): { items: Item[]; meta: Record<string, unknown> } | null {
	try {
		const lines = readFileSync(mirrorPath(project), "utf8")
			.split("\n")
			.filter((l) => l.trim());
		const meta = JSON.parse(lines[lines.length - 1] ?? "null");
		if (meta?.type !== "meta") return null;
		if (meta.project && meta.project !== project) return null; // someone else's mirror
		return {
			meta,
			items: lines.slice(0, -1).map((l) => JSON.parse(l) as Item),
		};
	} catch {
		return null;
	}
}

// rebuild the project graph in an in-memory SQLite shaped like the real one, so
// read handlers run their normal SQL UNCHANGED against the mirror copy
function mirrorDb(project: string): GovernorStore | null {
	const m = readMirror(project);
	if (!m) return null;
	const d = openMemoryStore();
	d.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL DEFAULT 'READY', priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1, requires TEXT, tags TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	d.run(
		"CREATE TABLE work_deps (project TEXT NOT NULL, work_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (project, work_id, depends_on))",
	);
	const defaults: Partial<Record<string, string | number>> = {
		state: "READY",
		priority: 0,
		required: 1,
		created_at: 0,
		updated_at: 0,
	};
	const cols = [
		"id",
		"parent_id",
		"title",
		"description",
		"state",
		"priority",
		"owner_sid",
		"created_by",
		"scope",
		"why_parallel",
		"result_sha",
		"required",
		"requires",
		"tags",
		"created_at",
		"updated_at",
	];
	const ins = d.query(
		`INSERT INTO work_items (project, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`,
	);
	for (const it of m.items) {
		try {
			ins.run(project, ...cols.map((c) => it[c] ?? defaults[c] ?? null));
		} catch {}
	}
	const insDep = d.query(
		"INSERT INTO work_deps (project, work_id, depends_on) VALUES (?, ?, ?)",
	);
	for (const it of m.items)
		for (const dep of (it.deps as string[] | undefined) ?? []) {
			try {
				insDep.run(project, it.id, dep);
			} catch {}
		}
	console.error(
		dim(
			`serving from ${MIRROR_NAME} mirror (governor.db unreachable) — read-only`,
		),
	);
	const age = Date.now() - Number(m.meta.exported_at ?? 0);
	if (age > MIRROR_MAX_AGE)
		console.error(
			dim(`mirror may be stale, exported ${Math.floor(age / 60_000)}m ago`),
		);
	return d;
}

// a broken mirror degrades to "no fallback" — never a crash on the read path
export function mirrorOrNull(project: string): GovernorStore | null {
	try {
		return mirrorDb(project);
	} catch {
		return null;
	}
}

// reached ONLY after a successful mutating command — the caller passes the
// open store; every failure path exits before this, so a refresh here is
// exactly "the graph changed".
export function exportMirror(store: GovernorStore, project: string): void {
	try {
		const items = store
			.query("SELECT * FROM work_items WHERE project = ? ORDER BY id")
			.all(project) as Item[];
		const edges = new Map<string, string[]>();
		for (const e of store
			.query("SELECT work_id, depends_on FROM work_deps WHERE project = ?")
			.all(project) as { work_id: string; depends_on: string }[]) {
			edges.set(e.work_id, [...(edges.get(e.work_id) ?? []), e.depends_on]);
		}
		const lines = items.map((r) =>
			JSON.stringify({
				...r,
				project: undefined,
				deps: edges.get(r.id as string) ?? [],
			}),
		);
		let maxUpdated = 0;
		for (const r of items)
			maxUpdated = Math.max(maxUpdated, Number(r.updated_at) || 0);
		lines.push(
			JSON.stringify({
				type: "meta",
				project,
				exported_at: Date.now(),
				count: items.length,
				max_updated_at: maxUpdated,
			}),
		);
		const tmp = `${mirrorPath(project)}.tmp-${process.pid}`;
		writeFileSync(tmp, `${lines.join("\n")}\n`);
		renameSync(tmp, mirrorPath(project)); // atomic — a concurrent reader sees old or new, never half
	} catch (e) {
		console.error(
			dim(
				`work: mirror export skipped (${e instanceof Error ? e.message : String(e)})`,
			),
		);
	}
}
