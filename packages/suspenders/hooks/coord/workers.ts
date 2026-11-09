// hooks/coord/workers.ts — W2886: plane-computed worker inventory.
// FEDERATED BY CONSTRUCTION (owner ruling 2026-11-09b): this process cannot
// see into remote compute — it only knows what the plane (this hub's
// governor.db) holds plus what peer hubs self-report over their buckle
// front. `coord workers` merges plane-visible lanes + the registration
// store + every other configured hub's own answer, every row stamped
// reported_by:<hub>; `coord hub <name> workers` returns ONLY that one hub's
// authoritative answer — no further federation. Unknown data renders as
// JSON `null`, never a fabricated guess (wire schema pinned by pi/W2887
// consult C323 2026-11-09).
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import type { GovernorStore } from "../lib/govdb/govdb.ts";
import { listLiveTargets, type SessionTarget } from "./addressing.ts";
import { hubTopology, stackHubsByLabel } from "./hubs.ts";
import { arg, db, die, dim, green } from "./shared.ts";
import { verbContract, wantsJson } from "./json-out.ts";

const activitySchema = z.object({
	at: z.number(),
	kind: z.string(),
	text: z.string().nullable().optional(),
});
const inferenceLegSchema = z.object({
	hub: z.string().nullable(),
	hub_id: z.string().nullable(),
	model: z.string().nullable(),
	since: z.number().nullable(),
	calls: z.number().nullable(),
});
export const workerSchema = z.object({
	sid: z.string(),
	name: z.string().nullable(),
	class: z.enum(["local", "remote"]),
	origin: z.object({ kind: z.string(), id: z.string().nullable() }).nullable(),
	compute: z
		.object({
			kind: z.string(),
			host: z.string().nullable(),
			region: z.string().nullable(),
			hub_id: z.string().nullable(),
		})
		.nullable(),
	inference: z.array(inferenceLegSchema),
	owner_sid: z.string().nullable(),
	rights: z.array(z.string()),
	state: z.string().nullable(),
	task: z.string().nullable(),
	activity: z.array(activitySchema),
	reported_by: z.string(),
	expires_in_s: z.number().nullable().optional(),
});
export type Worker = z.infer<typeof workerSchema>;

const workersContract = verbContract({
	workers: z.array(workerSchema),
	asOf: z.number(),
	errors: z.array(z.object({ scope: z.string(), message: z.string() })),
});

/** W2886: the registration store — long-lived remote drivers/executors
 *  announce on connect and heartbeat on change (owner ruling 2026-11-09b);
 *  rows here cover sessions this hub's own `sessions` table can never see
 *  (another machine, another process tree). Lazily created, consult-trust
 *  precedent (hooks/coord/consult-trust.ts). */
export function ensureWorkerRegistry(store: GovernorStore): void {
	store.run(`CREATE TABLE IF NOT EXISTS worker_registrations (
 sid TEXT PRIMARY KEY, name TEXT, description TEXT, purpose TEXT,
 origin_kind TEXT, origin_id TEXT,
 compute_kind TEXT, compute_host TEXT, compute_region TEXT, compute_hub_id TEXT,
 owner_sid TEXT, state TEXT, task TEXT, activity TEXT,
 started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
 )`);
}

interface RegistrationRow {
	sid: string;
	name: string | null;
	description: string | null;
	purpose: string | null;
	origin_kind: string | null;
	origin_id: string | null;
	compute_kind: string | null;
	compute_host: string | null;
	compute_region: string | null;
	compute_hub_id: string | null;
	owner_sid: string | null;
	state: string | null;
	task: string | null;
	activity: string | null;
	started_at: number;
	updated_at: number;
}

function readRegistrations(store: GovernorStore): Map<string, RegistrationRow> {
	ensureWorkerRegistry(store);
	const rows = store
		.query("SELECT * FROM worker_registrations")
		.all() as RegistrationRow[];
	return new Map(rows.map((r) => [r.sid, r]));
}

/** W2886/W2888 settled contract (01a186a5 directive): `register` accepts
 *  EITHER the flag form OR a single JSON positional payload (the wire shape
 *  @klh/pi-durable-workers' RegistrationClient emits) — one contract, two
 *  calling conventions, never a silent drop when one side sends the other's
 *  shape. Malformed/absent JSON falls through to flags. */
function registerPayload(rest: string[]): Record<string, string | null> {
	const positional = rest.find((t) => !t.startsWith("--"));
	if (positional?.trim().startsWith("{")) {
		try {
			const w = JSON.parse(positional) as Record<string, unknown>;
			const s = (k: string): string | null => {
				const v = w[k];
				return v == null ? null : String(v);
			};
			return {
				sid: s("sid"),
				name: s("name"),
				description: s("description"),
				purpose: s("purpose"),
				origin_kind: s("origin_kind"),
				origin_id: s("origin_id"),
				compute_kind: s("compute_kind"),
				compute_host: s("compute_host"),
				compute_region: s("compute_region"),
				compute_hub_id: s("hub_id"),
				owner_sid: s("owner_sid"),
				state: s("state"),
				task: s("task"),
				activity: s("activity"),
			};
		} catch {} // malformed JSON falls through to the flag form below
	}
	return {
		sid: arg("--as"),
		name: arg("--name"),
		description: arg("--description"),
		purpose: arg("--purpose"),
		origin_kind: arg("--origin-kind"),
		origin_id: arg("--origin-id"),
		compute_kind: arg("--compute-kind"),
		compute_host: arg("--host"),
		compute_region: arg("--region"),
		compute_hub_id: arg("--hub-id"),
		owner_sid: arg("--owner-sid"),
		state: arg("--state"),
		task: arg("--task"),
		activity: arg("--activity"),
	};
}

/** `coord workers register --as <sid> --name n [--description d] [--purpose p]
 *  [--origin-kind k] [--origin-id id] [--compute-kind k] [--host h]
 *  [--region r] [--hub-id id] [--owner-sid sid] [--state s] [--task t]
 *  [--activity json]` — announce-or-heartbeat upsert (W2886 registration
 *  contract). */
function registerWorker(store: GovernorStore, rest: string[]): void {
	const p = registerPayload(rest);
	const sid =
		p.sid ?? die("usage: workers register --as <sid> ... | register '<json>'");
	// W2886 review (01a186a5): registration is a SELF-report, never a
	// third-party write — the canonical process identity (SUSPENDERS_SID,
	// the same channel dispatch/bootstrap bind to) must match the sid being
	// announced, or a live caller could overwrite another worker's row.
	// Unset (manual CLI/tests) stays permissive, same trust posture as the
	// rest of this bus.
	const callerSid = process.env.SUSPENDERS_SID;
	if (callerSid && callerSid !== sid)
		die(`workers register: caller ${callerSid} cannot register as ${sid}`);
	ensureWorkerRegistry(store);
	const now = Date.now();
	const prior = store
		.query(
			"SELECT started_at, owner_sid FROM worker_registrations WHERE sid = ?",
		)
		.get(sid) as { started_at: number; owner_sid: string | null } | null;
	const ownerArg = p.owner_sid;
	// W2886 review (01a186a5): owner_sid is a one-time claim — a later
	// heartbeat cannot hijack it by passing a different --owner-sid; the
	// announcing sid re-asserts freely (bootstrap --as trust boundary).
	if (prior?.owner_sid && ownerArg && ownerArg !== prior.owner_sid)
		die(`workers register: sid ${sid} already owned by ${prior.owner_sid}`);
	const ownerSid = ownerArg ?? prior?.owner_sid ?? null;
	store.run(
		`INSERT INTO worker_registrations
			(sid, name, description, purpose, origin_kind, origin_id,
			 compute_kind, compute_host, compute_region, compute_hub_id,
			 owner_sid, state, task, activity, started_at, updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(sid) DO UPDATE SET
			name=excluded.name, description=excluded.description,
			purpose=excluded.purpose, origin_kind=excluded.origin_kind,
			origin_id=excluded.origin_id, compute_kind=excluded.compute_kind,
			compute_host=excluded.compute_host, compute_region=excluded.compute_region,
			compute_hub_id=excluded.compute_hub_id, owner_sid=excluded.owner_sid,
			state=excluded.state, task=excluded.task, activity=excluded.activity,
			updated_at=excluded.updated_at`,
		sid,
		p.name,
		p.description,
		p.purpose,
		p.origin_kind,
		p.origin_id,
		p.compute_kind,
		p.compute_host,
		p.compute_region,
		p.compute_hub_id,
		ownerSid,
		p.state,
		p.task,
		p.activity,
		prior?.started_at ?? now,
		now,
	);
	console.log(green(`✓ worker registered: ${sid}`));
}

/** rights[] computed BY THE PLANE for the asking lane (W2886 schema):
 *  owner — asker owns the item/session; steerable — a live local lane any
 *  asker can message/steer; read-only — everything else (remote rows
 *  inherit from their reporting hub, never upgraded locally). */
export { rightsFor as rightsForTest };

function rightsFor(
	askingSid: string | null,
	ownerSid: string | null,
	cls: "local" | "remote",
): string[] {
	if (ownerSid && askingSid === ownerSid) return ["owner"];
	if (cls === "remote") return ["read-only"];
	return ["steerable", "read-only"];
}

function fromTarget(target: SessionTarget, askingSid: string | null): Worker {
	return {
		sid: target.sid,
		name: target.sessionName || target.label || null,
		class: "local",
		origin: {
			kind: target.role === "worker" ? "session" : "controller",
			id: target.parent_sid,
		},
		compute: target.hub
			? { kind: "hub", host: null, region: null, hub_id: target.hub }
			: { kind: "local", host: hostname(), region: null, hub_id: null },
		inference: target.model
			? [
					{
						hub: target.hub || null,
						hub_id: target.hub || null,
						model: target.model,
						since: null,
						calls: null,
					},
				]
			: [],
		owner_sid: target.parent_sid,
		rights: rightsFor(askingSid, target.parent_sid, "local"),
		state: "RUNNING",
		task: target.sessionName || null,
		activity: [],
		reported_by: "plane:session",
	};
}

function fromRegistration(
	row: RegistrationRow,
	askingSid: string | null,
): Worker {
	let activity: Worker["activity"] = [];
	try {
		const parsed = row.activity ? JSON.parse(row.activity) : [];
		if (Array.isArray(parsed)) activity = parsed.slice(-20);
	} catch {} // malformed activity degrades to empty — never half-parsed
	return {
		sid: row.sid,
		name: row.name,
		class: "remote",
		origin: row.origin_kind
			? { kind: row.origin_kind, id: row.origin_id }
			: null,
		compute: row.compute_kind
			? {
					kind: row.compute_kind,
					host: row.compute_host,
					region: row.compute_region,
					hub_id: row.compute_hub_id,
				}
			: null,
		inference: [],
		owner_sid: row.owner_sid,
		rights: rightsFor(askingSid, row.owner_sid, "remote"),
		state: row.state,
		task: row.task,
		activity,
		reported_by: "hub:announce",
	};
}

/** This hub's own authoritative answer: plane-visible live sessions (never
 *  hidden behind the registration store) UNION registered rows the
 *  sessions table cannot see (another machine's announced lane) — an
 *  unregistered live session still surfaces (W2888 surfacing law), tagged
 *  by plane provenance rather than hub:announce. */
export function localWorkers(askingSid: string | null): Worker[] {
	const targets = listLiveTargets();
	const bySid = new Set(targets.map((t) => t.sid));
	const regs = readRegistrations(db);
	const out = targets.map((t) => fromTarget(t, askingSid));
	for (const [sid, row] of regs)
		if (!bySid.has(sid)) out.push(fromRegistration(row, askingSid));
	return out;
}

/** W2886: fetch one hub's own `coord workers --json` answer over its buckle
 *  front — same token-file + timeout contract as fetchHubModels
 *  (hooks/coord/hubs.ts); unreachable or no credential returns null, never
 *  a guess. Scope caveat: this item lands the CLI contract only — the peer hub must
 *  itself serve `/v1/workers` (a buckle-gateway route, out of this item's
 *  packages/suspenders scope); until that route exists, federation to a
 *  real remote hub degrades to an errors[] entry, exercised here only via
 *  a stub server. */
export async function fetchHubWorkers(
	base: string,
	tokenFile: string | undefined,
): Promise<Worker[] | null> {
	if (!tokenFile) return null;
	try {
		const key = readFileSync(tokenFile, "utf8").trim();
		if (!key) return null;
		const response = await fetch(new URL("/v1/workers", base), {
			headers: { Authorization: `Bearer ${key}` },
			redirect: "error",
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as { workers?: unknown };
		const parsed = z.array(workerSchema).safeParse(payload.workers);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function renderTable(workers: Worker[]): void {
	if (!workers.length) {
		console.log(dim("no workers — plane empty, no registrations"));
		return;
	}
	for (const w of workers) {
		const dot = w.class === "local" ? green("●") : dim("○");
		console.log(
			`${dot} ${w.sid.slice(0, 12)}  ${w.name ?? dim("unnamed")}  [${w.rights.join(",")}]  ${dim(w.reported_by)}`,
		);
	}
}

/** `coord workers [register ...] | [--json] [--as <asking-sid>]` — the
 *  federated merge: this hub's localWorkers() plus every OTHER configured,
 *  up hub's own answer (fetchHubWorkers), each foreign row keeping that
 *  hub's self-reported reported_by. A hub that cannot be reached contributes
 *  an errors[] entry, never a silent gap. */
export async function cmdWorkers(rest: string[]): Promise<void> {
	if (rest[0] === "register") return registerWorker(db, rest.slice(1));
	const askingSid = arg("--as");
	const mine = localWorkers(askingSid);
	const errors: { scope: string; message: string }[] = [];
	const federated: Worker[] = [];
	if (!rest.includes("--local-only")) {
		const { labels, candidates } = hubTopology();
		const stackHubs = stackHubsByLabel();
		for (const [key, label] of labels) {
			const cands = candidates.get(key) ?? [];
			const buckle = cands.find((c) => c.source.includes("buckle"));
			if (!buckle) continue;
			const tokenFile = stackHubs.get(key)?.token_file;
			const rows = await fetchHubWorkers(buckle.url, tokenFile);
			if (rows === null)
				errors.push({ scope: label, message: "unreachable or unconfigured" });
			else federated.push(...rows);
		}
	}
	const workers = [...mine, ...federated];
	if (wantsJson(rest)) {
		workersContract.emit({
			schema_version: 1,
			verb: "workers",
			workers,
			asOf: Date.now(),
			errors,
		});
		return;
	}
	renderTable(workers);
}

/** `coord hub <name> workers [--json]` — that ONE hub's authoritative
 *  answer only (no further federation): local plane state if `<name>`
 *  resolves to this host, else fetched verbatim over its buckle front. */
export async function cmdHub(rest: string[]): Promise<void> {
	const name = rest[0];
	const sub = rest[1];
	if (!name || sub !== "workers") die("usage: hub <name> workers [--json]");
	const { labels, candidates } = hubTopology();
	const key = name.toLowerCase();
	if (!labels.has(key)) die(`hub "${name}" not in hubs.json or stack.json`);
	const cands = candidates.get(key) ?? [];
	const buckle = cands.find((c) => c.source.includes("buckle"));
	const askingSid = arg("--as");
	let workers: Worker[];
	let errors: { scope: string; message: string }[] = [];
	if (!buckle) {
		workers = localWorkers(askingSid);
	} else {
		const tokenFile = arg("--token") ?? stackHubsByLabel().get(key)?.token_file;
		const rows = await fetchHubWorkers(buckle.url, tokenFile);
		if (rows === null) {
			workers = [];
			errors = [{ scope: name, message: "unreachable or unconfigured" }];
		} else workers = rows;
	}
	if (wantsJson(rest)) {
		workersContract.emit({
			schema_version: 1,
			verb: "hub-workers",
			workers,
			asOf: Date.now(),
			errors,
		});
		return;
	}
	renderTable(workers);
}
