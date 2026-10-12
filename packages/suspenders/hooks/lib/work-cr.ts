// hooks/lib/work-cr.ts — W352 work delegation over the W160/W193 CR channel.
// Origin half: map a work-graph item → CR spec, declare it on the hub
// (buckle:admin:WRITE_, POST /federation/cr). Spoke half: reconcile work.add
// CRs from a pulled manifest into this machine's work graph (governor.db
// work_items) and report status back (buckle:spoke:WRITE_, POST
// /federation/cr/:id/status). Lifecycle honesty: the spoke drives
// declared→delivered→applied; applied→verified is the hub's probe-gated call
// and no work@ probe is registered hub-side (verified is never granted on
// faith, W160) — the delegation e2e terminus is `applied`. `failed` carries
// reconcile errors back. Re-runs converge: 409 buckle.cr_state and 403
// buckle.cr_claimed are treated as already-converged, never cycle-fatal.
import { openMemoryStore, projectIdentity } from "./govdb.ts";
import { readCapped } from "./federation.ts";

/** The CR action a spoke reconciles into its work graph. */
export const WORK_CR_ACTION = "work.add";
/** Target namespace for work-graph CRs: work@<origin-item-id>. */
export const WORK_CR_TARGET_PREFIX = "work@";

/** CR row as it rides the manifest cr_queue (payload/origin are JSON
 *  strings there — the hub's crQueue() serves raw rows) and as the declare
 *  response returns them (parsed). string | object keeps both honest. */
export interface CrQueueRow {
	id: string;
	action: string;
	target: string;
	declared_at: string;
	state: string;
	note?: string | null;
	payload?: string | Record<string, unknown> | null;
	origin?: string | Record<string, unknown> | null;
}

export interface DeclareOpts {
	hubUrl: string;
	adminKey: string;
	spec: {
		id: string;
		action: string;
		target: string;
		payload?: unknown;
		origin: { system: string; actor: string };
	};
	timeoutMs?: number;
}

export interface DeclareResult {
	ok: boolean;
	status: number;
	cr: CrQueueRow | null;
	reason: string | null;
}

/** Origin half: one authenticated declare POST. 201 = declared (idempotent
 *  hub-side on id — a re-declare returns the existing row); anything else is
 *  surfaced with the hub's error envelope, never thrown. */
export async function declareWorkCr(opts: DeclareOpts): Promise<DeclareResult> {
	const res = await fetch(`${opts.hubUrl}/federation/cr`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${opts.adminKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(opts.spec),
		signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
	});
	const body = await readCapped(res).catch(() => null);
	if (!res.ok) {
		const why =
			body !== null &&
			typeof body === "object" &&
			"error" in body &&
			typeof body.error === "object" &&
			body.error !== null &&
			"message" in body.error
				? String((body.error as { message: unknown }).message)
				: `HTTP ${String(res.status)}`;
		return { ok: false, status: res.status, cr: null, reason: why };
	}
	return { ok: true, status: res.status, cr: body as CrQueueRow, reason: null };
}

/** Admin GET of the hub CR queue (bin `list`). Throws on hub-down. */
export async function fetchCrQueue(
	hubUrl: string,
	adminKey: string,
	timeoutMs = 5000,
): Promise<CrQueueRow[]> {
	const res = await fetch(`${hubUrl}/federation/cr`, {
		headers: { authorization: `Bearer ${adminKey}` },
		signal: AbortSignal.timeout(timeoutMs),
	});
	const body = await readCapped(res);
	const q = (body as { cr_queue?: unknown }).cr_queue;
	if (!Array.isArray(q)) throw new Error("no cr_queue in admin list");
	return q as CrQueueRow[];
}

export interface ReportOpts {
	hubUrl: string;
	spokeKey: string;
	id: string;
	state: string;
	note?: string | null;
	timeoutMs?: number;
}

export interface ReportResult {
	/** The hub recorded the transition. */
	ok: boolean;
	/** Another puller already advanced/claims this CR — converged, skip. */
	converged: boolean;
	status: number;
	code: string | null;
	reason: string | null;
}

/** Spoke half: one status report. The hub enforces lifecycle + claim; a 409
 *  (state already moved) or 403 (claimed elsewhere) means this spoke's view
 *  was stale — that is convergence, not failure. */
export async function reportCrStatus(opts: ReportOpts): Promise<ReportResult> {
	const headers: Record<string, string> = {
		authorization: `Bearer ${opts.spokeKey}`,
		"content-type": "application/json",
	};
	const res = await fetch(
		`${opts.hubUrl}/federation/cr/${encodeURIComponent(opts.id)}/status`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ state: opts.state, note: opts.note ?? null }),
			signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
		},
	);
	const body = await readCapped(res).catch(() => null);
	if (res.ok)
		return {
			ok: true,
			converged: false,
			status: res.status,
			code: null,
			reason: null,
		};
	const code =
		body !== null &&
		typeof body === "object" &&
		"error" in body &&
		typeof body.error === "object" &&
		body.error !== null &&
		"code" in body.error
			? String((body.error as { code: unknown }).code)
			: null;
	const converged =
		res.status === 409 || (res.status === 403 && code === "buckle.cr_claimed");
	return {
		ok: false,
		converged,
		status: res.status,
		code,
		reason:
			res.status === 409 ? "already advanced" : `HTTP ${String(res.status)}`,
	};
}

// ─── spoke reconcile ────────────────────────────────────────────────────────

export interface ReconcileOpts {
	manifest: { cr_queue?: Array<Record<string, unknown>> } | null;
	/** The spoke's work graph handle (real: openGovernorDb(); tests/sim: an
	 *  in-memory store shaped like it). */
	db: {
		run(sql: string, ...params: unknown[]): unknown;
		query(sql: string): {
			get(...p: unknown[]): unknown;
			all(...p: unknown[]): unknown[];
		};
	};
	project?: string;
	hubUrl: string;
	spokeKey: string | null;
	timeoutMs?: number;
	nowMs?: number;
}

export interface ReconcileResult {
	scanned: number;
	delivered: number;
	applied: number;
	failed: number;
	skipped: number;
	errors: string[];
}

const WORK_ITEMS_DDL =
	"CREATE TABLE IF NOT EXISTS work_items (project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL DEFAULT 'READY', priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1, requires TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))";

// the audit bus the graph write emits into (real governor.db has it; a
// memory-shaped graph in tests/sim does not until ensured here)
const EVENTS_DDL =
	"CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)";

/** Lenient JSON field parse (manifest rows carry payload/origin as JSON
 *  strings; the declare response returns them parsed). */
function jsonFieldOf(v: unknown): Record<string, unknown> {
	if (typeof v === "string") {
		try {
			const p: unknown = JSON.parse(v);
			return typeof p === "object" && p !== null
				? (p as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return typeof v === "object" && v !== null
		? (v as Record<string, unknown>)
		: {};
}

function payloadOf(row: CrQueueRow): Record<string, unknown> {
	return jsonFieldOf(row.payload);
}

/** Ensure the delegated item exists in the spoke graph — idempotent on
 *  (project, id); the CR id IS the local item id (provenance: created_by
 *  names the channel, description carries the origin record). */
export function ensureDelegatedItem(
	db: ReconcileOpts["db"],
	project: string,
	row: CrQueueRow,
	nowMs: number,
): boolean {
	db.run(WORK_ITEMS_DDL);
	db.run(EVENTS_DDL);
	const existing = db
		.query("SELECT id FROM work_items WHERE project = ? AND id = ?")
		.get(project, row.id);
	if (existing !== null && existing !== undefined) return false;
	const payload = payloadOf(row);
	const title =
		typeof payload.title === "string" && payload.title.length > 0
			? payload.title
			: row.target;
	const desc =
		typeof payload.description === "string" ? payload.description : "";
	const origin = jsonFieldOf(row.origin);
	const originSystem =
		typeof origin.system === "string" ? origin.system : "unknown";
	const originActor =
		typeof origin.actor === "string" ? origin.actor : "unknown";
	const priority =
		typeof payload.priority === "number" && Number.isFinite(payload.priority)
			? Math.trunc(payload.priority)
			: 0;
	db.run(
		"INSERT INTO work_items (project, id, parent_id, title, description, state, priority, owner_sid, created_by, scope, why_parallel, result_sha, required, requires, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, 'READY', ?, NULL, 'federation-cr', NULL, NULL, NULL, 1, NULL, ?, ?)",
		project,
		row.id,
		title,
		desc.length > 0
			? `${desc} (delegated via CR ${row.id} from ${originSystem}/${originActor})`
			: `delegated via CR ${row.id} from ${originSystem}/${originActor}`,
		priority,
		nowMs,
		nowMs,
	);
	db.run(
		"INSERT INTO events (ts, source, kind, scope, payload, target) SELECT ?, 'federation-cr', 'work.added', scope, ?, NULL FROM work_items WHERE project = ? AND id = ?",
		nowMs,
		JSON.stringify({ work: row.id, project, cr: row.id, origin: originActor }),
		project,
		row.id,
	);
	return true;
}

/** One reconcile pass over a pulled manifest: declared → report delivered,
 *  then reconcile into the local graph → report applied; reconcile failure
 *  → report failed with the note. Terminal CRs skip. Never throws for a
 *  hub-down blip — errors land in the result (the pull loop degrades). */
export async function reconcileWorkCrs(
	opts: ReconcileOpts,
): Promise<ReconcileResult> {
	const out: ReconcileResult = {
		scanned: 0,
		delivered: 0,
		applied: 0,
		failed: 0,
		skipped: 0,
		errors: [],
	};
	const rows = opts.manifest?.cr_queue ?? [];
	for (const raw of rows) {
		if (typeof raw !== "object" || raw === null) continue;
		const row = raw as CrQueueRow;
		if (
			row.action !== WORK_CR_ACTION ||
			typeof row.target !== "string" ||
			!row.target.startsWith(WORK_CR_TARGET_PREFIX)
		)
			continue;
		out.scanned++;
		if (
			row.state === "verified" ||
			row.state === "reported-up" ||
			row.state === "failed"
		) {
			out.skipped++;
			continue;
		}
		if (typeof opts.spokeKey !== "string" || opts.spokeKey.length === 0) {
			out.skipped++;
			out.errors.push(`${row.id}: no spoke token (BUCKLE_SPOKE_TOKEN)`);
			continue;
		}
		if (row.state === "declared") {
			const d = await reportCrStatus({
				hubUrl: opts.hubUrl,
				spokeKey: opts.spokeKey,
				id: row.id,
				state: "delivered",
				timeoutMs: opts.timeoutMs,
			});
			if (!d.ok && !d.converged) {
				out.errors.push(
					`${row.id}: delivered report failed — ${d.reason ?? d.code}`,
				);
				continue;
			}
			out.delivered++;
		}
		try {
			ensureDelegatedItem(
				opts.db,
				opts.project ?? projectIdentity(),
				row,
				opts.nowMs ?? Date.now(),
			);
		} catch (e) {
			out.failed++;
			out.errors.push(`${row.id}: reconcile failed — ${String(e)}`);
			const f = await reportCrStatus({
				hubUrl: opts.hubUrl,
				spokeKey: opts.spokeKey,
				id: row.id,
				state: "failed",
				note: String(e).slice(0, 200),
				timeoutMs: opts.timeoutMs,
			}).catch(() => null);
			if (f === null || !f.ok)
				out.errors.push(`${row.id}: failed-report did not land`);
			continue;
		}
		if (row.state !== "applied") {
			const a = await reportCrStatus({
				hubUrl: opts.hubUrl,
				spokeKey: opts.spokeKey,
				id: row.id,
				state: "applied",
				timeoutMs: opts.timeoutMs,
			});
			if (!a.ok && !a.converged) {
				out.errors.push(
					`${row.id}: applied report failed — ${a.reason ?? a.code}`,
				);
				continue;
			}
		}
		out.applied++;
	}
	return out;
}

/** Reconcile target for tests/sim: an in-memory graph shaped like governor.db. */
export function openMemoryWorkGraph(): ReconcileOpts["db"] {
	return openMemoryStore() as unknown as ReconcileOpts["db"];
}
