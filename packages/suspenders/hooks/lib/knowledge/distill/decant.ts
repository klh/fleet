// distill/decant.ts — decant as a knowledge SOURCE for the graph walker.
// packages/decant indexes every agent transcript on the machine into
// ~/.decant/decant.db; we read it through a READ-ONLY handle (never its
// schema, never upstream bytes — FLEET.md) and project it into the graph:
//   session → project (about) · session → work_item (mentions)
//   session → file (touched / edited) · session → tool / command (uses)
//   file ↔ file co_changed (same session) · command → script (part_of)
//   lesson ↔ session (derived_from, written by the extract job)
// Sessions are reference nodes — no transcript text enters the graph. Every
// derived string passes the scrub rule set + secret redaction FIRST
// (decant.db is unencrypted and holds secrets/paths from transcripts).
// Recurring command sets become knowledge only via the Kev gate, as
// `candidate`, origin_kind 'decant', source_ref = the decant session.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { JobContext, Unit } from "./context.ts";
import { extractEntities } from "./extract.ts";
import { upsertEdge, upsertNode } from "./graph.ts";
import { getState, setState } from "./schema.ts";
import { scrubbed, sha } from "./sink.ts";

/** Open the machine's decant.db read-only; absent/unreadable = null. */
export function openDecant(path: string | undefined): Database | null {
	if (!path || !existsSync(path)) return null;
	try {
		const db = new Database(path, { readonly: true });
		db.query("SELECT 1 FROM session LIMIT 1").get();
		return db;
	} catch {
		return null;
	}
}

const EDIT_OPS = new Set(["edit", "write", "delete"]);
const SHELL_TOOLS = new Set([
	"Bash",
	"bash",
	"shell",
	"exec_command",
	"run_shell_command",
]);
const DECANT_PROPS = { origin: "decant", scrubbed: true };

interface SessionRow {
	id: number;
	tool: string;
	source_session_id: string;
	project_id: number | null;
	title: string | null;
	git_branch: string | null;
	model: string | null;
	started_at: string | null;
	source_hash: string | null;
	ingested_at: string | null;
}

/** Mirror new / re-ingested decant sessions into session nodes. */
export function indexDecantSessions(
	db: Database,
	dc: Database,
	now: number = Date.now(),
): number {
	const cursor = getState(db, "decant.ingested_at") ?? "";
	const rows = dc
		.query(
			"SELECT id, tool, source_session_id, project_id, title, git_branch, model, started_at, source_hash, ingested_at FROM session WHERE COALESCE(ingested_at, '') >= ? ORDER BY ingested_at, id LIMIT 2000",
		)
		.all(cursor) as SessionRow[];
	let high = cursor;
	db.transaction(() => {
		for (const s of rows) {
			upsertNode(
				db,
				{
					kind: "session",
					key: scrubbed(`decant:${s.tool}/${s.source_session_id}`),
					label: scrubbed(s.title ?? "").slice(0, 120),
					hash: s.source_hash ?? s.ingested_at ?? null,
					props: {
						...DECANT_PROPS,
						decant_id: s.id,
						tool: s.tool,
						model: s.model,
						started_at: s.started_at,
						branch: s.git_branch ? scrubbed(s.git_branch) : null,
						project_id: s.project_id,
					},
				},
				now,
			);
			if ((s.ingested_at ?? "") > high) high = s.ingested_at ?? high;
		}
		setState(db, "decant.ingested_at", high);
	})();
	return rows.length;
}

/** First two shell words of a command, normalized — the command node key. */
export function commandHead(input: string | null): string | null {
	if (!input) return null;
	let cmd = input;
	try {
		const j = JSON.parse(input) as { command?: unknown; cmd?: unknown };
		const v = j.command ?? j.cmd;
		cmd = Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : input;
	} catch {}
	const words = cmd
		.replace(/^\s*(?:cd\s+\S+\s*&&\s*)+/, "")
		.trim()
		.split(/\s+/)
		.filter((w) => !/^[A-Z_]+=/.test(w));
	const head = words
		.slice(0, words[0] === "bun" || words[0] === "git" ? 2 : 1)
		.join(" ");
	return head && /^[\w./@:+-]+(?: [\w./@:+-]+)?$/.test(head)
		? scrubbed(head).slice(0, 60)
		: null;
}

const projectKey = (path: string): string =>
	`project:${sha(path).slice(0, 16)}`;

const edge = (
	ctx: JobContext,
	src: number,
	dst: number,
	type:
		| "about"
		| "mentions"
		| "touched"
		| "edited"
		| "uses"
		| "co_changed"
		| "part_of",
	weight = 1,
	evidenceRef: string | null = null,
): void => {
	upsertEdge(ctx.db, {
		src,
		dst,
		type,
		weight,
		evidenceRef,
		createdBy: "decant",
		state: "active",
	});
};

export const decantUnit: Unit = async (ctx, node) => {
	const dc = ctx.decant;
	if (!dc) return { outcome: "skip:no-decant" };
	const props = JSON.parse(node.props) as {
		decant_id?: number;
		branch?: string | null;
	};
	const sid = props.decant_id;
	if (typeof sid !== "number") return { outcome: "missing" };
	const s = dc
		.query("SELECT project_id, title, git_branch FROM session WHERE id = ?")
		.get(sid) as Pick<SessionRow, "project_id" | "title" | "git_branch"> | null;
	if (!s) return { outcome: "missing" };
	const now = ctx.now();
	let n = 0;
	let projectNode: number | null = null;
	let projectPath: string | null = null;
	ctx.db.transaction(() => {
		if (s.project_id !== null) {
			const p = dc
				.query("SELECT path, name FROM project WHERE id = ?")
				.get(s.project_id) as { path: string; name: string | null } | null;
			if (p) {
				projectPath = p.path;
				projectNode = upsertNode(
					ctx.db,
					{
						kind: "project",
						key: projectKey(p.path),
						label: scrubbed(p.name ?? "").slice(0, 80),
						props: DECANT_PROPS,
					},
					now,
				);
				edge(ctx, node.id, projectNode, "about");
				n++;
			}
		}
		for (const e of extractEntities(
			scrubbed(`${s.title ?? ""} ${s.git_branch ?? ""}`),
		))
			if (e.kind === "work_item") {
				edge(
					ctx,
					node.id,
					upsertNode(ctx.db, { kind: "work_item", key: e.key }, now),
					"mentions",
				);
				n++;
			}
		const files = dc
			.query(
				"SELECT path, rel_path, operation, COUNT(*) AS c FROM file_ref WHERE session_id = ? GROUP BY path, operation LIMIT 200",
			)
			.all(sid) as {
			path: string;
			rel_path: string | null;
			operation: string;
			c: number;
		}[];
		const edited = new Map<string, { id: number; path: string }>();
		for (const f of files) {
			const key = scrubbed(f.rel_path ?? f.path).slice(0, 300);
			const fid = upsertNode(
				ctx.db,
				{ kind: "code", key, props: DECANT_PROPS },
				now,
			);
			const op = EDIT_OPS.has(f.operation) ? "edited" : "touched";
			edge(ctx, node.id, fid, op, f.c);
			if (op === "edited" && edited.size < 12)
				edited.set(key, { id: fid, path: f.path });
			n++;
		}
		const ed = [...edited.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
		for (let i = 0; i < ed.length; i++)
			for (let j = i + 1; j < ed.length; j++) {
				const a = ed[i]?.[1];
				const b = ed[j]?.[1];
				if (!a || !b) continue;
				const co = dc
					.query(
						"SELECT COUNT(DISTINCT x.session_id) AS c FROM file_ref x JOIN file_ref y ON y.session_id = x.session_id WHERE x.path = ? AND y.path = ? AND x.operation IN ('edit','write','delete') AND y.operation IN ('edit','write','delete')",
					)
					.get(a.path, b.path) as { c: number };
				edge(ctx, a.id, b.id, "co_changed", co.c);
				n++;
			}
		const tools = dc
			.query(
				"SELECT COALESCE(tool_base_name, tool_name) AS t, COUNT(*) AS c FROM tool_call WHERE session_id = ? AND COALESCE(tool_base_name, tool_name) IS NOT NULL GROUP BY t LIMIT 100",
			)
			.all(sid) as { t: string; c: number }[];
		for (const t of tools) {
			edge(
				ctx,
				node.id,
				upsertNode(
					ctx.db,
					{ kind: "tool", key: scrubbed(t.t).slice(0, 80) },
					now,
				),
				"uses",
				t.c,
			);
			n++;
		}
		for (const head of sessionCommands(dc, sid).keys()) {
			edge(
				ctx,
				node.id,
				upsertNode(
					ctx.db,
					{ kind: "command", key: head, props: DECANT_PROPS },
					now,
				),
				"uses",
			);
			n++;
		}
	})();
	const script =
		projectNode !== null && projectPath !== null
			? await projectScript(ctx, projectNode, projectPath, node.key)
			: "none";
	return { outcome: `linked:${String(n)} script:${script}` };
};

function sessionCommands(dc: Database, sid: number): Map<string, number> {
	const out = new Map<string, number>();
	const rows = dc
		.query(
			"SELECT COALESCE(tool_base_name, tool_name) AS t, input FROM tool_call WHERE session_id = ? LIMIT 500",
		)
		.all(sid) as { t: string | null; input: string | null }[];
	for (const r of rows) {
		if (!r.t || !SHELL_TOOLS.has(r.t)) continue;
		const h = commandHead(r.input);
		if (h) out.set(h, (out.get(h) ?? 0) + 1);
	}
	return out;
}

/** The project's recurring command set (≥ min sessions) → a script node;
 *  a changed set goes through the Kev gate as a decant candidate entry. */
async function projectScript(
	ctx: JobContext,
	projectNode: number,
	projectPath: string,
	sessionKey: string,
): Promise<string> {
	const dc = ctx.decant;
	if (!dc) return "none";
	const sessions = dc
		.query(
			"SELECT s.id FROM session s JOIN project p ON p.id = s.project_id WHERE p.path = ? ORDER BY s.id DESC LIMIT 200",
		)
		.all(projectPath) as { id: number }[];
	const seen = new Map<string, number>();
	for (const s of sessions)
		for (const h of sessionCommands(dc, s.id).keys())
			seen.set(h, (seen.get(h) ?? 0) + 1);
	const min = ctx.cfg.decant_script_min_sessions;
	const commands = [...seen.entries()]
		.filter(([, c]) => c >= min)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, 10);
	if (commands.length < 2) return "none";
	const pKey = projectKey(projectPath);
	const hash = sha(commands.map(([h]) => h).join("\n"));
	const now = ctx.now();
	const scriptId = upsertNode(
		ctx.db,
		{
			kind: "script",
			key: `script:${pKey}`,
			label: `recurring commands (${String(commands.length)})`,
			hash,
			props: {
				...DECANT_PROPS,
				commands: commands.map(([h, c]) => ({ h, sessions: c })),
			},
		},
		now,
	);
	edge(ctx, scriptId, projectNode, "about");
	for (const [h, c] of commands) {
		const cid = upsertNode(
			ctx.db,
			{ kind: "command", key: h, props: DECANT_PROPS },
			now,
		);
		edge(ctx, cid, scriptId, "part_of", c);
	}
	const sig = `decant:${hash}`;
	if (ctx.db.query("SELECT 1 FROM distill_clusters WHERE sig = ?").get(sig))
		return "seen";
	const label =
		(
			ctx.db
				.query("SELECT label FROM kg_nodes WHERE id = ?")
				.get(projectNode) as {
				label: string;
			} | null
		)?.label || pKey;
	const fact = scrubbed(
		`Recurring commands in ${label} across ${String(sessions.length)} recent sessions: ${commands.map(([h, c]) => `${h} (${String(c)})`).join("; ")}`,
	);
	const topic = scrubbed(`decant workflow: ${label}`);
	const kev = await ctx.sink.kev({
		kind: "capsule",
		title: topic,
		text: fact,
		reference: sig.slice(0, 40),
	});
	if (kev.choice === "unavailable") return "kev-unavailable";
	if (kev.choice === "noise") {
		ctx.db
			.query(
				"INSERT OR REPLACE INTO distill_clusters (sig, state, knowledge_id, draft, at) VALUES (?, 'noise', NULL, NULL, ?)",
			)
			.run(sig, now);
		return "noise";
	}
	const id = await ctx.sink.upsertCandidate({
		topic,
		fact,
		confidence: 0.4,
		originKind: "decant",
		sourceRef: `decant:session:${sessionKey.replace(/^decant:/, "")}`,
		provenance: { source_refs: [sessionKey, `script:${pKey}`], by: "decant" },
	});
	ctx.db
		.query(
			"INSERT OR REPLACE INTO distill_clusters (sig, state, knowledge_id, draft, at) VALUES (?, 'stored', ?, NULL, ?)",
		)
		.run(sig, id, now);
	return `candidate:${String(id)}`;
}
