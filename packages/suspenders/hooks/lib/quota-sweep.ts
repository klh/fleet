// hooks/lib/quota-sweep.ts — quota-exhaustion detection + fleet pickup
// (W366, owner directive 2026-10-04 after ikea-opus went dark mid-wave: a
// lane killed by quota/credit exhaustion leaves its claims hanging until a
// human notices). Two evidence sources, one death gate, three actions:
//
//   scan   lane logs (`<repo>/.fleet/lane-<sid>.log` tail) for terminal
//          quota/429/credit signatures, and buckle's route_audit
//          (error_code / err / status) for upstream 429s in a lookback
//          window — attributed per sid where a row names one.
//   gate   a signature alone is not death: the lane must be silent
//          (stale lane log ≥15 min) AND unreachable (no fresh claimant
//          transcript, no live lanes.json entry — same trust basis as
//          `work reclaim`). A lane still writing is backing off, not dead.
//   act    reclaim the dead sid's claims via the supported verb
//          (`work reclaim <id>`, cwd = owning repo), emit `quota.exhausted`
//          on the bus (once per sid per 24h), broadcast one aggregated
//          note so live lanes + SessionStart see it. Reclaimed items go
//          READY; the dispatch loop refills within its cycle — that is
//          the "fleet pickup".
//
// Consumed by `hooks/bin/quota-sweep.ts` (CLI, report-only by default,
// --act performs) and monitor.ts's --fix pass (launchd, every 15 min —
// the same cadence as the staleness floor). Detection is pure/injected so
// tests never touch governor.db or the network.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";

const STALE_MS = 15 * 60_000; // lane-log silence floor (== transcript floor)
const LIVE_HB_MS = 30 * 60_000; // sessions heartbeat window (bus parity)
const TAIL_BYTES = 8192; // terminal signatures live in the log's last words
const EMIT_DEDUP_MS = 24 * 3600_000; // one quota.exhausted event per sid/day

// terminal credit/quota shapes, grounded in real lane-log deaths
// (API Error (429) + litellm.RateLimitError bodies, zai 1210 balance) —
// HARD always qualifies; a bare 429 qualifies only on an error-shaped line
// so prose quoting "429" in a report never counts.
const HARD_SIG =
	/rate_limit_error|insufficient[ _](?:credit|balance|quota)|credit balance (?:is )?too low|exceeded your current quota|quota (?:exhaust|exceed)|billing (?:hard )?limit/i;
const SOFT_429 = /\b429\b/;

export const lineIsQuota = (line: string): boolean =>
	HARD_SIG.test(line) || (SOFT_429.test(line) && /\berror\b/i.test(line));

export type AuditRowLike = {
	ts: string;
	actor: string | null;
	hint?: string | null;
	error_code?: string | null;
	err?: string | null;
	why?: string | null;
	status?: number | null;
};

export const auditRowIsQuota = (r: AuditRowLike): boolean =>
	r.status === 429 ||
	HARD_SIG.test(`${r.error_code ?? ""} ${r.err ?? ""} ${r.why ?? ""}`) ||
	(SOFT_429.test(`${r.error_code ?? ""} ${r.err ?? ""}`) &&
		/\berror\b/i.test(`${r.error_code ?? ""} ${r.err ?? ""}`));

// project identity is the repo's common git dir; the worktree root is its parent
export const projectRootOf = (project: string): string =>
	project.endsWith("/.git") ? project.slice(0, -5) : project;

// /Users/<name> paths never leave through a broadcast (buckle scrub parity)
const scrub = (s: string): string => s.replace(/\/Users\/[^/\s'"]+/g, "~");

export type QuotaHit = {
	source: "lane-log" | "transcript" | "route_audit";
	ts: number;
	detail: string;
};

export type SidVerdict = {
	sid: string;
	exhausted: boolean;
	live: boolean;
	hits: QuotaHit[];
	claims: Array<{ id: string; project: string }>;
	note: string;
};

export type SweepAction = {
	sid: string | null;
	kind: "reclaim" | "emit" | "broadcast";
	detail: string;
};

export type SweepReport = {
	verdicts: SidVerdict[];
	auditUnattributed: number;
	auditDb: string | null;
	actions: SweepAction[];
};

export type SweepDeps = {
	db: Database; // governor.db (read-only use)
	now?: number;
	lookbackMs?: number;
	act?: boolean;
	sid?: string; // filter to one sid (debugging)
	buckleDb?: string | null; // null forces the source off
	projectsDir?: string; // claimant transcripts root
	probeLive?: (sid: string) => boolean; // override the whole death gate
	// sids holding an OPEN decision (decisions.answer_to) — alert-only even
	// when exhausted: the item stays claimed until the fork resolves
	// (paired-lane finding, folded from their quota-scan WIP)
	waitingSids?: Set<string>;
	emit?: (sid: string, note: string) => void;
	broadcast?: (note: string) => number;
	reclaim?: (id: string, projectRoot: string) => { code: number; out: string };
	recentEmit?: (db: Database, sid: string, now: number) => boolean;
};

const lastNonEmpty = (text: string): string => {
	const lines = text.trimEnd().split("\n");
	return lines.length > 0 ? (lines[lines.length - 1] ?? "") : "";
};

// buckle.db discovery: env pin wins; otherwise the buckle package inside
// the same monorepo (project root = a fleet checkout/worktree →
// packages/buckle/buckle.db, relative path for this source tree), then the
// legacy side-by-side sibling layout — kept until W422.6 re-anchors the
// old checkouts (W422.8: cross-repo lookups demoted to fallback).
const defaultBuckleDb = (projectRoots: string[]): string | null => {
	const env = process.env.SUSPENDERS_BUCKLE_DB;
	if (env) return existsSync(env) ? env : null;
	for (const guess of [
		...projectRoots.map((r) => `${r}/packages/buckle/buckle.db`),
		new URL("../../../buckle/buckle.db", import.meta.url).pathname,
		// legacy sibling layout (pre-monorepo): W422.6 retires
		...projectRoots.map((r) => `${r}/../buckle/buckle.db`),
	]) {
		if (existsSync(guess)) return guess;
	}
	return null;
};

// paired-lane adoption (their quota-scan.ts WIP, folded here): the sid's
// own transcript is a third tail — .fleet lane logs rotate or never exist
// for manually-run lanes, the transcript outlives them. Only consulted
// when no lane-log hit exists (dedup); freshness is the death gate's call.
const transcriptTail = (
	projectsDir: string,
	sid: string,
): { text: string; mtimeMs: number } | null => {
	try {
		const glob = new Bun.Glob(`**/*${sid}*`);
		let best: { p: string; m: number } | null = null;
		for (const rel of glob.scanSync({ cwd: projectsDir, onlyFiles: true })) {
			try {
				const m = statSync(`${projectsDir}/${rel}`).mtimeMs;
				if (!best || m > best.m) best = { p: `${projectsDir}/${rel}`, m };
			} catch {}
		}
		if (!best) return null;
		return {
			text: readFileSync(best.p, "utf8").slice(-4 * TAIL_BYTES),
			mtimeMs: best.m,
		};
	} catch {
		return null;
	}
};

// death gate default: sessions-row trust (hb window, else recorded
// transcript freshness) with a project-dir glob fallback — lane-liveness
// parity, no process-table folk magic.
const defaultProbeLive =
	(db: Database, projectsDir: string, now: number) =>
	(sid: string): boolean => {
		try {
			const row = db
				.query(
					// only a RUNNING session vouches — close paths touch hb
					// (sweep/retire), and a CLOSED lane must read dead
					"SELECT hb, parent_sid, transcript_path FROM sessions WHERE sid = ? AND state = 'RUNNING'",
				)
				.get(sid) as {
				hb: number;
				parent_sid: string | null;
				transcript_path: string | null;
			} | null;
			if (row) {
				if (row.hb > now - LIVE_HB_MS) return true;
				if (row.parent_sid !== null) return false;
				if (row.transcript_path) {
					try {
						if (statSync(row.transcript_path).mtimeMs > now - STALE_MS)
							return true;
					} catch {}
				}
			}
		} catch {} // pre-session-table db / test db — glob decides
		try {
			const glob = new Bun.Glob(`**/*${sid}*`);
			for (const rel of glob.scanSync({ cwd: projectsDir, onlyFiles: true })) {
				try {
					if (statSync(`${projectsDir}/${rel}`).mtimeMs > now - STALE_MS)
						return true;
				} catch {}
			}
		} catch {}
		return false;
	};

const defaultRecentEmit = (db: Database, sid: string, now: number): boolean => {
	try {
		return Boolean(
			db
				.query(
					"SELECT 1 FROM events WHERE kind = 'quota.exhausted' AND ts > ? AND payload LIKE ? LIMIT 1",
				)
				.get(now - EMIT_DEDUP_MS, `%${sid}%`),
		);
	} catch {
		return false;
	}
};

export async function quotaSweep(deps: SweepDeps): Promise<SweepReport> {
	const now = deps.now ?? Date.now();
	const lookbackMs = deps.lookbackMs ?? 90 * 60_000;
	const projectsDir =
		deps.projectsDir ?? `${process.env.HOME}/.claude/projects`;
	const probeLive =
		deps.probeLive ?? defaultProbeLive(deps.db, projectsDir, now);
	const recentEmit = deps.recentEmit ?? defaultRecentEmit;
	const actions: SweepAction[] = [];

	// 1. live claims per sid, across every project (governor is global)
	const items = deps.db
		.query(
			"SELECT id, project, owner_sid FROM work_items WHERE state IN ('CLAIMED','RUNNING') AND owner_sid IS NOT NULL",
		)
		.all() as Array<{ id: string; project: string; owner_sid: string }>;
	const bySid = new Map<string, Array<{ id: string; project: string }>>();
	for (const it of items) {
		if (deps.sid && it.owner_sid !== deps.sid) continue;
		const list = bySid.get(it.owner_sid) ?? [];
		list.push({ id: it.id, project: it.project });
		bySid.set(it.owner_sid, list);
	}

	// 2. route_audit window scan (buckle side) — attribute rows that name a
	// known sid anywhere in their text fields (the /w/<sid> front lands once
	// buckle serves the prefix); unattributed 429s stay a fleet-level note.
	const auditHits = new Map<string, QuotaHit[]>();
	let auditUnattributed = 0;
	let auditDb: string | null = null;
	const roots = [
		...new Set([...bySid.values()].flat().map((c) => projectRootOf(c.project))),
	];
	const bucklePath =
		deps.buckleDb === undefined ? defaultBuckleDb(roots) : deps.buckleDb;
	if (bucklePath) {
		auditDb = bucklePath;
		try {
			const { Database: Open } = await import("bun:sqlite");
			const bdb = new Open(bucklePath, { readonly: true });
			const cutoff = new Date(now - lookbackMs).toISOString();
			const rows = bdb
				.query(
					"SELECT ts, actor, hint, error_code, err, why, status FROM route_audit WHERE ts >= ?",
				)
				.all(cutoff) as Array<{
				ts: string;
				actor: string | null;
				hint: string | null;
				error_code: string | null;
				err: string | null;
				why: string | null;
				status: number | null;
			}>;
			bdb.close();
			for (const r of rows) {
				if (!auditRowIsQuota(r)) continue;
				const text = `${r.actor ?? ""} ${r.hint ?? ""} ${r.why ?? ""} ${r.err ?? ""}`;
				const hitSid = [...bySid.keys()].find((s) => s && text.includes(s));
				if (!hitSid) {
					auditUnattributed++;
					continue;
				}
				const detail = scrub(
					`route_audit ${r.status ?? "?"} ${r.error_code ?? r.err ?? ""}`.slice(
						0,
						160,
					),
				);
				const list = auditHits.get(hitSid) ?? [];
				list.push({
					source: "route_audit",
					ts: Date.parse(r.ts) || now,
					detail,
				});
				auditHits.set(hitSid, list);
			}
		} catch {} // unreadable/locked/absent — lane logs still decide
	}

	// 3. per-sid verdicts: evidence + death gate
	const verdicts: SidVerdict[] = [];
	for (const [sid, claims] of bySid) {
		const hits: QuotaHit[] = [];
		let logFresh = false;
		let finished = false;
		const sidRoots = [...new Set(claims.map((c) => projectRootOf(c.project)))];
		for (const root of sidRoots) {
			const logPath = `${root}/.fleet/lane-${sid}.log`;
			if (!existsSync(logPath)) continue;
			const mtimeMs = statSync(logPath).mtimeMs;
			if (mtimeMs > now - STALE_MS) logFresh = true;
			const text = readFileSync(logPath, "utf8");
			if (/^DONE\b/.test(lastNonEmpty(text))) finished = true;
			for (const line of text.slice(-TAIL_BYTES).split("\n")) {
				if (lineIsQuota(line))
					hits.push({
						source: "lane-log",
						ts: mtimeMs,
						detail: scrub(line.slice(0, 160)),
					});
			}
		}
		hits.push(...(auditHits.get(sid) ?? []));
		if (!hits.some((h) => h.source === "lane-log")) {
			const tail = transcriptTail(projectsDir, sid);
			if (tail)
				for (const line of tail.text.split("\n"))
					if (lineIsQuota(line))
						hits.push({
							source: "transcript",
							ts: tail.mtimeMs,
							detail: scrub(line.slice(0, 160)),
						});
		}
		const live = logFresh || probeLive(sid);
		const waiting = deps.waitingSids?.has(sid) === true;
		let exhausted = hits.length > 0 && !live && !finished;
		let note: string;
		if (finished) {
			exhausted = false;
			note = "lane finished (DONE) — claims close via done/orphaned, not quota";
		} else if (exhausted && waiting) {
			exhausted = false;
			note =
				"quota signatures + lane dead but holds an OPEN decision — alert only, no reclaim";
		} else if (exhausted) {
			note = `quota-exhausted: ${hits[hits.length - 1]?.detail ?? "signature"}`;
		} else if (hits.length > 0 && live) {
			note =
				"quota signatures but lane live (backoff/retry) — watched, not reclaimed";
		} else {
			note = "clean";
		}
		const verdict: SidVerdict = {
			sid,
			exhausted,
			live,
			hits,
			claims,
			note,
		};
		verdicts.push(verdict);

		// 4. act — only on an exhausted verdict, only when asked
		if (!exhausted || !deps.act) continue;
		const reclaim =
			deps.reclaim ??
			((id: string, cwd: string) => {
				const bin = new URL("../bin/work.ts", import.meta.url).pathname;
				const p = Bun.spawnSync([process.execPath, bin, "reclaim", id], {
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				return {
					code: p.exitCode ?? 1,
					out: `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`.trim(),
				};
			});
		for (const c of claims) {
			const r = reclaim(c.id, projectRootOf(c.project));
			actions.push({
				sid,
				kind: "reclaim",
				detail: `${c.id} ${r.code === 0 ? "→ READY" : `RECLAIM FAILED (${r.out.slice(0, 80)})`}`,
			});
		}
		if (!recentEmit(deps.db, sid, now)) {
			const eventNote = `${sid} ${verdict.note}; claims ${claims.map((c) => c.id).join(",") || "none"} → READY, dispatch refills`;
			const doEmit =
				deps.emit ??
				(async (_s: string, n: string) => {
					const { emitEvent } = await import("../coord/bus.ts");
					emitEvent({
						kind: "quota.exhausted",
						note: n,
						source: "quota-sweep",
					});
				});
			await Promise.resolve(doEmit(sid, eventNote));
			actions.push({ sid, kind: "emit", detail: "quota.exhausted → bus" });
		}
	}

	// one aggregated broadcast per sweep (live lanes' inboxes + SessionStart)
	if (deps.act && verdicts.some((v) => v.exhausted)) {
		const lines = verdicts
			.filter((v) => v.exhausted)
			.map(
				(v) =>
					`  ${v.sid}: ${v.note}; reclaimed ${v.claims.map((c) => c.id).join(",") || "nothing"}`,
			)
			.join("\n");
		const note = `[quota-sweep] quota-exhausted lane(s) picked up (claims → READY, dispatch refills):\n${lines}`;
		const doBroadcast =
			deps.broadcast ??
			(async (n: string) => {
				const { broadcastNote } = await import("../coord/bus.ts");
				return broadcastNote(n, "quota-sweep").targets;
			});
		const targets = await Promise.resolve(doBroadcast(note));
		actions.push({
			sid: null,
			kind: "broadcast",
			detail: `→ ${targets} live session(s)`,
		});
	}

	return { verdicts, auditUnattributed, auditDb, actions };
}
