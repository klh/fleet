// hooks/lib/work-timing.ts — W15 lane wall-time + W24 per-item token
// usage, replayed from the events bus. W603: moved verbatim out of govdb.ts
// (1500-line law) and the project filter rides the SHREDED column (v14:
// events.project, trigger-stamped from payload $.project) — the per-row
// json_extract scan the DuckDB-2.0 finding measured is gone.
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";

// W15 — lane-level wall-time metric. Per-item claim→done is distorted when a
// lane works items back-to-back (serialized multi-claims), so replay the Work
// Graph bus events instead of trusting item timestamps: wall = first claim →
// terminal event, agent = Σ closed claim segments. Derived from EXISTING
// events (work.claimed / work.released / work.done / work.failed all carry
// work+project+ts) — no schema, no migration.
export interface ItemTiming {
	project: string;
	work: string;
	firstClaim: number; // first claim of the CURRENT cycle (W895; 0 = no live cycle)
	lastEvent: number; // last observed event ts (nowMs while still open)
	wallMs: number; // lastEvent − current-cycle firstClaim (0 when no live cycle)
	agentMs: number; // Σ current-cycle claim segments; open segment counts to nowMs
	claims: number;
	releases: number;
	done: boolean;
	failed: boolean;
	priorAgentMs: number; // W895 kept segments from released/superseded cycles
	priorCycles: number; // W895 how many cycles a release/supersede ended
	priorSinceMs: number; // W895 first claim of the earliest prior cycle (0 = none)
	running: boolean; // W895 open claim segment (CLAIMED/RUNNING — clock live)
}

// W682 — the claim-replay event shape: callers that batch the bus read for
// MANY projects (the board's /api/tasks attribution map) preload one scan and
// pass it here, replacing the two per-project scans the replay used to pay.
export interface TimingEventRow {
	project: string;
	id: number;
	ts: number;
	kind: string;
	payload: string | null;
}
// W895: the replay scans the lifecycle kinds — the terminal ones close claim
// segments/cycles too (supersede/cancel used to leave windows open forever).
// Exported so preloading callers (board data.ts) scan the same set.
export const TIMING_KINDS =
	"('work.claimed','work.released','work.done','work.failed','work.superseded','work.cancelled')";

// W895 — flush the current claim cycle into the kept (prior) split and reset
// the clock: firstClaim 0 until a fresh claim opens the next cycle.
function endCycle(
	t: ItemTiming,
	work: string,
	cycle: Map<string, { start: number; agent: number }>,
): void {
	const c = cycle.get(work);
	if (c) {
		t.priorAgentMs += c.agent;
		t.priorCycles++;
		if (!t.priorSinceMs) t.priorSinceMs = c.start;
	}
	cycle.delete(work);
	t.firstClaim = 0;
}

// Replay one project's work events chronologically. A work.claimed opens a
// claim segment; the next work.released / work.done / work.failed closes it
// (that duration is agent time). Items never claimed (auto-rollup parents)
// get wallMs 0 — there is no claim→done interval to measure.
//
// W895 ghost clock: a release/supersede/cancel ENDS the claim cycle. wall +
// agent then measure the NEXT (fresh) claim's window only; the spent cycles
// are kept split (priorAgentMs/priorCycles) instead of masquerading as the
// current clock — a 17-day-old ghost claim no longer reads as item spend
// forever. work.done closes the item but leaves the cycle current, so DONE
// items keep their final claim→done interval.
export function workTiming(
	db: Database,
	project: string,
	nowMs = Date.now(),
	pre?: TimingEventRow[],
): ItemTiming[] {
	const rows = pre
		? pre.filter((r) => r.project === project)
		: (db
				.query(
					`SELECT id, ts, kind, payload FROM events WHERE kind IN ${TIMING_KINDS} AND project = ? ORDER BY ts, id`,
				)
				.all(project) as {
				id: number;
				ts: number;
				kind: string;
				payload: string | null;
			}[]);
	const open = new Map<string, number>(); // work id → open claim-segment start ts
	const cycle = new Map<string, { start: number; agent: number }>(); // W895 current cycle
	const out = new Map<string, ItemTiming>();
	const item = (work: string): ItemTiming => {
		let t = out.get(work);
		if (!t) {
			t = {
				project,
				work,
				firstClaim: 0,
				lastEvent: 0,
				wallMs: 0,
				agentMs: 0,
				claims: 0,
				releases: 0,
				done: false,
				failed: false,
				priorAgentMs: 0,
				priorCycles: 0,
				priorSinceMs: 0,
				running: false,
			};
			out.set(work, t);
		}
		return t;
	};
	for (const r of rows) {
		let work = "";
		try {
			work = (JSON.parse(r.payload ?? "{}") as { work?: string }).work ?? "";
		} catch {}
		if (!work) continue;
		const t = item(work);
		if (r.kind === "work.claimed") {
			t.claims++;
			if (!cycle.has(work)) {
				cycle.set(work, { start: r.ts, agent: 0 });
				t.firstClaim = r.ts;
			}
			open.set(work, r.ts);
		} else {
			const start = open.get(work);
			if (start != null) {
				const c = cycle.get(work);
				if (c) c.agent += Math.max(0, r.ts - start);
				open.delete(work);
				t.releases++;
			}
			if (r.kind === "work.done") t.done = true;
			if (r.kind === "work.failed") t.failed = true;
			t.lastEvent = r.ts;
			// W895 — release/supersede/cancel ends the claim cycle: the clock
			// resets to the fresh claim's window; spent cycles stay kept (split).
			if (
				r.kind === "work.released" ||
				r.kind === "work.superseded" ||
				r.kind === "work.cancelled"
			)
				endCycle(t, work, cycle);
		}
	}
	for (const [work, start] of open) {
		const t = item(work);
		const c = cycle.get(work);
		if (c) c.agent += Math.max(0, nowMs - start);
		t.lastEvent = nowMs;
		t.running = true;
	}
	for (const [work, c] of cycle) {
		const t = item(work);
		t.agentMs = c.agent;
		t.wallMs = (t.lastEvent || nowMs) - c.start;
	}
	return [...out.values()].sort((a, b) => (a.work < b.work ? -1 : 1));
}

// W635 — claim windows per item, replayed from the same bus events as
// workTiming/tokenUsage: each work.claimed (payload `by` = owner sid) opens
// [claim → closing work.released/done/failed], open claims run to nowMs.
// Claims without a `by` get sid "" (no spend matches them).
export interface ClaimWindow {
	sid: string;
	start: number;
	end: number; // 0 = still open
}

export interface ClaimReplay {
	windows: Map<string, ClaimWindow[]>;
	done: Set<string>;
}

export function claimWindows(
	db: Database,
	project: string,
	nowMs = Date.now(),
	pre?: TimingEventRow[],
): ClaimReplay {
	const rows = pre
		? pre.filter((r) => r.project === project)
		: (db
				.query(
					`SELECT id, ts, kind, payload FROM events WHERE kind IN ${TIMING_KINDS} AND project = ? ORDER BY ts, id`,
				)
				.all(project) as {
				id: number;
				ts: number;
				kind: string;
				payload: string | null;
			}[]);
	const windows = new Map<string, ClaimWindow[]>();
	const done = new Set<string>();
	for (const r of rows) {
		let p: { work?: string; by?: string } = {};
		try {
			p = JSON.parse(r.payload ?? "{}") as { work?: string; by?: string };
		} catch {}
		if (!p.work) continue;
		if (r.kind === "work.claimed") {
			if (!windows.has(p.work)) windows.set(p.work, []);
			windows.get(p.work)?.push({ sid: p.by ?? "", start: r.ts, end: 0 });
		} else {
			const w = windows.get(p.work)?.find((x) => x.end === 0); // claims close in order (FIFO)
			if (w) w.end = r.ts;
			if (r.kind === "work.done") done.add(p.work);
		}
	}
	for (const ws of windows.values())
		for (const w of ws) if (!w.end) w.end = nowMs; // open claims run to nowMs
	return { windows, done };
}

// W24 — usage per task. APPROXIMATION: a transcript shared across items (one
// session working several items serially) is attributed by claim-window
// overlap in time, not causality. Windows replay from the same bus events as
// workTiming: each work.claimed (payload `by` = owner sid) opens
// [claim → closing work.released/done/failed], open claims run to nowMs;
// multiple claims = sum of windowed sums. sid → sessions.transcript_path;
// no resolvable transcript ⇒ null (rendered '-', never 0). Fresh parses
// cache per (project, item) in facts (`metrics.tokens.<proj>.<id>`,
// version-incremented, keyed by transcript mtime) — a DONE item skips
// re-parse while its transcript is unchanged. Transcript errors fail soft.
export interface ItemTokens {
	work: string;
	in: number; // Σ input_tokens (prompt, minus cache reads/creation)
	out: number; // Σ output_tokens
	cacheR: number; // Σ cache_read_input_tokens
	cacheC: number; // Σ cache_creation_input_tokens
}

export function tokenUsage(
	db: Database,
	project: string,
	nowMs = Date.now(),
): Map<string, ItemTokens | null> {
	const { windows: wins, done } = claimWindows(db, project, nowMs);
	const out = new Map<string, ItemTokens | null>();
	for (const [work, ws] of wins) {
		out.set(work, null); // default: unresolvable → rendered '-', never 0
		try {
			const paths = new Set<string>();
			for (const sid of new Set(ws.map((w) => w.sid).filter((s) => s !== ""))) {
				const tp = (
					db
						.query("SELECT transcript_path FROM sessions WHERE sid = ?")
						.get(sid) as { transcript_path?: string | null } | undefined
				)?.transcript_path;
				if (tp) paths.add(tp);
			}
			if (!paths.size) continue;
			let maxM = 0;
			for (const tp of paths) maxM = Math.max(maxM, statSync(tp).mtimeMs); // missing file throws → fail soft below
			const key = `metrics.tokens.${project.replace(/[^A-Za-z0-9._-]/g, "-")}.${work}`;
			const cached = JSON.parse(
				(
					db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
						value?: string;
					} | null
				)?.value ?? "null",
			) as {
				in: number;
				out: number;
				cacheR: number;
				cacheC: number;
				at: number;
				tpMtime: number;
			} | null;
			if (done.has(work) && cached?.tpMtime === maxM) {
				// cache hit: item terminal and transcript untouched since last parse
				out.set(work, {
					work,
					in: cached.in,
					out: cached.out,
					cacheR: cached.cacheR,
					cacheC: cached.cacheC,
				});
				continue;
			}
			const t: ItemTokens = { work, in: 0, out: 0, cacheR: 0, cacheC: 0 };
			const n = (x: unknown): number =>
				typeof x === "number" && Number.isFinite(x) ? x : 0;
			for (const tp of paths) {
				for (const line of readFileSync(tp, "utf8").split("\n")) {
					if (!line.includes('"type":"assistant"')) continue; // cheap pre-filter — only assistant lines carry usage
					let ts = NaN;
					let u: Record<string, unknown> | undefined;
					try {
						const o = JSON.parse(line) as {
							timestamp?: string;
							message?: { usage?: Record<string, unknown> };
						};
						ts = Date.parse(o.timestamp ?? "");
						u = o.message?.usage;
					} catch {}
					if (!u || !Number.isFinite(ts)) continue;
					if (!ws.some((w) => ts >= w.start && ts <= (w.end || nowMs)))
						continue;
					t.in += n(u.input_tokens);
					t.out += n(u.output_tokens);
					t.cacheR += n(u.cache_read_input_tokens);
					t.cacheC += n(u.cache_creation_input_tokens);
				}
			}
			out.set(work, t);
			db.query(
				"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'coord', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
			).run(
				key,
				JSON.stringify({
					in: t.in,
					out: t.out,
					cacheR: t.cacheR,
					cacheC: t.cacheC,
					at: nowMs,
					tpMtime: maxM,
				}),
				nowMs,
			);
		} catch {
			// fail soft: a bad/missing transcript never blocks metrics
		}
	}
	return out;
}
