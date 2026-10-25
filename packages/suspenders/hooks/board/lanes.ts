// hooks/board/lanes.ts — lane/session read helpers: liveness, transcripts, labels, filters (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { hostname } from "node:os";
// (the isDecisionKind accept-set note below mirrors govdb.ts — not imported
// on purpose: lanes.ts never calls it, the two lists just change together)
import { tagNameOf } from "../lib/govdb/govdb.ts";
import {
	gitObservation,
	type LaneGitObservation,
} from "../lib/lanes/lane-git.ts";
import {
	type LaneRef,
	type LaneVerdict,
	type ProcessInspection,
	transcriptAlive,
	transcriptsAliveBatch,
	verdictBySid,
} from "../lib/lanes/lane-liveness.ts";
import { loadLaneRegistry } from "../lib/lanes/lane-registry.ts";
import {
	laneStopNotice,
	laneStopTarget,
	operationalLaneStopNotice,
} from "../lib/lanes/lane-stop-decision.ts";
import { coordSubscribeLog } from "../lib/lanes/subscribe-attach.ts";
import { db, type EventRow } from "./context.ts";
import { chunked } from "./helpers.ts";

// W682: config facts ride a 3s memo — the liveness verdicts read them per
// project chunk (80 fact reads per cold /api/data on the profiled fleet);
// they change on `coord fact set` timescales, never inside a poll window.
let _deadAfterMs: { at: number; v: number } | null = null;
export const deadAfterMs = (): number => {
	if (_deadAfterMs && Date.now() - _deadAfterMs.at < 3_000)
		return _deadAfterMs.v;
	const v = Number(
		(
			db
				.query("SELECT value FROM facts WHERE key = 'fleet.zombie_after_ms'")
				.get() as { value: string } | null
		)?.value ?? 45 * 60_000,
	);
	_deadAfterMs = { at: Date.now(), v };
	return v;
};

export const projOf = (sid: string): string | null =>
	(
		db.query("SELECT project FROM sessions WHERE sid = ?").get(sid) as {
			project: string | null;
		} | null
	)?.project ?? null;

// delivery: DELIVERED once the target lane shows life or its cursor reads
// past the fork; FAILED when the session is unknown/dead and never picked
// the decision up (UI: "delivery failed — retry"). Coordinator role is alive
// unconditionally: coordinators sleep between waves (monitor exempts them
// from sweeps) — hb staleness there is not death (2026-09-25: the gaps
// coordinator idled ~8h waiting on work and the board declared its decision
// undeliverable).
export const targetAlive = (sid: string, now: number): boolean => {
	const s = db
		.query("SELECT hb, role FROM sessions WHERE sid = ?")
		.get(sid) as { hb: number; role: string | null } | null;
	if (!s) return false;
	if (s.role === "coordinator") return true;
	// the published coordinator identity is authoritative (coord fact set
	// coordinator.sid) — a misrecorded role must not unpublish its liveness
	if (
		sid ===
		(
			db
				.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
				.get() as { value: string } | null
		)?.value
	)
		return true;
	return now - s.hb <= deadAfterMs();
};
export const pickedUp = (eventId: number, sid: string): boolean =>
	((
		db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
			event_id: number;
		} | null
	)?.event_id ?? 0) >= eventId;

// payload.options → JSON array of {label, tradeoff}. Accepts a real array
// (TS emitters) or a JSON-encoded array string (coord emit --options=… makes
// every --field a string); bare strings keep their text, lose nothing.
export function normOptions(v: unknown): string {
	if (typeof v === "string" && v.trimStart().startsWith("[")) {
		try {
			v = JSON.parse(v);
		} catch {}
	}
	if (typeof v === "string") {
		// CLI ergonomics: --options="a | b" — a bare string splits into labels
		const labels = v.split(/\s*\|\s*/).filter(Boolean);
		if (labels.length > 1) v = labels;
	}
	if (!Array.isArray(v) || !v.length) return "";
	return JSON.stringify(
		v.slice(0, 8).map((o) =>
			typeof o === "string"
				? { label: o, tradeoff: null }
				: {
						label: String(o?.label ?? ""),
						tradeoff: o?.tradeoff == null ? null : String(o.tradeoff),
					},
		),
	);
}

// Link from explicit event work/scope, or a unique work item owned by the
// emitting lane. Never infer an item id from free-form question text.
export function enrich(
	d: { event_id: number; target: string },
	e:
		| {
				source?: string | null;
				scope?: string | null;
				ts?: number | null;
				payload?: string | null;
		  }
		| null
		| undefined,
): void {
	let p: Record<string, unknown> = {};
	try {
		p = e?.payload ? JSON.parse(e.payload) : {};
	} catch {}
	const project = String(
		p.project ?? projOf(e?.source ?? "") ?? projOf(d.target) ?? "",
	);
	let work = p.work != null ? String(p.work) : null;
	if (!work && /^W\d+(?:\.\d+)*$/.test(e?.scope ?? "")) work = e?.scope ?? null;
	if (!work && project && e?.source && e.ts) {
		const owned = db
			.query(
				"SELECT id FROM work_items WHERE project = ? AND owner_sid = ? AND created_at <= ? LIMIT 2",
			)
			.all(project, e.source, e.ts) as { id: string }[];
		if (owned.length === 1) work = owned[0].id;
	}
	if (!work && project && e?.source) {
		// work done/release clears owner_sid. The earlier claim is still an
		// immutable, project-scoped link from this lane to its work item.
		const claimed = db
			.query(
				`SELECT e.work AS id FROM events e
			 JOIN work_items w ON w.project = e.project AND w.id = e.work
			 WHERE e.kind = 'work.claimed' AND e.project = ?
			 AND json_extract(e.payload, '$.by') = ? AND e.id <= ?
			 ORDER BY e.id DESC LIMIT 1`,
			)
			.get(project, e.source, d.event_id) as { id: string } | null;
		work = claimed?.id ?? null;
	}
	db.query(
		"UPDATE decisions SET asked_by = ?, project = COALESCE(NULLIF(?, ''), project), task_id = COALESCE(task_id, ?), question = COALESCE(question, ?), options = COALESCE(options, ?) WHERE event_id = ?",
	).run(
		String(e?.source ?? d.target),
		project,
		work,
		String(p.note ?? p.question ?? ""),
		normOptions(p.options),
		d.event_id,
	);
}

// sync: backfill new NEED% forks, then apply the best-effort transitions —
// delivery degradation, work supersede/cancel → CANCELLED, lane activity
// after an answer → ACKNOWLEDGED. Idempotent + monotonic; safe on every poll.
// Recover only the latest typed stop for a still-owned, unfinished item. Generic
// untargeted broadcasts and historical/retaken activations remain untouched.
function backfillLaneStopDecisions(): void {
	const seen = new Set<string>();
	const events = db
		.query(`SELECT e.id,e.ts,e.source,e.payload FROM events e
 WHERE e.kind='NEED_DECISION' AND e.target IS NULL AND json_valid(e.payload)
 AND EXISTS (SELECT 1 FROM work_items w
 WHERE w.project=json_extract(e.payload,'$.project')
 AND w.id=json_extract(e.payload,'$.item') AND w.owner_sid=e.source
 AND w.state IN ('CLAIMED','RUNNING','BLOCKED'))
 AND NOT EXISTS (SELECT 1 FROM events claim
 WHERE claim.kind='work.claimed' AND claim.id > e.id
 AND claim.project=json_extract(e.payload,'$.project')
 AND claim.work=json_extract(e.payload,'$.item')) ORDER BY e.id DESC`)
		.all() as {
		id: number;
		ts: number;
		source: string;
		payload: string | null;
	}[];
	for (const event of events) {
		const notice = laneStopNotice(event.payload, event.source);
		if (!notice) continue;
		const key = JSON.stringify([notice.project, notice.item]);
		if (seen.has(key)) continue;
		seen.add(key);
		db.query(`INSERT OR IGNORE INTO decisions
  (event_id,target,asked_by,project,task_id,question,state,delivery,created_at,answer_token)
  VALUES (?,?,?,?,?,?,'OPEN','FAILED',?,?)`).run(
			event.id,
			laneStopTarget(db, notice.project, event.source),
			event.source,
			notice.project,
			notice.item,
			notice.note,
			event.ts,
			crypto.randomUUID(),
		);
	}
}

export function syncDecisions(): void {
	const now = Date.now();
	backfillLaneStopDecisions();
	// A later claim starts a new activation. Retire only typed operational
	// incidents from the earlier activation, never a generic human decision.
	for (const event of db
		.query(`SELECT e.id,e.source,e.target,e.kind,e.payload FROM decisions d
	 JOIN events e ON e.id=d.event_id WHERE d.state='OPEN' AND EXISTS
	 (SELECT 1 FROM events claim WHERE claim.kind='work.claimed' AND claim.id > e.id
	 AND claim.project=d.project AND claim.work=d.task_id)`)
		.all() as {
		id: number;
		source: string;
		target: string | null;
		kind: string;
		payload: string | null;
	}[]) {
		if (!operationalLaneStopNotice(event)) continue;
		db.query(
			"UPDATE decisions SET state='CANCELLED',closed_at=?,answer_token=? WHERE event_id=? AND state='OPEN'",
		).run(now, crypto.randomUUID(), event.id);
	}
	// old DISMISSED rows keep their meaning under the v2 name (board dismiss = CANCELLED)
	db.run("UPDATE decisions SET state = 'CANCELLED' WHERE state = 'DISMISSED'");
	for (const r of db
		.query("SELECT event_id FROM decisions WHERE answer_token IS NULL")
		.all() as { event_id: number }[])
		db.query("UPDATE decisions SET answer_token = ? WHERE event_id = ?").run(
			crypto.randomUUID(),
			r.event_id,
		);
	// backfill: one row per NEED% event with a concrete target (dead-letter
	// alias targets included). LIKE is case-insensitive for ASCII — this is
	// the accept set isDecisionKind() (hooks/lib/govdb/govdb.ts) mirrors exactly;
	// change them together.
	for (const e of db
		.query(
			"SELECT id, ts, source, target, scope, payload FROM events WHERE kind LIKE 'NEED%' AND target IS NOT NULL AND id NOT IN (SELECT event_id FROM decisions) ORDER BY id",
		)
		.all() as EventRow[]) {
		db.query(
			"INSERT OR IGNORE INTO decisions (event_id, target, state, delivery, created_at, answer_token) VALUES (?, ?, 'OPEN', ?, ?, ?)",
		).run(
			e.id,
			e.target,
			targetAlive(e.target, now) || pickedUp(e.id, e.target)
				? "DELIVERED"
				: "FAILED",
			e.ts,
			crypto.randomUUID(),
		);
		enrich({ event_id: e.id, target: e.target }, e);
	}
	// v1 rows: backfill the enrichment columns from the source event
	for (const d of db
		.query(
			"SELECT event_id, target FROM decisions WHERE (asked_by IS NULL OR project IS NULL OR question IS NULL OR (task_id IS NULL AND state = 'OPEN')) AND EXISTS (SELECT 1 FROM events WHERE events.id = decisions.event_id)",
		)
		.all() as { event_id: number; target: string }[]) {
		enrich(
			d,
			db
				.query("SELECT source, scope, ts, payload FROM events WHERE id = ?")
				.get(d.event_id) as {
				source: string;
				scope: string | null;
				ts: number;
				payload: string | null;
			} | null,
		);
	}
	// a decision addressed to a lane that died before pickup reads as FAILED
	// instead of silently waiting forever; cursor past the fork = picked up.
	// Truth-sync, not one-way degradation: a wrongly-FAILED row (target alive
	// all along — see targetAlive) repairs itself when the target shows life.
	for (const d of db
		.query("SELECT event_id, target FROM decisions WHERE state = 'OPEN'")
		.all() as { event_id: number; target: string }[])
		db.query("UPDATE decisions SET delivery = ? WHERE event_id = ?").run(
			targetAlive(d.target, now) || pickedUp(d.event_id, d.target)
				? "DELIVERED"
				: "FAILED",
			d.event_id,
		);
	// OPEN → CANCELLED: the asking lane superseded/cancelled the linked work
	for (const d of db
		.query(
			`SELECT d.event_id AS id FROM decisions d WHERE d.state = 'OPEN' AND d.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e
			WHERE e.kind IN ('work.superseded','work.cancelled','work.supersede','work.cancel') AND e.work = d.task_id AND e.project = d.project)`,
		)
		.all() as { id: number }[])
		db.query(
			"UPDATE decisions SET state = 'CANCELLED', closed_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'",
		).run(now, crypto.randomUUID(), d.id);
	// OPEN → CANCELLED (W798): the linked task landed DONE — the work graph
	// already decided; the fork ages out on the next sync
	for (const d of db
		.query(
			`SELECT d.event_id AS id FROM decisions d WHERE d.state = 'OPEN' AND d.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM work_items w
			WHERE w.id = d.task_id AND w.project = d.project AND w.state = 'DONE')`,
		)
		.all() as { id: number }[])
		db.query(
			"UPDATE decisions SET state = 'CANCELLED', closed_at = ?, answer_token = ? WHERE event_id = ? AND state = 'OPEN'",
		).run(now, crypto.randomUUID(), d.id);
	// ANSWERED → ACKNOWLEDGED (best-effort heuristic, monotonic): the lane the
	// answer was addressed to produced a checkpoint/message after answered_ts —
	// it read the answer and moved on
	for (const d of db
		.query(
			`SELECT d.event_id AS id FROM decisions d WHERE d.state = 'ANSWERED' AND d.answered_at IS NOT NULL AND d.answer_to IS NOT NULL AND EXISTS (SELECT 1 FROM events e
			WHERE e.source = d.answer_to AND e.ts >= d.answered_at AND e.kind IN ('checkpoint','landed','test_green','interface_changed','NOTE','resume_ready'))`,
		)
		.all() as { id: number }[])
		db.query(
			"UPDATE decisions SET state = 'ACKNOWLEDGED', ack_ts = ?, answer_token = ? WHERE event_id = ? AND state = 'ANSWERED'",
		).run(now, crypto.randomUUID(), d.id);
}

export const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

export const lanesOf = (repo: string): { pid: number; branch: string }[] => {
	try {
		return JSON.parse(readFileSync(`${repo}/.fleet/lanes.json`, "utf8")) as {
			pid: number;
			branch: string;
		}[];
	} catch {
		return [];
	}
};

// <repo>/.fleet/ship.json — the one-click ship trigger's owner config, same
// trust class as the loop's --ladder argv. Required: ship must never do a
// plain merge behind the repo's quality policy's back.
export const readShipJson = (repo: string): { ladder?: string } => {
	try {
		return JSON.parse(readFileSync(`${repo}/.fleet/ship.json`, "utf8")) as {
			ladder?: string;
		};
	} catch {
		return {};
	}
};

// a transcript written within the last 15 minutes = live process — W466:
// the glob fallback retired; the bounded depth-4 walk (lib/lane-liveness
// .ts, memoized) is the one liveness scan
export const transcriptWarm = (sid: string): boolean => {
	const floor = Date.now() - 15 * 60_000;
	const p = (
		db.query("SELECT transcript_path FROM sessions WHERE sid = ?").get(sid) as {
			transcript_path: string | null;
		} | null
	)?.transcript_path;
	if (p) {
		try {
			return statSync(p).mtimeMs > floor;
		} catch {}
	}
	return transcriptAlive(sid);
};

// W685: the liveness chain evaluated from a pre-fetched row — the batched
// verdict face (decisionVerdicts) feeds every fallback target through ONE
// sessions read instead of a curl round-trip per sid.
interface LaneSessionRow {
	state: string;
	role: string | null;
	hb: number;
	transcript_path: string | null;
}

const aliveFromRow = (
	sid: string,
	s:
		| {
				state: string;
				role: string | null;
				hb: number;
				transcript_path: string | null;
		  }
		| undefined,
	coordSid: string | null,
	deadMs: number,
	liveTerm?: (sid: string) => boolean,
): boolean => {
	if (!s) return false;
	if (s.state !== "RUNNING") return false;
	if (s.role === "coordinator") return true;
	if (sid === coordSid) return true;
	if (Date.now() - s.hb <= deadMs) return true;
	if (s.transcript_path) {
		try {
			return statSync(s.transcript_path).mtimeMs > Date.now() - 15 * 60_000;
		} catch {}
	}
	return (liveTerm ?? transcriptAlive)(sid);
};

// live = RUNNING row + (fresh hb or warm transcript); coordinators are exempt
// (they sleep between waves — same doctrine as targetAlive)
export const sessionAlive = (sid: string): boolean =>
	aliveFromRow(
		sid,
		db
			.query(
				"SELECT state, role, hb, transcript_path FROM sessions WHERE sid = ?",
			)
			.get(sid) as {
			state: string;
			role: string | null;
			hb: number;
			transcript_path: string | null;
		} | null,
		coordinatorSid(),
		deadAfterMs(),
	);

// W667 decision staleness: a decision's target is judged by the
// process-backed lane registry (the `work lanes` surface — lib/
// lane-liveness.ts verdicts), never by the sessions row alone: rows stay
// RUNNING for dead dispatch lanes, which is how stale-lane NEED_DECISIONs
// sat OPEN for days. A registry hit (exact sid, then the prefix join
// verdictBySid uses) is authoritative; unregistered targets keep the
// sessions+transcript verdict; `unknown` never reads dead (monitor
// doctrine: lookup failure is not death).
let _coordSid: { at: number; v: string | null } | null = null;
const coordinatorSid = (): string | null => {
	if (_coordSid && Date.now() - _coordSid.at < 3_000) return _coordSid.v;
	const v =
		(
			db
				.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
				.get() as {
				value: string;
			} | null
		)?.value ?? null;
	_coordSid = { at: Date.now(), v };
	return v;
};

// one batched sessions read for a set of fallback targets
const sessionRows = (sids: string[]): Map<string, LaneSessionRow> => {
	const out = new Map<string, LaneSessionRow>();
	chunked(sids, (chunk) => {
		const ph = chunk.map(() => "?").join(",");
		for (const r of db
			.query(
				`SELECT sid, state, role, hb, transcript_path FROM sessions WHERE sid IN (${ph})`,
			)
			.all(...chunk) as {
			sid: string;
			state: string;
			role: string | null;
			hb: number;
			transcript_path: string | null;
		}[])
			out.set(r.sid, r);
	});
	return out;
};

const laneRegistryCache = new Map<string, { until: number; rows: LaneRef[] }>();
const psCache: { until: number; snap: ProcessInspection | null } = {
	until: 0,
	snap: null,
};
const boardProcessInspector = (): ProcessInspection => {
	if (psCache.snap && Date.now() < psCache.until) return psCache.snap;
	const r = Bun.spawnSync(["ps", "-axo", "pid=,args="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	psCache.snap = { exitCode: r.exitCode, stdout: r.stdout.toString() };
	psCache.until = Date.now() + 3_000;
	return psCache.snap;
};
const registryRows = (project: string | null): LaneRef[] => {
	const key = project ?? "";
	const hit = laneRegistryCache.get(key);
	if (hit && Date.now() < hit.until) return hit.rows;
	let rows: LaneRef[] = [];
	try {
		rows = project ? loadLaneRegistry(project) : [];
	} catch {}
	laneRegistryCache.set(key, { until: Date.now() + 3_000, rows });
	return rows;
};

/** Batch face for decisionRecords: sid → liveness verdict, registry-first.
 *  Unregistered sids collapse the sessions face to alive/dead (the pre-W667
 *  sessionAlive semantics). */
export function decisionVerdicts(
	pairs: { sid: string | null; project: string | null }[],
): Map<string, LaneVerdict> {
	const out = new Map<string, LaneVerdict>();
	const byProject = new Map<string, string[]>();
	for (const { sid, project } of pairs) {
		if (!sid || out.has(sid)) continue;
		const key = project ?? "";
		const lanes = byProject.get(key) ?? [];
		lanes.push(sid);
		byProject.set(key, lanes);
	}
	for (const [project, lanes] of byProject) {
		const rows = registryRows(project || null);
		const fresh = transcriptsAliveBatch([...lanes, ...rows.map((r) => r.sid)]);
		const reg = verdictBySid(lanes, rows, () => boardProcessInspector(), fresh);
		// W810: registry verdicts are the PRIMARY face — they must land in the
		// map, not only gate the sessions fallback (the W685 batching refactor
		// dropped the merge; registered-dead lanes never classified stale)
		for (const [sid, v] of reg) out.set(sid, v);
		const missing = lanes.filter((sid) => !reg.has(sid));
		if (missing.length) {
			// W685: the sessions fallback evaluates from ONE batched read —
			// per-sid sessionAlive() was a curl round-trip per sid, and the
			// transcript term re-walked ~/.claude/projects per stale sid.
			const sessionMap = sessionRows(missing);
			const coordSid = coordinatorSid();
			const deadMs = deadAfterMs();
			for (const sid of missing)
				out.set(
					sid,
					aliveFromRow(
						sid,
						sessionMap.get(sid),
						coordSid,
						deadMs,
						(s) => fresh.get(s) === true,
					)
						? "alive"
						: "dead",
				);
		}
	}
	return out;
}

/** Single-target face for /api/answer's owner-ruling gate. */
export const decisionTargetAlive = (
	sid: string | null,
	project: string | null,
): boolean => {
	if (!sid) return true;
	return decisionVerdicts([{ sid, project }]).get(sid) !== "dead";
};

export const failNote = (id: string): string | null => {
	try {
		const r = db
			.query(
				"SELECT payload FROM events WHERE kind = 'work.failed' AND work = ? ORDER BY id DESC LIMIT 1",
			)
			.get(id) as { payload: string | null } | null;
		const note = r?.payload
			? (JSON.parse(r.payload) as { note?: unknown }).note
			: null;
		return note ? String(note).slice(0, 300) : null;
	} catch {
		return null;
	}
};

export function ago(ts: number | null | undefined): number {
	return ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : -1;
}

// W969 Signals-lite: newest lane.signal verdict per (project, item) — one
// newest-first read, first-wins per key. `signal` rides the task rows so
// the board lanes view can badge silent-failure verdicts (reported-done-
// tests-red | loop-no-progress | claim-evidence-mismatch | clean).
export interface TaskSignal {
	class: string;
	confidence: number;
	ts: number;
}

export function signalMaps(): Map<string, TaskSignal> {
	const out = new Map<string, TaskSignal>();
	for (const r of db
		.query(
			"SELECT payload FROM events WHERE kind = 'lane.signal' ORDER BY id DESC LIMIT 400",
		)
		.all() as { payload: string | null }[]) {
		const pl = payloadOf(r.payload);
		if (
			typeof pl.work !== "string" ||
			typeof pl.class !== "string" ||
			typeof pl.confidence !== "number"
		)
			continue;
		const key = `${String(pl.project ?? "")}\u0000${pl.work}`;
		if (out.has(key)) continue;
		out.set(key, {
			class: pl.class,
			confidence: pl.confidence,
			ts: typeof pl.ts === "number" ? pl.ts : 0,
		});
	}
	return out;
}

// single-item face for the drawer (/api/task) — same vocabulary
export function signalFor(project: string, id: string): TaskSignal | null {
	for (const r of db
		.query(
			"SELECT payload FROM events WHERE kind = 'lane.signal' AND json_extract(payload, '$.work') = ? ORDER BY id DESC LIMIT 1",
		)
		.all(id) as { payload: string | null }[]) {
		const pl = payloadOf(r.payload);
		if (
			typeof pl.class === "string" &&
			typeof pl.confidence === "number" &&
			String(pl.project ?? "") === project
		)
			return {
				class: pl.class,
				confidence: pl.confidence,
				ts: typeof pl.ts === "number" ? pl.ts : 0,
			};
	}
	return null;
}

// W293 session-name bridge: the user-facing lane name lives in sessions.tags
// JSON (stamped by `coord bootstrap --name` at dispatch or by hand). The
// board never renders a bare sid where a name exists.
export function sessionName(sid: string): string | null {
	return tagNameOf(
		(
			db.query("SELECT tags FROM sessions WHERE sid = ?").get(sid) as {
				tags: string | null;
			} | null
		)?.tags,
	);
}

export function label(sid: string, role: string): string {
	// user-given names lead (copilot's user_named semantics): an opaque sid or
	// a derived claim intent never buries the label the human typed
	const name = sessionName(sid);
	if (name) return name.slice(0, 24);
	const rows = db
		.query(
			"SELECT intent FROM claims WHERE sid = ? AND intent IS NOT NULL ORDER BY ts DESC LIMIT 4",
		)
		.all(sid) as { intent: string | null }[];
	const c = rows.find(
		(r) => r.intent && !String(r.intent).startsWith("restored by monitor"),
	);
	if (c?.intent) return String(c.intent).slice(0, 24);
	if (role === "coordinator") return "coordinator";
	return sid.slice(0, 8);
}

// W663: the batch face of label() — ONE sessions query + ONE claims query
// feed maps so payload() never walks claims per-sid (445 registered lanes
// turned each /api/data poll into 900+ synchronous store RPCs on the board's
// main thread; /api/data wedged and the whole .local face starved with it).
// Semantics mirror label() exactly: session name leads, first non-monitor
// claim intent follows, sid prefix is the last resort.
export function labelMaps(): {
	names: Map<string, string>;
	intents: Map<string, string>;
} {
	const names = new Map<string, string>();
	for (const r of db.query("SELECT sid, tags FROM sessions").all() as {
		sid: string;
		tags: string | null;
	}[]) {
		const name = tagNameOf(r.tags);
		if (name) names.set(r.sid, name.slice(0, 24));
	}
	const intents = new Map<string, string>();
	for (const r of db
		.query(
			"SELECT sid, intent FROM claims WHERE intent IS NOT NULL ORDER BY ts DESC",
		)
		.all() as { sid: string; intent: string | null }[]) {
		if (intents.has(r.sid)) continue;
		if (r.intent && !r.intent.startsWith("restored by monitor"))
			intents.set(r.sid, r.intent.slice(0, 24));
	}
	return { names, intents };
}

// W663 sibling: lane executor/model/locality facts for EVERY sid in ONE
// facts query (laneModelOf costs 3 store RPCs per sid; at 445 sessions that
// is 1335 more synchronous curls per /api/data poll). Key shape:
// lane.<sid>.<k>. Consumers read the same values laneModelOf returns.
export function laneModelMaps(): Map<
	string,
	{ executor: string | null; model: string; locality: string; route: string }
> {
	const map = new Map<
		string,
		{ executor: string | null; model: string; locality: string; route: string }
	>();
	for (const r of db
		.query("SELECT key, value FROM facts WHERE key GLOB 'lane.*.*'")
		.all() as { key: string; value: string }[]) {
		const rest = r.key.slice("lane.".length);
		const dot = rest.indexOf(".");
		if (dot <= 0) continue;
		const sid = rest.slice(0, dot);
		const k = rest.slice(dot + 1);
		let e = map.get(sid);
		if (!e) {
			e = { executor: null, model: "", locality: "", route: "" };
			map.set(sid, e);
		}
		if (k === "executor") e.executor = r.value;
		else if (k === "model") e.model = r.value;
		else if (k === "locality") e.locality = r.value;
		else if (k === "route") e.route = r.value;
	}
	return map;
}

// label from prebuilt maps (labelMaps) with label()'s exact fallback chain
export function labelFrom(
	maps: { names: Map<string, string>; intents: Map<string, string> },
	sid: string,
	role: string,
): string {
	return (
		maps.names.get(sid) ??
		maps.intents.get(sid) ??
		(role === "coordinator" ? "coordinator" : sid.slice(0, 8))
	);
}

// every project the control plane knows — the UI's global filter options
export function projectList(): string[] {
	return (
		db
			.query(
				"SELECT project AS p FROM work_items UNION SELECT project AS p FROM sessions WHERE project IS NOT NULL ORDER BY p",
			)
			.all() as { p: string }[]
	).map((r) => r.p);
}

// owner_label (docs/board-api.md): the owner's newest claim intent, else the
// session name (W293: tags JSON `name`), else null — the UI never renders a
// raw sid when a label exists. W682: 3s per-sid memo — the tasks feed calls
// this per owned row (4 store RPCs × live lanes each poll).
const _ownerLabelCache = new Map<string, { at: number; v: string | null }>();
export function ownerLabel(sid: string | null | undefined): string | null {
	if (!sid) return null;
	const hit = _ownerLabelCache.get(sid);
	if (hit && Date.now() - hit.at < 3_000) return hit.v;
	const rows = db
		.query(
			"SELECT intent FROM claims WHERE sid = ? AND intent IS NOT NULL ORDER BY ts DESC LIMIT 4",
		)
		.all(sid) as { intent: string | null }[];
	const c = rows.find(
		(r) => r.intent && !String(r.intent).startsWith("restored by monitor"),
	);
	const v = c?.intent
		? String(c.intent).slice(0, 24)
		: (sessionName(sid) ??
			(db.query("SELECT 1 AS x FROM sessions WHERE sid = ?").get(sid)
				? sid
				: null));
	_ownerLabelCache.set(sid, { at: Date.now(), v });
	return v;
}

export const payloadOf = (raw: string | null): Record<string, unknown> => {
	try {
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
};

export const TAIL_BYTES = 32 * 1024;
export const TAIL_MAX = 110;
export const LANE_TAIL_BYTES = 32 * 1024;
export function transcriptTail(
	sid: string | null | undefined,
	maxChars = TAIL_MAX,
): { text: string; ts: string | null } | null {
	return transcriptTailAll(sid, 1, maxChars)[0] ?? null;
}
// newest-last list of the session's latest assistant text / tool blocks.
// max=1 reproduces the kanban-card tail contract (the single last block).
export function transcriptTailAll(
	sid: string | null | undefined,
	max: number,
	maxChars = TAIL_MAX,
	since?: number,
): { text: string; ts: string | null }[] {
	if (!sid) return [];
	const row = db
		.query("SELECT transcript_path FROM sessions WHERE sid = ?")
		.get(sid) as { transcript_path: string | null } | null;
	const path = row?.transcript_path;
	if (!path || !existsSync(path) || !statSync(path).size) return [];
	const size = statSync(path).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const len = size - start;
	const buf = Buffer.alloc(len);
	try {
		const fd = openSync(path, "r");
		readSync(fd, buf, 0, len, start);
		closeSync(fd);
	} catch {
		return [];
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift(); // first line may be a partial record
	const out: { text: string; ts: string | null }[] = [];
	for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let j:
			| {
					timestamp?: string | null;
					message?: {
						role?: string;
						content?: {
							type?: string;
							text?: string;
							name?: string;
							input?: Record<string, unknown> | null;
						}[];
					};
			  }
			| undefined;
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = j?.message;
		if (
			since !== undefined &&
			(!j?.timestamp ||
				!Number.isFinite(Date.parse(j.timestamp)) ||
				Date.parse(j.timestamp) < since)
		)
			continue;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let k = msg.content.length - 1; k >= 0 && out.length < max; k--) {
			const b = msg.content[k];
			if (b?.type === "text" && typeof b.text === "string" && b.text.trim())
				out.push({
					text: b.text.trim().replace(/\s+/g, " ").slice(0, maxChars),
					ts: j.timestamp ?? null,
				});
			else if (b?.type === "tool_use" && b.name)
				out.push({
					text: `→ ${b.name}: ${String(
						b.input?.command ??
							b.input?.file_path ??
							b.input?.pattern ??
							b.input?.description ??
							"",
					)
						.replace(/\s+/g, " ")
						.slice(0, maxChars - 3)}`,
					ts: j.timestamp ?? null,
				});
		}
	}
	return out;
}

// W417.6 — cross-executor floor for the lane-card tail: every lane's
// subscribe (W417.1 spawn attach) tails coord-subscribe-<sid>.log, while
// only claude lanes have a parseable transcript. When the transcript
// yields nothing the card falls to the lane's last coord event.
export function subscribeTail(
	sid: string | null | undefined,
): { text: string; ts: string | null } | null {
	if (!sid) return null;
	const path = coordSubscribeLog(sid);
	if (!existsSync(path) || statSync(path).size < 1) return null;
	const size = statSync(path).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const buf = Buffer.alloc(size - start);
	try {
		const fd = openSync(path, "r");
		readSync(fd, buf, 0, buf.length, start);
		closeSync(fd);
	} catch {
		return null;
	}
	const lines = buf.toString("utf8").split("\n");
	if (start > 0) lines.shift(); // first line may be a partial record
	for (let i = lines.length - 1; i >= 0; i--) {
		const text = lines[i]
			// ESC built at runtime: a literal control char in a regex trips
			// noControlCharactersInRegex and a static-arg RegExp constructor
			// trips useRegexLiterals — runtime-built escapes satisfy both (W603)
			.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;
		return {
			text: text.slice(0, TAIL_MAX),
			ts: new Date(statSync(path).mtimeMs).toISOString(),
		};
	}
	return null;
}

// done→ready auto-start (W50): newest work.ready event per item, keyed by
// project + work id — value is the unblocker's id (who completed the blocking
// item). A stale event never sticks: taskShape only flags items still READY.
export function unblockedBy(): Map<string, string | null> {
	const m = new Map<string, string | null>();
	for (const r of db
		.query(
			"SELECT payload FROM events WHERE kind = 'work.ready' ORDER BY id DESC LIMIT 500",
		)
		.all() as { payload: string | null }[]) {
		const pl = payloadOf(r.payload);
		if (!pl?.work) continue;
		const key = `${String(pl.project ?? "")}\u0000${String(pl.work)}`;
		if (!m.has(key))
			m.set(key, pl.unblocked_by != null ? String(pl.unblocked_by) : null);
	}
	return m;
}

// W105 — the lane registry's executor/model/locality, stamped into facts at
// dispatch time (laneExecFacts, /api/start) and read back for any lane here.
// W682: the per-sid lane-model triple rides a 3s memo — taskShape spreads it
// for every row of every tasks feed (75 fact reads per cold compute on the
// profiled fleet); the facts change at dispatch time, not per poll.
const _laneModelCache = new Map<
	string,
	{
		at: number;
		v: {
			executor: string | null;
			model: string | null;
			locality: string | null;
		};
	}
>();
export function laneModelOf(sid: string | null | undefined): {
	executor: string | null;
	model: string | null;
	locality: string | null;
} {
	if (!sid) return { executor: null, model: null, locality: null };
	const hit = _laneModelCache.get(sid);
	if (hit && Date.now() - hit.at < 3_000) return hit.v;
	const get = (k: string): string | null =>
		(
			db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`lane.${sid}.${k}`) as { value: string } | null
		)?.value ?? null;
	const v = {
		executor: get("executor"),
		model: get("model"),
		locality: get("locality"),
	};
	_laneModelCache.set(sid, { at: Date.now(), v });
	return v;
}

// W835 merge-ready lane cards: one git observation per live lane whose
// registry row carries a local worktree. W663: batched through the lib's
// 10s memo (one probe window per worktree), this-host worktrees only —
// a foreign registry row's worktree path does not exist here.
export function laneGitSnapshot(
	rows: { sid: string; project: string | null; live: boolean }[],
): Record<string, LaneGitObservation> {
	const thisHost = hostname();
	const wtBySid = new Map<string, string>();
	for (const project of [
		...new Set(rows.map((r) => r.project).filter(Boolean)),
	]) {
		for (const l of registryRows(project as string)) {
			if (!l.worktree) continue;
			if (l.host !== undefined && l.host !== thisHost) continue;
			if (!wtBySid.has(l.sid)) wtBySid.set(l.sid, l.worktree);
		}
	}
	const out: Record<string, LaneGitObservation> = {};
	for (const r of rows) {
		if (!r.live) continue;
		const wt = wtBySid.get(r.sid);
		if (wt) out[r.sid] = gitObservation(wt);
	}
	return out;
}
