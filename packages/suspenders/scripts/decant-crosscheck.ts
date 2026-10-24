#!/usr/bin/env bun
// decant-crosscheck.ts — W943 bench-validity audit: decant's independent
// transcript parse (~/.decant/decant.db) vs the W776 attribution pipeline
// (buckle ledger router_usage ⋈ work-graph claim windows). Read-only on
// every store. What it answers: do the fleet report's TOKENS/CACHE/OUT
// columns agree with what the transcripts themselves record?
//
//   bun scripts/decant-crosscheck.ts [--days 7] [--by-sid] [--session <prefix>]
//       [--project <graph-project-id>]
//
// Join: top-level sessions (subagent subtrees rolled up) pair with a claim
// window by max time overlap, restricted to sids that actually exist in the
// ledger (open windows of foreign sids span everything). Gateway hour
// buckets attribute to the maximally-overlapping session of the same sid;
// buckets with no session land in the unmatched pool — that pool is the
// drift signal (belt-direct traffic, non-transcript lanes, stale keys).
//
// Exit: 0 = rendered · 3 = a store is missing (decant index absent — run
// `decant sync` first).
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
	laneSpendRows,
	resolveBuckleDb,
} from "../hooks/lib/lanes/lane-spend.ts";
import { claimWindows } from "../hooks/lib/work/work-timing.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);

const DAYS = Number(arg("days") ?? 7);
const BY_SID = flag("by-sid");
const SESSION = arg("session");
const PROJECT = arg("project") ?? projectIdentity();
const HOME = process.env.HOME ?? "";
const now = Date.now();
const cutoff = now - DAYS * 86_400_000;

const fmtK = (n: number): string =>
	n >= 1e6
		? `${(n / 1e6).toFixed(2)}M`
		: n >= 1e4
			? `${Math.round(n / 1e3)}k`
			: `${n}`;
const dur = (ms: number): string => `${Math.round(ms / 60_000)}m`;
const iso = (ms: number): string => new Date(ms).toISOString();

// --- stores (read-only, all three) ----------------------------------------
const decantPath = `${HOME}/.decant/decant.db`;
const govPath = `${HOME}/.cache/claude-governor/governor.db`;
if (!existsSync(decantPath)) {
	console.error(`decant index missing at ${decantPath} — run: decant sync`);
	process.exit(3);
}
if (!existsSync(govPath)) {
	console.error(`governor.db missing at ${govPath}`);
	process.exit(3);
}
const dec = new Database(decantPath, { readonly: true });
const gov = new Database(govPath, { readonly: true });
const ledger = resolveBuckleDb();

// --- claim windows (graph side) -------------------------------------------
type Win = { work: string; sid: string; start: number; end: number };
const windows: Win[] = [];
const replay = claimWindows(gov, PROJECT, now);
for (const [work, ws] of replay.windows) {
	for (const w of ws)
		windows.push({ work, sid: w.sid, start: w.start, end: w.end || now });
}

// --- ledger rows (W776 side) ----------------------------------------------
const rows = ledger
	? laneSpendRows(ledger, `${new Date(cutoff).toISOString().slice(0, 13)}:00`)
	: [];
const ledgerSids = new Set(rows.map((r) => r.sid));

// --- decant sessions (transcript side, project-scoped) --------------------
type Sess = {
	id: number;
	src: string;
	start: number;
	end: number;
	in: number;
	out: number;
	cacheR: number;
	cacheC: number;
	cost: number;
	sub: number;
	parent: number | null;
	path: string;
};
type Top = Sess & {
	sid?: string;
	works: Set<string>;
	rIn: number;
	rOut: number;
	rCR: number;
	rCC: number;
	rCost: number;
	kids: number;
	gIn: number;
	gOut: number;
	gCR: number;
	gCC: number;
};
const root = PROJECT.replace(/\/\.git$/, "");
const sessions = (
	dec
		.query(
			`SELECT s.id, s.source_session_id src, s.started_at, s.ended_at,
			  s.total_input_tokens i, s.total_output_tokens o,
			  s.total_cache_read_tokens cr, s.total_cache_creation_tokens cc,
			  s.estimated_cost_usd cost, s.is_subagent sub, s.parent_session_id parent,
			  p.path
			 FROM session s JOIN project p ON p.id = s.project_id
			 WHERE (p.path = ? OR p.path LIKE ?) AND s.started_at >= ?`,
		)
		.all(root, `${root}/.worktrees/%`, iso(cutoff)) as Array<
		Record<string, unknown>
	>
).map((r) => ({
	id: Number(r.id),
	src: String(r.src),
	start: Date.parse(String(r.started_at)),
	end: r.ended_at ? Date.parse(String(r.ended_at)) : now,
	in: Number(r.i),
	out: Number(r.o),
	cacheR: Number(r.cr),
	cacheC: Number(r.cc),
	cost: Number(r.cost),
	sub: Number(r.sub),
	parent: r.parent === null ? null : Number(r.parent),
	path: String(r.path ?? ""),
}));

// roll subagent subtrees into their top-level ancestor
const byId = new Map(sessions.map((s) => [s.id, s]));
const roll = new Map<number, Top>();
for (const s of sessions) {
	if (s.sub === 0)
		roll.set(s.id, {
			...s,
			works: new Set(),
			rIn: 0,
			rOut: 0,
			rCR: 0,
			rCC: 0,
			rCost: 0,
			kids: 0,
			gIn: 0,
			gOut: 0,
			gCR: 0,
			gCC: 0,
		});
}
const topOf = (s: Sess): number | null => {
	let cur = s;
	const seen = new Set<number>();
	while (cur.sub !== 0 && cur.parent !== null && !seen.has(cur.parent)) {
		seen.add(cur.parent);
		const p = byId.get(cur.parent);
		if (!p) return null; // parent outside the window — not attributable
		cur = p;
	}
	return cur.sub === 0 ? cur.id : null;
};
for (const s of sessions) {
	const top = s.sub === 0 ? s.id : topOf(s);
	const t = top !== null ? roll.get(top) : undefined;
	if (!t) continue;
	t.rIn += s.in;
	t.rOut += s.out;
	t.rCR += s.cacheR;
	t.rCC += s.cacheC;
	t.rCost += s.cost;
	if (s.sub !== 0) t.kids += 1;
}

// --- sid per top-level session: the item id parsed from the worktree path
// is the primary join (stale open windows of other lanes tie-steal);
// windows of THAT item then supply the sid, ledger-known sids only.
const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
	Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
for (const t of roll.values()) {
	const m = t.path.match(/\/\.worktrees\/(W[\d.]+)\/?$/);
	const item = m ? m[1] : null;
	if (item) t.works.add(item);
	let best: { sid: string; ov: number } | null = null;
	for (const w of windows) {
		if (!ledgerSids.has(w.sid)) continue; // open windows of foreign sids lie
		if (item && w.work !== item) continue; // never steal across items
		const ov = overlap(t.start, t.end, w.start, w.end);
		if (ov <= 0) continue;
		if (!best || ov > best.ov) best = { sid: w.sid, ov };
		if (best && best.sid === w.sid) t.works.add(w.work);
	}
	t.sid = best?.sid;
}

// --- gateway buckets → maximally-overlapping session of the same sid ------
const sidSess = new Map<string, Top[]>();
for (const t of roll.values()) {
	if (!t.sid) continue;
	const arr = sidSess.get(t.sid);
	if (arr) arr.push(t);
	else sidSess.set(t.sid, [t]);
}
const unmatched = { in: 0, out: 0, cached: 0, req: 0 };
for (const r of rows) {
	const bStart = Date.parse(`${r.bucket}:00Z`);
	const bEnd = bStart + 3_600_000;
	let best: Top | null = null;
	let bestOv = 0;
	for (const t of sidSess.get(r.sid) ?? []) {
		const ov = overlap(bStart, bEnd, t.start, t.end);
		if (ov > bestOv) {
			bestOv = ov;
			best = t;
		}
	}
	if (best && bestOv > 0) {
		best.gIn += r.inTok;
		best.gOut += r.outTok;
		best.gCR += r.cacheR;
		best.gCC += r.cacheC;
	} else {
		unmatched.in += r.inTok;
		unmatched.out += r.outTok;
		unmatched.cached += r.cacheR + r.cacheC;
		unmatched.req += r.requests;
	}
}

// --- render ----------------------------------------------------------------
const tops = [...roll.values()].sort((a, b) => a.start - b.start);
if (SESSION) {
	const t = tops.find((x) => x.src.startsWith(SESSION));
	if (!t) {
		console.log(`no session ${SESSION}`);
		process.exit(4);
	}
	console.log(JSON.stringify(t, null, 1));
} else if (BY_SID) {
	const agg = new Map<
		string,
		{
			gIn: number;
			gOut: number;
			gC: number;
			rIn: number;
			rOut: number;
			rC: number;
			cost: number;
			n: number;
		}
	>();
	for (const t of tops) {
		const k = t.sid ?? "(no-ledger-sid)";
		const a = agg.get(k) ?? {
			gIn: 0,
			gOut: 0,
			gC: 0,
			rIn: 0,
			rOut: 0,
			rC: 0,
			cost: 0,
			n: 0,
		};
		a.gIn += t.gIn;
		a.gOut += t.gOut;
		a.gC += t.gCR + t.gCC;
		a.rIn += t.rIn;
		a.rOut += t.rOut;
		a.rC += t.rCR + t.rCC;
		a.cost += t.rCost;
		a.n += 1;
		agg.set(k, a);
	}
	console.log(
		"sid                                      ses  | W776 f/c/o                  | decant f/c/o                 | dTot",
	);
	const sorted = [...agg.entries()].sort(
		(x, y) => y[1].gC + y[1].gIn + y[1].gOut - (x[1].gC + x[1].gIn + x[1].gOut),
	);
	for (const [sid, a] of sorted) {
		const g = a.gIn + a.gOut + a.gC;
		const d = a.rIn + a.rOut + a.rC;
		const delta = g > 0 ? `${Math.round(((d - g) / g) * 100)}%` : "-";
		console.log(
			`${sid.padEnd(40)} ${String(a.n).padStart(3)} | ${fmtK(a.gIn).padStart(8)} ${fmtK(a.gC).padStart(9)} ${fmtK(a.gOut).padStart(8)} | ${fmtK(a.rIn).padStart(8)} ${fmtK(a.rC).padStart(9)} ${fmtK(a.rOut).padStart(8)} | ${delta.padStart(6)}`,
		);
	}
} else {
	console.log(
		"session    item        sid            | W776 f/c/o                | decant f/c/o              | dTot   cost",
	);
	for (const t of tops) {
		const gTot = t.gIn + t.gOut + t.gCR + t.gCC;
		const dTot = t.rIn + t.rOut + t.rCR + t.rCC;
		const delta =
			gTot > 0 ? `${Math.round(((dTot - gTot) / gTot) * 100)}%` : "-";
		console.log(
			`${t.src.slice(0, 8)} ${[...t.works].sort().join(",").padEnd(10)} ${(t.sid ?? "-").slice(0, 13).padEnd(13)} | ${fmtK(t.gIn).padStart(7)} ${fmtK(t.gCR + t.gCC).padStart(8)} ${fmtK(t.gOut).padStart(7)} | ${fmtK(t.rIn).padStart(7)} ${fmtK(t.rCR + t.rCC).padStart(8)} ${fmtK(t.rOut).padStart(7)} | ${delta.padStart(6)} $${t.rCost.toFixed(2)}`,
		);
	}
}
const gT = tops.reduce(
	(a, t) => ({ i: a.i + t.gIn, o: a.o + t.gOut, c: a.c + t.gCR + t.gCC }),
	{ i: 0, o: 0, c: 0 },
);
const dT = tops.reduce(
	(a, t) => ({ i: a.i + t.rIn, o: a.o + t.rOut, c: a.c + t.rCR + t.rCC }),
	{ i: 0, o: 0, c: 0 },
);
const cost = tops.reduce((a, t) => a + t.rCost, 0);
console.log(
	`TOTAL ${tops.length} sessions ${DAYS}d | W776 fresh ${fmtK(gT.i)} cached ${fmtK(gT.c)} out ${fmtK(gT.o)} | decant fresh ${fmtK(dT.i)} cached ${fmtK(dT.c)} out ${fmtK(dT.o)} cost $${cost.toFixed(2)} | unmatched gw fresh ${fmtK(unmatched.in)} cached ${fmtK(unmatched.cached)} out ${fmtK(unmatched.out)} ${unmatched.req}req`,
);
dec.close();
gov.close();
