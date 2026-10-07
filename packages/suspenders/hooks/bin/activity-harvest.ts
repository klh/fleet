// hooks/bin/activity-harvest.ts — W243: the standing decant-shape token-
// activity meter. Turns the W111 one-shot /tmp classifier into an in-repo
// instrument: mines the same ~/.claude/projects/**/*.jsonl transcripts as
// usage-harvest (W127 tail discipline, own `activity.tp.*` cursor namespace)
// and classifies every assistant API message into decant's four activity
// buckets — context (reads/searches/orchestration/unknown tools), planning
// (thinking + todo/plan tools), code (Edit/Write + mutating shell,
// unrecognized shell conservative → code), communicating (visible text).
// Aggregates land in governor.db's activity_rollup with UPSERT-ADD
// semantics, one row per (week_bucket, actor, model_group, activity).
//
// RequestId dedup contract: journals can carry several rows per assistant
// message.id (stream snapshots/retries). Each id is counted once at its
// largest-output snapshot, streaming-style: the first sighting aggregates
// in full, a later sighting aggregates only the growth (per-field
// max(new − stored, 0)). Residual, documented: duplicates straddling a tick
// boundary (pass ends between two rows of one id) double-count that row's
// delta — one row per tick at worst, bounded by how journals write.
// Search counts ride the context row by contract (a search is orientation
// work by definition), normalized per-request at report time.
//
// Input side follows decant's context-window-volume basis: each message's
// input/cache tokens are allocated across the user-role content volume
// accumulated so far (tool results ride the bucket of the tool_use that
// produced them), with a one-time seed for the journal-invisible system
// prompt and a volume reset on compaction markers. Output is split across
// content blocks by chars. Pricing shape (in 1x / cache-write 1.25x /
// cache-read 0.1x / out 5x) is report-time only — stored columns stay raw
// tokens. Library + thin CLI; runs as a board-API subroutine behind its own
// TTL gate (same harvest_ttl_s knob), never a daemon.
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { readBoardSettings } from "../lib/board-config.ts";
import {
	cursorKey,
	loadCursor,
	readTail,
	saveCursor,
} from "../lib/transcript-cursor.ts";
import { modelGroup, type ModelGroup } from "./usage-harvest.ts";

// ─── decant shape: buckets, axis, pricing ──────────────────────────────────
export const ACTIVITIES = [
	"context",
	"planning",
	"code",
	"communicating",
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** Orientation-vs-implementation axis: figuring out vs making real. */
export type Axis = "orient" | "implement";
export const AXIS: Record<Activity, Axis> = {
	context: "orient",
	planning: "orient",
	code: "implement",
	communicating: "implement",
};

/** Cost shape (decant/W111): relative weights per token class. */
export const PRICING = { in: 1, cacheC: 1.25, cacheR: 0.1, out: 5 } as const;

export interface ActUsage {
	in: number;
	out: number;
	cr: number;
	cc: number;
}

const zeroAct = (): Record<Activity, ActUsage> => ({
	context: { in: 0, out: 0, cr: 0, cc: 0 },
	planning: { in: 0, out: 0, cr: 0, cc: 0 },
	code: { in: 0, out: 0, cr: 0, cc: 0 },
	communicating: { in: 0, out: 0, cr: 0, cc: 0 },
});

// ─── tool classification ───────────────────────────────────────────────────
// (no reader set: unknown tools, mcp__*, and the named readers all default
// to context — W111's conservative rule is the fallthrough itself)
const PLANNING_TOOLS = new Set([
	"TodoWrite",
	"TaskCreate",
	"TaskGet",
	"TaskUpdate",
	"TaskList",
	"EnterPlanMode",
	"ExitPlanMode",
]);
const COMMS_TOOLS = new Set(["AskUserQuestion", "SendMessage"]);
const CODE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "bash"]);
const READONLY_SHELL =
	/^(rg|grep|ls|cat|head|tail|wc|find|fd|eza|bat|stat|file|du|df|which|whoami|date|pwd|echo|sleep|true|false|git (status|log|diff|show|branch|rev-parse|ls-files|remote|tag)|bun (test|pm ls|x --help)|node (-v|--version))\b/;
const SEARCH_TOOLS = new Set(["Grep", "Glob", "WebSearch", "ToolSearch"]);
const SEARCH_SHELL = /^(rg|grep|find|fd)\b/;

/** W111 method: recognized read-only shell → context; the rest → code. */
export function classifyTool(tool: string, input: unknown): Activity {
	if (SHELL_TOOLS.has(tool)) {
		const cmd =
			typeof (input as { command?: unknown })?.command === "string"
				? (input as { command: string }).command.trim()
				: "";
		return READONLY_SHELL.test(cmd) ? "context" : "code";
	}
	if (PLANNING_TOOLS.has(tool)) return "planning";
	if (COMMS_TOOLS.has(tool)) return "communicating";
	if (CODE_TOOLS.has(tool)) return "code";
	return "context"; // readers, mcp__*, unknown — W111 conservative default
}

const isSearch = (tool: string, input: unknown): boolean =>
	SEARCH_TOOLS.has(tool) ||
	(SHELL_TOOLS.has(tool) &&
		SEARCH_SHELL.test(
			typeof (input as { command?: unknown })?.command === "string"
				? (input as { command: string }).command.trim()
				: "",
		));

// ─── week bucket ───────────────────────────────────────────────────────────
/** Monday 00:00 UTC of the week containing ts. */
export function weekBucket(ts: number): number {
	const day = Math.floor(ts / 86_400_000);
	const dow = (new Date(day * 86_400_000).getUTCDay() + 6) % 7;
	return (day - dow) * 86_400_000;
}

// ─── harvest ───────────────────────────────────────────────────────────────
export interface ActivityHarvestStats {
	files: number;
	harvested: number;
	skipped: number;
	requests: number;
	searches: number;
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheC: number;
}

interface Snap {
	searches: number;
	byAct: Record<Activity, ActUsage>;
}

const n = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;
const max0 = (x: number): number => (x > 0 ? x : 0);

/** One-time seed for the journal-invisible system prompt (W111 §3.3). */
const SEED_CHARS = 60_000;
const WINDOW_DAYS = 14; // rolling recency gate: files older than this never open
const COMPACT_MARK = "continued from a previous conversation";

type Block = {
	type: string;
	text?: string;
	thinking?: string;
	data?: string;
	id?: string;
	name?: string;
	input?: unknown;
	content?: unknown;
	tool_use_id?: string;
};

/** Output-token split weights: chars per activity over a message's blocks. */
function blockChars(blocks: Block[]): Record<Activity, number> {
	const chars = { context: 0, planning: 0, code: 0, communicating: 0 };
	for (const b of blocks) {
		if (b.type === "tool_use")
			chars[classifyTool(b.name ?? "", b.input)] += JSON.stringify(
				b.input ?? null,
			).length;
		else if (b.type === "text") chars.communicating += (b.text ?? "").length;
		else if (b.type === "thinking") chars.planning += (b.thinking ?? "").length;
		else if (b.type === "redacted_thinking")
			chars.planning += (b.data ?? "").length;
	}
	return chars;
}

export function harvestActivity(
	db: Database,
	opts: { root?: string; nowMs?: number; windowDays?: number } = {},
): ActivityHarvestStats {
	const now = opts.nowMs ?? Date.now();
	const cutoff = now - (opts.windowDays ?? WINDOW_DAYS) * 86_400_000;
	const root = opts.root ?? `${process.env.HOME}/.claude/projects`;
	const out: ActivityHarvestStats = {
		files: 0,
		harvested: 0,
		skipped: 0,
		requests: 0,
		searches: 0,
		inTok: 0,
		outTok: 0,
		cacheR: 0,
		cacheC: 0,
	};
	const actorOf = new Map<string, { actor: string | null }>();
	for (const r of db
		.query("SELECT sid, actor FROM sessions WHERE actor IS NOT NULL")
		.all() as { sid: string; actor: string | null }[])
		actorOf.set(r.sid, { actor: r.actor });
	const upsert = db.query(
		"INSERT INTO activity_rollup (week_bucket, actor, model_group, activity, in_tok, out_tok, cache_r, cache_c, requests, searches) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(week_bucket, actor, model_group, activity) DO UPDATE SET in_tok = in_tok + excluded.in_tok, out_tok = out_tok + excluded.out_tok, cache_r = cache_r + excluded.cache_r, cache_c = cache_c + excluded.cache_c, requests = requests + excluded.requests, searches = searches + excluded.searches",
	);
	const add = new Map<
		string,
		{
			w: number;
			actor: string;
			group: ModelGroup;
			byAct: Record<
				Activity,
				ActUsage & { requests: number; searches: number }
			>;
		}
	>();
	const bump = (
		w: number,
		actor: string,
		group: ModelGroup,
		act: Activity,
		d: ActUsage,
		requests: number,
		searches: number,
	): void => {
		const key = `${w}\u0000${actor}\u0000${group}`;
		let r = add.get(key);
		if (!r) {
			r = {
				w,
				actor,
				group,
				byAct: {
					context: { in: 0, out: 0, cr: 0, cc: 0, requests: 0, searches: 0 },
					planning: { in: 0, out: 0, cr: 0, cc: 0, requests: 0, searches: 0 },
					code: { in: 0, out: 0, cr: 0, cc: 0, requests: 0, searches: 0 },
					communicating: {
						in: 0,
						out: 0,
						cr: 0,
						cc: 0,
						requests: 0,
						searches: 0,
					},
				},
			};
			add.set(key, r);
		}
		const row = r.byAct[act];
		row.in += d.in;
		row.out += d.out;
		row.cr += d.cr;
		row.cc += d.cc;
		row.requests += requests;
		row.searches += searches;
	};

	const glob = new Bun.Glob("**/*.jsonl");
	for (const rel of [...glob.scanSync({ cwd: root, onlyFiles: true })].sort()) {
		out.files++;
		const abs = join(root, rel);
		let size: number;
		let mtimeMs: number;
		try {
			const s = statSync(abs);
			size = s.size;
			mtimeMs = s.mtimeMs;
		} catch {
			continue; // vanished mid-scan — next pass catches the remainder
		}
		const key = cursorKey("activity.tp", abs);
		let cur = loadCursor(db, key);
		if (!cur && mtimeMs < cutoff) continue; // stale + never opened → out of window
		if (cur && size < cur.o) cur = null; // truncated → full re-read (rare)
		if (cur && size === cur.o && mtimeMs === cur.m) {
			out.skipped++;
			continue; // unchanged: the idempotency fast path
		}
		const start = cur?.o ?? 0;
		const text = readTail(abs, start);
		const nl = text.lastIndexOf("\n");
		if (nl === -1) {
			saveCursor(db, key, { o: start, m: mtimeMs }, "activity-harvest", now);
			continue; // no complete line in the tail — retry next pass
		}
		const body = text.slice(0, nl + 1);
		const next = start + nl + 1;

		// per-file pass state
		let volume: Record<Activity, number> = {
			context: SEED_CHARS,
			planning: 0,
			code: 0,
			communicating: 0,
		};
		const pending = new Map<string, Activity>(); // tool_use_id → bucket
		const snaps = new Map<string, Snap>(); // requestId dedup snapshots
		let lineSeq = 0;

		for (const line of body.split("\n")) {
			if (line.length < 2) continue;
			let e:
				| {
						type?: string;
						isCompactSummary?: boolean;
						timestamp?: string;
						message?: {
							id?: string;
							model?: string;
							usage?: Record<string, unknown>;
							content?: unknown;
						};
				  }
				| undefined;
			try {
				e = JSON.parse(line) as typeof e;
			} catch {
				continue;
			}
			if (!e || (e.type !== "assistant" && e.type !== "user")) continue;
			// compaction: the context-window basis resets, the summary text
			// becomes the new context volume
			if (e.isCompactSummary || lineIncludes(e, COMPACT_MARK)) {
				volume = {
					context: SEED_CHARS,
					planning: 0,
					code: 0,
					communicating: 0,
				};
				pending.clear();
			}
			const content = e.message?.content;
			if (e.type === "user") {
				// string content = plain user text → context
				if (typeof content === "string") {
					volume.context += content.length;
					continue;
				}
				if (!Array.isArray(content)) continue;
				for (const b of content as Block[]) {
					if (b.type === "tool_result") {
						const target = pending.get(b.tool_use_id ?? "") ?? "context";
						volume[target] += resultChars(b.content);
						pending.delete(b.tool_use_id ?? "");
					} else if (b.type === "text") {
						volume.context += (b.text ?? "").length;
					}
				}
				continue;
			}
			// assistant message: register tool_use → bucket for the pending map,
			// then aggregate usage through the requestId dedup contract
			const blocks = Array.isArray(content) ? (content as Block[]) : [];
			for (const b of blocks)
				if (b.type === "tool_use" && b.id)
					pending.set(b.id, classifyTool(b.name ?? "", b.input));
			const u = e.message?.usage;
			if (!u || !Number.isFinite(Date.parse(e.timestamp ?? ""))) continue;
			const ts = Date.parse(e.timestamp ?? "");
			const model = e.message?.model ?? "";
			const group = modelGroup(model);
			const actor =
				actorOf.get(basename(rel).replace(/\.jsonl$/, ""))?.actor ??
				readBoardSettings().settings.default_actor ??
				"unassigned";
			const w = weekBucket(ts);
			const uin = n(u.input_tokens);
			const uout = n(u.output_tokens);
			const ucr = n(u.cache_read_input_tokens);
			const ucc = n(u.cache_creation_input_tokens);
			out.requests++;
			out.inTok += uin;
			out.outTok += uout;
			out.cacheR += ucr;
			out.cacheC += ucc;

			// allocation
			const inAct = zeroAct();
			let total = 0;
			for (const a of ACTIVITIES) total += volume[a];
			for (const a of ACTIVITIES)
				if (total > 0) {
					const share = volume[a] / total;
					inAct[a].in = uin * share;
					inAct[a].cr = ucr * share;
					inAct[a].cc = ucc * share;
				}
			const outAct = zeroAct();
			const chars = blockChars(blocks);
			let charsTotal = 0;
			for (const a of ACTIVITIES) charsTotal += chars[a];
			let searches = 0;
			for (const b of blocks)
				if (b.type === "tool_use" && isSearch(b.name ?? "", b.input))
					searches++;
			out.searches += searches; // raw-row count; the rollup dedups growth-only
			if (charsTotal > 0)
				for (const a of ACTIVITIES)
					outAct[a].out = (uout * chars[a]) / charsTotal;
			else outAct.communicating.out = uout; // blockless stub → visible channel

			// requestId dedup: first sighting aggregates whole; later sightings
			// aggregate only the positive growth of the recomputed allocation vs
			// the stored snapshot (largest-output snapshot wins). Shares drift as
			// volume accumulates, so the comparison is allocation-vs-allocation —
			// never token-delta × new-share, which would double-subtract.
			lineSeq++;
			const id = e.message?.id || `\u0000seq${lineSeq}`;
			const prev = snaps.get(id);
			const alloc = mergeAlloc(inAct, outAct);
			if (prev) {
				for (const a of ACTIVITIES) {
					const pn = prev.byAct[a];
					bump(
						w,
						actor,
						group,
						a,
						{
							in: max0(alloc[a].in - pn.in),
							out: max0(alloc[a].out - pn.out),
							cr: max0(alloc[a].cr - pn.cr),
							cc: max0(alloc[a].cc - pn.cc),
						},
						0,
						a === "context" ? max0(searches - prev.searches) : 0,
					);
				}
			} else {
				// requests + searches ride the context row by contract (a request
				// and a search are orientation work; the other activity rows of
				// the same message stay count-silent so sums never 4×-count)
				for (const a of ACTIVITIES)
					bump(
						w,
						actor,
						group,
						a,
						alloc[a],
						a === "context" ? 1 : 0,
						a === "context" ? searches : 0,
					);
			}
			snaps.set(id, { searches, byAct: alloc });
		}
		saveCursor(db, key, { o: next, m: mtimeMs }, "activity-harvest", now);
		out.harvested++;
	}
	if (add.size) {
		db.run("BEGIN IMMEDIATE");
		try {
			for (const r of add.values())
				for (const a of ACTIVITIES) {
					const row = r.byAct[a];
					if (
						row.in + row.out + row.cr + row.cc + row.requests + row.searches ===
						0
					)
						continue;
					upsert.run(
						r.w,
						r.actor,
						r.group,
						a,
						Math.round(row.in),
						Math.round(row.out),
						Math.round(row.cr),
						Math.round(row.cc),
						row.requests,
						row.searches,
					);
				}
			db.run("COMMIT");
		} catch (err) {
			try {
				db.run("ROLLBACK");
			} catch {}
			throw err;
		}
	}
	return out;
}

// mergeAlloc + lineIncludes + resultChars helpers live below the harvest so
// the pass reads top-to-bottom
function mergeAlloc(
	inAct: Record<Activity, ActUsage>,
	outAct: Record<Activity, ActUsage>,
): Record<Activity, ActUsage> {
	const m = zeroAct();
	for (const a of ACTIVITIES)
		m[a] = {
			in: inAct[a].in,
			out: outAct[a].out,
			cr: inAct[a].cr,
			cc: inAct[a].cc,
		};
	return m;
}

function lineIncludes(
	e: { message?: { content?: unknown } },
	mark: string,
): boolean {
	const c = e.message?.content;
	if (typeof c === "string") return c.includes(mark);
	if (Array.isArray(c))
		for (const b of c as Block[])
			if (typeof b.text === "string" && b.text.includes(mark)) return true;
	return false;
}

function resultChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (Array.isArray(content)) {
		let sum = 0;
		for (const b of content as Block[])
			if (b.type === "text") sum += (b.text ?? "").length;
		return sum;
	}
	return 0;
}

// ─── TTL gate (board-API subroutine — never a daemon) ─────────────────────
let inFlight = false;
const defaultTtlMs = (): number => {
	const s = readBoardSettings().settings.harvest_ttl_s;
	return s && s >= 1 ? s * 1000 : 5 * 60_000;
};

export function maybeHarvestActivity(
	db: Database,
	ttlMs = defaultTtlMs(),
): ActivityHarvestStats | null {
	const row = db
		.query("SELECT value FROM facts WHERE key = 'activity.harvestAt'")
		.get() as { value: string | null } | null;
	const at = Number(row?.value ?? 0);
	if (inFlight || (Number.isFinite(at) && at > 0 && Date.now() - at < ttlMs))
		return null;
	inFlight = true;
	try {
		const s = harvestActivity(db);
		db.query(
			"INSERT INTO facts (key, value, source, ts) VALUES ('activity.harvestAt', ?, 'activity-harvest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
		).run(String(Date.now()), Date.now());
		return s;
	} catch (e) {
		console.error(
			`[activity-harvest] failed soft: ${e instanceof Error ? e.message : e}`,
		);
		return null;
	} finally {
		inFlight = false;
	}
}

// ─── report: weekly classify, context-share per lane, axis, searches ──────
export interface ActivityReport {
	weeks: number;
	fromWeek: number;
	toWeek: number;
	totals: {
		in: number;
		out: number;
		cr: number;
		cc: number;
		requests: number;
		searches: number;
		cost: number;
	};
	activities: Record<Activity, { tok: number; cost: number; share: number }>;
	axis: Record<Axis, { cost: number; share: number }>;
	weekly: {
		week: number;
		cost: number;
		shares: Record<Activity, number>;
		orientShare: number;
	}[];
	actors: {
		actor: string;
		requests: number;
		searches: number;
		searchesPerReq: number;
		cost: number;
		contextShare: number;
		orientShare: number;
	}[];
	pricing: { in: number; cacheC: number; cacheR: number; out: number };
}

export const shapeCost = (u: {
	in: number;
	out: number;
	cr: number;
	cc: number;
}): number =>
	u.in * PRICING.in +
	u.cc * PRICING.cacheC +
	u.cr * PRICING.cacheR +
	u.out * PRICING.out;

export function activityReport(
	db: Database,
	opts: { weeks?: number; nowMs?: number } = {},
): ActivityReport {
	const weeks = Math.min(26, Math.max(1, opts.weeks ?? 8));
	const now = opts.nowMs ?? Date.now();
	const toWeek = weekBucket(now);
	const fromWeek = toWeek - (weeks - 1) * 7 * 86_400_000;
	const rows = db
		.query(
			"SELECT week_bucket AS w, actor, activity AS a, SUM(in_tok) AS i, SUM(out_tok) AS o, SUM(cache_r) AS cr, SUM(cache_c) AS cc, SUM(requests) AS rq, SUM(searches) AS se FROM activity_rollup WHERE week_bucket >= ? AND week_bucket <= ? GROUP BY w, actor, a ORDER BY w",
		)
		.all(fromWeek, toWeek) as {
		w: number;
		actor: string;
		a: string;
		i: number;
		o: number;
		cr: number;
		cc: number;
		rq: number;
		se: number;
	}[];

	const activities = {
		context: { tok: 0, cost: 0, share: 0 },
		planning: { tok: 0, cost: 0, share: 0 },
		code: { tok: 0, cost: 0, share: 0 },
		communicating: { tok: 0, cost: 0, share: 0 },
	};
	const weekly = new Map<
		number,
		{
			week: number;
			cost: number;
			shares: Record<Activity, number>;
			orientShare: number;
		}
	>();
	for (let w = fromWeek; w <= toWeek; w += 7 * 86_400_000)
		weekly.set(w, {
			week: w,
			cost: 0,
			shares: { context: 0, planning: 0, code: 0, communicating: 0 },
			orientShare: 0,
		});
	const actorMap = new Map<
		string,
		{
			actor: string;
			requests: number;
			searches: number;
			cost: number;
			byAct: Record<Activity, { tok: number; cost: number }>;
		}
	>();
	const totals = {
		in: 0,
		out: 0,
		cr: 0,
		cc: 0,
		requests: 0,
		searches: 0,
		cost: 0,
	};
	for (const r of rows) {
		const u = {
			in: n(r.i),
			out: n(r.o),
			cr: n(r.cr),
			cc: n(r.cc),
		};
		const cost = shapeCost(u);
		const tok = u.in + u.out + u.cr + u.cc;
		const act = (ACTIVITIES as readonly string[]).includes(r.a)
			? (r.a as Activity)
			: null;
		if (!act) continue;
		totals.in += u.in;
		totals.out += u.out;
		totals.cr += u.cr;
		totals.cc += u.cc;
		totals.requests += n(r.rq);
		totals.searches += n(r.se);
		totals.cost += cost;
		activities[act].tok += tok;
		activities[act].cost += cost;
		const wk = weekly.get(n(r.w));
		if (wk) {
			wk.cost += cost;
			wk.shares[act] += cost;
		}
		let ar = actorMap.get(r.actor);
		if (!ar) {
			ar = {
				actor: r.actor,
				requests: 0,
				searches: 0,
				cost: 0,
				byAct: {
					context: { tok: 0, cost: 0 },
					planning: { tok: 0, cost: 0 },
					code: { tok: 0, cost: 0 },
					communicating: { tok: 0, cost: 0 },
				},
			};
			actorMap.set(r.actor, ar);
		}
		ar.requests += n(r.rq);
		ar.searches += n(r.se);
		ar.cost += cost;
		ar.byAct[act].tok += tok;
		ar.byAct[act].cost += cost;
	}
	// shares once the sums are final
	if (totals.cost > 0)
		for (const a of ACTIVITIES)
			activities[a].share = activities[a].cost / totals.cost;
	const axis: Record<Axis, { cost: number; share: number }> = {
		orient: { cost: 0, share: 0 },
		implement: { cost: 0, share: 0 },
	};
	for (const a of ACTIVITIES) axis[AXIS[a]].cost += activities[a].cost;
	if (totals.cost > 0)
		for (const ax of ["orient", "implement"] as const)
			axis[ax].share = axis[ax].cost / totals.cost;
	for (const wk of weekly.values()) {
		if (wk.cost > 0)
			for (const a of ACTIVITIES) wk.shares[a] = wk.shares[a] / wk.cost;
		wk.orientShare = wk.shares.context + wk.shares.planning;
	}
	const actors = [...actorMap.values()]
		.map((ar) => ({
			actor: ar.actor,
			requests: ar.requests,
			searches: ar.searches,
			searchesPerReq:
				ar.requests > 0
					? Math.round((ar.searches / ar.requests) * 100) / 100
					: 0,
			cost: ar.cost,
			contextShare: ar.cost > 0 ? ar.byAct.context.cost / ar.cost : 0,
			orientShare:
				ar.cost > 0
					? (ar.byAct.context.cost + ar.byAct.planning.cost) / ar.cost
					: 0,
		}))
		.sort((x, y) => y.cost - x.cost);
	return {
		weeks,
		fromWeek,
		toWeek,
		totals,
		activities,
		axis,
		weekly: [...weekly.values()],
		actors,
		pricing: { ...PRICING },
	};
}

// CLI: bun hooks/bin/activity-harvest.ts [--force] [--weeks N]
// (--root splice-reason: governor flag on out-of-band bun-splice, re-read done —
// dropping the dead --root pretense so the CLI matches maybeHarvestActivity)
if (import.meta.main) {
	// CLI-only, lazy: the library must not bind an un-busted govdb module
	// entry at import time — that entry is what in-process suites share
	// (settle.ts loads it un-busted too; a top-level bind here poisons w159
	// settle tests with the wrong REG).
	const { openGovernorDb } = await import("../lib/govdb.ts");
	const db = openGovernorDb();
	const force = process.argv.includes("--force");
	const wflag = process.argv.indexOf("--weeks");
	const weeks =
		wflag > 0 && process.argv[wflag + 1]
			? Number(process.argv[wflag + 1])
			: undefined;
	const s = maybeHarvestActivity(db, force ? 0 : undefined);
	console.log(
		JSON.stringify({
			harvest: s,
			meter: activityReport(db, { weeks: weeks ?? 8 }),
		}),
	);
}
