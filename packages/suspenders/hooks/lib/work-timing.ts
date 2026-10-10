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
	firstClaim: number; // first work.claimed ts (0 = never claimed, e.g. auto-rollup)
	lastEvent: number; // last observed event ts (nowMs while still open)
	wallMs: number; // lastEvent − firstClaim (0 when never claimed)
	agentMs: number; // Σ claim segments; an open segment counts up to nowMs
	claims: number;
	releases: number;
	done: boolean;
	failed: boolean;
}

// Replay one project's work events chronologically. A work.claimed opens a
// claim segment; the next work.released / work.done / work.failed closes it
// (that duration is agent time). Items never claimed (auto-rollup parents)
// get wallMs 0 — there is no claim→done interval to measure.
export function workTiming(
	db: Database,
	project: string,
	nowMs = Date.now(),
): ItemTiming[] {
	const rows = db
		.query(
			"SELECT id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') AND project = ? ORDER BY ts, id",
		)
		.all(project) as {
		id: number;
		ts: number;
		kind: string;
		payload: string | null;
	}[];
	const open = new Map<string, number>(); // work id → open claim-segment start ts
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
			if (!t.firstClaim) t.firstClaim = r.ts;
			open.set(work, r.ts);
		} else {
			const start = open.get(work);
			if (start != null) {
				t.agentMs += Math.max(0, r.ts - start);
				open.delete(work);
				t.releases++;
			}
			if (r.kind === "work.done") t.done = true;
			if (r.kind === "work.failed") t.failed = true;
			t.lastEvent = r.ts;
		}
	}
	for (const [work, start] of open) {
		const t = item(work);
		t.agentMs += Math.max(0, nowMs - start);
		t.lastEvent = nowMs;
	}
	for (const t of out.values())
		if (t.firstClaim) t.wallMs = t.lastEvent - t.firstClaim;
	return [...out.values()].sort((a, b) => (a.work < b.work ? -1 : 1));
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
	const rows = db
		.query(
			"SELECT id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') AND project = ? ORDER BY ts, id",
		)
		.all(project) as {
		id: number;
		ts: number;
		kind: string;
		payload: string | null;
	}[];
	const wins = new Map<string, { start: number; end: number }[]>(); // work id → claim windows (end 0 = still open)
	const sids = new Map<string, string[]>();
	const done = new Set<string>();
	for (const r of rows) {
		let p: { work?: string; by?: string } = {};
		try {
			p = JSON.parse(r.payload ?? "{}") as { work?: string; by?: string };
		} catch {}
		if (!p.work) continue;
		if (r.kind === "work.claimed") {
			if (!wins.has(p.work)) wins.set(p.work, []);
			wins.get(p.work)?.push({ start: r.ts, end: 0 });
			if (p.by) {
				const arr = sids.get(p.work) ?? [];
				arr.push(p.by);
				sids.set(p.work, arr);
			}
		} else {
			const w = wins.get(p.work)?.find((x) => x.end === 0); // claims close in order (FIFO)
			if (w) w.end = r.ts;
			if (r.kind === "work.done") done.add(p.work);
		}
	}
	const out = new Map<string, ItemTokens | null>();
	for (const [work, ws] of wins) {
		out.set(work, null); // default: unresolvable → rendered '-', never 0
		try {
			const paths = new Set<string>();
			for (const sid of sids.get(work) ?? []) {
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
