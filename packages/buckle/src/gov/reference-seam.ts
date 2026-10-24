// src/gov/reference-seam.ts — W1114: the W233-inline hub-side federation
// providers restored as REFERENCE gov-seam factories. W233.1/.2/.3 moved
// the real implementations to the enterprise overlay and left the public
// core provider-less (honest 501s); the W352/W171 suspenders e2e suites
// (declare/reconcile lifecycle, rollup ingest/read) ride the SAME
// ManifestCrFactory/UsageIngestFactory contract and need a provider with
// the real laws to run against. This module ports those implementations
// byte-faithfully (git history: federation-manifest.ts + federation-usage.ts
// as of daf35b2a/16c1cd85~1) behind createReferenceGovSeam(). The
// enterprise overlay stays the production source — this file only serves
// callers that wire the seam explicitly (tests/sim); startServer without
// auth factories still answers honest 501s (solo posture unchanged).
// Config-over-code: the self-report opt-in reads the hub's policy.yaml
// (gateway.federation.self_report.teams) — never hardcoded.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { GatewayPolicy } from "../policy.ts";
import type {
	CrActor,
	CrProbe,
	CrRow,
	CrVerdict,
	FedManifest,
	FedUsageReport,
	ManifestCrFactory,
	UsageIngestFactory,
} from "./hub-seam.ts";
import type { GovSeamFactories } from "./overlay-loader.ts";

// ─── shared DDL (idempotent — the factory owns its tables) ─────────────────

const CR_QUEUE_DDL = `CREATE TABLE IF NOT EXISTS federation_cr_queue (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'declared',
  note TEXT,
  updated_at INTEGER,
  reported_at INTEGER,
  payload TEXT,
  origin TEXT,
  verified_at INTEGER,
  claimed_by TEXT,
  claimed_at INTEGER
)`;

const USAGE_ROLLUP_DDL = `CREATE TABLE IF NOT EXISTS federation_usage_rollup (
  spoke TEXT NOT NULL,
  team TEXT NOT NULL DEFAULT '',
  bucket INTEGER NOT NULL,
  model_class TEXT NOT NULL,
  in_tok INTEGER NOT NULL DEFAULT 0,
  out_tok INTEGER NOT NULL DEFAULT 0,
  cache_r INTEGER NOT NULL DEFAULT 0,
  cache_c INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (spoke, bucket, model_class)
)`;

const AID_ROLLUP_DDL = `CREATE TABLE IF NOT EXISTS federation_aid_rollup (
  spoke TEXT NOT NULL,
  team TEXT NOT NULL DEFAULT '',
  bucket INTEGER NOT NULL,
  aid TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  injected INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  tok_injected INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (spoke, bucket, aid, domain)
)`;

// ─── policy manifest content (W154/W164/W171) ──────────────────────────────

/** W171 phase 3: the per-team self-report rule. Present in the manifest
 *  ONLY when the hub's policy opts teams in (default OFF: absent rule = no
 *  reporting). The rule rides the content-addressed version, so a flip is
 *  a version change spokes already detect. */
export const SELF_REPORT_RULE_ID = "federation.self_report";

export function selfReportTeams(policy: GatewayPolicy): string[] {
	const teams = policy.federation?.self_report?.teams ?? [];
	return [...new Set(teams.filter((t) => typeof t === "string" && t))].sort();
}

export function buildRules(
	policy: GatewayPolicy,
): Array<Record<string, unknown>> {
	const rules: Array<Record<string, unknown>> = [
		{
			id: "gateway.knobs",
			kind: "gateway",
			target: null,
			data: {
				num_retries: policy.num_retries ?? null,
				allowed_fails: policy.allowed_fails ?? null,
				cooldown_time: policy.cooldown_time ?? null,
			},
		},
	];
	for (const [group, tiers] of Object.entries(policy.fallbacks ?? {})) {
		rules.push({
			id: `ladder.${group}`,
			kind: "ladder",
			target: group,
			tiers,
		});
	}
	for (const [group, tags] of Object.entries(policy.tags ?? {})) {
		rules.push({ id: `tags.${group}`, kind: "tags", target: group, tags });
	}
	for (const [name, block] of Object.entries(policy.aids ?? {})) {
		rules.push({ id: `aids.${name}`, kind: "aids", target: name, block });
	}
	// W171: the self-report rule only when teams are opted in — default OFF
	// is structural (absent rule, not a false flag).
	const teams = selfReportTeams(policy);
	if (teams.length > 0)
		rules.push({
			id: SELF_REPORT_RULE_ID,
			kind: "federation",
			target: null,
			data: { teams },
		});
	return rules;
}

/** Content-addressed manifest version: same rules → same version, so a
 *  spoke detects policy change by comparing one string. */
export function manifestVersion(rules: Array<Record<string, unknown>>): string {
	return `fed-${createHash("sha256")
		.update(JSON.stringify(rules))
		.digest("hex")
		.slice(0, 12)}`;
}

// ─── CR origination + lifecycle (W160/W193) ────────────────────────────────

/** W160 CR origination: who/what declared, when (declared_at). system names
 *  the originate side — belt (LLM-policy) or suspenders (work-graph/rules). */
export interface CrOrigin {
	system: string;
	actor: string;
}

export interface CrSpec {
	id: string;
	action: string;
	target: string;
	/** The change the spoke must reconcile (JSON-serializable). */
	payload?: unknown;
	/** Required: origination record (who declared, on whose behalf). */
	origin: CrOrigin;
}

export type CrDeclare =
	| { ok: true; row: CrRow }
	| { ok: false; code: string; why: string };

/** The domain-separation guard, structural (owner law: the CR channel NEVER
 *  carries private-domain content). Deep-walks a declared CR's payload and
 *  origin for W154 provenance markers — any `data_domain: "private"` anywhere
 *  rejects the declare — and returns the offending path, or null when clean.
 *  `data_domain: "hub"` and absence pass. */
export function crPrivateDomainPath(value: unknown, path = "$"): string | null {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const hit = crPrivateDomainPath(value[i], `${path}[${String(i)}]`);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			const child = `${path}.${k}`;
			if (k === "data_domain" && v === "private") return child;
			const hit = crPrivateDomainPath(v, child);
			if (hit !== null) return hit;
		}
	}
	return null;
}

/** Declare-time validation: body shape + required origin record + the
 *  structural domain guard, before any row exists. */
function crDeclareRejection(spec: CrSpec): CrDeclare | null {
	if (typeof spec.id !== "string" || spec.id.length === 0)
		return { ok: false, code: "buckle.cr_body", why: "missing id" };
	if (typeof spec.action !== "string" || spec.action.length === 0)
		return { ok: false, code: "buckle.cr_body", why: "missing action" };
	if (typeof spec.target !== "string" || spec.target.length === 0)
		return { ok: false, code: "buckle.cr_body", why: "missing target" };
	if (
		spec.origin === null ||
		typeof spec.origin !== "object" ||
		typeof spec.origin.system !== "string" ||
		spec.origin.system.length === 0 ||
		typeof spec.origin.actor !== "string" ||
		spec.origin.actor.length === 0
	)
		return {
			ok: false,
			code: "buckle.cr_origin",
			why: "origin required: {system, agent} — CRs record who/what declared them",
		};
	const hit =
		crPrivateDomainPath(spec.payload) ?? crPrivateDomainPath(spec.origin);
	if (hit !== null)
		return {
			ok: false,
			code: "buckle.cr_private_domain",
			why: `content at ${hit} is marked/derived data_domain=private — the CR channel never carries private-domain content (domain separation, federation doc)`,
		};
	return null;
}

/** Hub-side CR origination seam (W160): belt originates LLM-policy CRs,
 *  central suspenders work-graph/rules CRs — same queue, same lifecycle.
 *  Records the origin (who/what, declared_at); the structural domain guard
 *  runs HERE, before any row exists. Idempotent on id. */
export function declareCR(db: Database, spec: CrSpec): CrDeclare {
	const rej = crDeclareRejection(spec);
	if (rej !== null) return rej;
	const payloadJson =
		spec.payload === undefined ? null : JSON.stringify(spec.payload);
	db.query(
		"INSERT INTO federation_cr_queue (id, action, target, declared_at, state, payload, origin) VALUES (?, ?, ?, ?, 'declared', ?, ?) ON CONFLICT(id) DO NOTHING",
	).run(
		spec.id,
		spec.action,
		spec.target,
		new Date().toISOString(),
		payloadJson,
		JSON.stringify(spec.origin),
	);
	return {
		ok: true,
		row: db
			.query("SELECT * FROM federation_cr_queue WHERE id = ?")
			.get(spec.id) as CrRow,
	};
}

/** Linear lifecycle declared→delivered→applied→verified→reported-up, plus
 *  failed from any live state; reported-up/failed are terminal. */
const CR_NEXT: Record<string, string | null> = {
	declared: "delivered",
	delivered: "applied",
	applied: "verified",
	verified: "reported-up",
	"reported-up": null,
	failed: null,
};

function nextCrState(state: string): string | null {
	return state in CR_NEXT ? (CR_NEXT[state] ?? null) : null;
}

function crLive(state: string): boolean {
	return nextCrState(state) !== null;
}

/** Spoke-reported CR state transition, enforced server-side: only the
 *  lifecycle's next state (or failed-from-live) is accepted; 409-mapped
 *  rejection otherwise. applied→verified additionally requires the hub's
 *  verification probe to pass. Returns the fresh row for the response. */
export function transitionCR(
	db: Database,
	id: string,
	to: string,
	note: string | null,
	probe?: CrProbe,
	actor?: CrActor,
):
	| { ok: true; row: CrRow }
	| { ok: false; status: number; code: string; why: string } {
	const current = db
		.query("SELECT * FROM federation_cr_queue WHERE id = ?")
		.get(id) as CrRow | null;
	if (current === null)
		return {
			ok: false,
			status: 404,
			code: "buckle.no_route",
			why: `no such CR: ${id}`,
		};
	const allowed = nextCrState(current.state);
	const failedOk = to === "failed" && crLive(current.state);
	if (allowed === null || (to !== allowed && !failedOk)) {
		return {
			ok: false,
			status: 409,
			code: "buckle.cr_state",
			why: `CR ${id} is '${current.state}'; expected '${String(allowed)}'${to === "failed" ? " or failed" : ""}`,
		};
	}
	if (to === "verified" && current.state === "applied") {
		if (probe === undefined)
			return {
				ok: false,
				status: 409,
				code: "buckle.cr_probe",
				why: `CR ${id}: verified requires a hub verification probe; none registered for target '${current.target}'`,
			};
		const v = probe(current);
		if (!v.ok)
			return {
				ok: false,
				status: 409,
				code: "buckle.cr_probe",
				why: `CR ${id}: verification probe failed — ${v.why ?? "target not confirmed"}`,
			};
	}
	const claimant = actor ?? null;
	if (
		current.claimed_by !== null &&
		claimant !== null &&
		claimant.admin === false &&
		claimant.id !== current.claimed_by
	)
		return {
			ok: false,
			status: 403,
			code: "buckle.cr_claimed",
			why: `CR ${id} is claimed by '${current.claimed_by}'; reports only from the claimant (or hub-admin)`,
		};
	const ts = Date.now();
	db.query(
		"UPDATE federation_cr_queue SET state = ?, note = ?, updated_at = ?, reported_at = ?, verified_at = ?, claimed_by = COALESCE(claimed_by, ?), claimed_at = COALESCE(claimed_at, ?) WHERE id = ?",
	).run(
		to,
		note,
		ts,
		to === "reported-up" ? ts : current.reported_at,
		to === "verified" ? ts : current.verified_at,
		claimant?.id ?? null,
		claimant === null ? null : ts,
		id,
	);
	return {
		ok: true,
		row: db
			.query("SELECT * FROM federation_cr_queue WHERE id = ?")
			.get(id) as CrRow,
	};
}

/** The CR queue a spoke must reconcile, oldest first. */
export function crQueue(db: Database): CrRow[] {
	return db
		.query("SELECT * FROM federation_cr_queue ORDER BY declared_at, id")
		.all() as CrRow[];
}

/** W160: the built-in policy-revision probe — RE-READS routing-policy.json
 *  from disk at verify time (the hub re-reads the target surface; a spoke's
 *  word alone never grants `verified`). Registered for `policy@N` and
 *  `routing-policy@N` targets (longest-prefix match). W1253: the policy file
 *  is JSON — read-both names, JSON-only parse. */
export function policyRevisionProbe(policyPath: string | undefined): CrProbe {
	return (cr: CrRow): { ok: boolean; why: string | null } => {
		const m = /@(\d+)$/.exec(cr.target);
		if (m === null)
			return { ok: false, why: `no revision in target '${cr.target}'` };
		const want = Number(m[1]);
		if (policyPath === undefined)
			return { ok: false, why: "no policy surface wired on this hub" };
		let have = 0;
		try {
			// doc-level `version` — parsePolicy keeps only the gateway block.
			// Read-both (W1253): the .json law name wins, the legacy .yaml NAME
			// is honored only while its content is already JSON.
			const jsonPath = policyPath.replace(/\.ya?ml$/i, ".json");
			const doc = JSON.parse(
				readFileSync(existsSync(jsonPath) ? jsonPath : policyPath, "utf8"),
			) as {
				version?: number;
			} | null;
			have = doc?.version ?? 0;
		} catch (e) {
			return { ok: false, why: `policy surface unreadable: ${String(e)}` };
		}
		return have >= want
			? { ok: true, why: null }
			: {
					ok: false,
					why: `hub policy revision ${String(have)} < CR target ${String(want)}`,
				};
	};
}

// ─── usage/aid rollup store (W171) ─────────────────────────────────────────

// The five routing-doctrine model classes — the coarse buckets the report
// carries INSTEAD of model names. Mirror of suspenders hooks/lib/usage.ts
// GROUPS (the cross-package contract; assert-equal in both test suites).
export const MODEL_CLASSES = [
	"flash",
	"full",
	"luna",
	"local",
	"other",
] as const;

export type ModelClass = (typeof MODEL_CLASSES)[number];

// Wire shape the spoke POSTs; the hub stamps spoke = principal keyId, so
// the body carries NO identities — team membership is the only attribution.
export interface SelfReportWindow {
	bucket: number;
	classes: Partial<Record<ModelClass, UsageClassRow>>;
	aids: AidRow[];
}

export interface SelfReportPayload {
	team: string;
	windows: SelfReportWindow[];
}

export interface UsageClassRow {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
}

export interface AidRow {
	aid: string;
	domain: string;
	injected: number;
	skipped: number;
	tok_injected: number;
}

// caps — one POST backfills at most a week of hourly windows
const MAX_WINDOWS = 168;
const MAX_AIDS = 32;
const MAX_STR = 64;
const MAX_TOKENS = 1e12;
const MAX_AID_COUNT = 1e9;

const isCount = (v: unknown, cap = MAX_TOKENS): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= cap;

const isLabel = (v: unknown): v is string =>
	typeof v === "string" && v.length > 0 && v.length <= MAX_STR;

/** Parse one class row; null on any shape violation (strict allowlist). */
function classRow(v: unknown): UsageClassRow | null {
	if (v === null || typeof v !== "object") return null;
	const r = v as Record<string, unknown>;
	if (Object.keys(r).length !== 5) return null;
	if (
		!isCount(r.in_tok) ||
		!isCount(r.out_tok) ||
		!isCount(r.cache_r) ||
		!isCount(r.cache_c) ||
		!isCount(r.requests)
	)
		return null;
	return {
		in_tok: r.in_tok,
		out_tok: r.out_tok,
		cache_r: r.cache_r,
		cache_c: r.cache_c,
		requests: r.requests,
	};
}

/** Parse one aid row; error string on any shape violation. */
function aidRow(v: unknown): AidRow | string {
	if (v === null || typeof v !== "object") return "aid row must be an object";
	const r = v as Record<string, unknown>;
	for (const k of Object.keys(r))
		if (
			k !== "aid" &&
			k !== "domain" &&
			k !== "injected" &&
			k !== "skipped" &&
			k !== "tok_injected"
		)
			return `unknown key window.aids[].${k}`;
	if (!isLabel(r.aid)) return "aid.aid must be a 1..64 char string";
	if (!isLabel(r.domain)) return "aid.domain must be a 1..64 char string";
	if (
		!isCount(r.injected, MAX_AID_COUNT) ||
		!isCount(r.skipped, MAX_AID_COUNT) ||
		!isCount(r.tok_injected, MAX_AID_COUNT)
	)
		return "aid counts must be non-negative integers";
	return {
		aid: r.aid,
		domain: r.domain,
		injected: r.injected,
		skipped: r.skipped,
		tok_injected: r.tok_injected,
	};
}

/** Parse one hourly window; error string on any violation. Strict
 *  allowlist: unknown keys reject, classes keys ⊆ MODEL_CLASSES, aid rows
 *  carry only the five aggregate fields. */
function windowFromUnknown(w: unknown): SelfReportWindow | string {
	if (w === null || typeof w !== "object") return "window must be an object";
	const r = w as Record<string, unknown>;
	for (const k of Object.keys(r))
		if (k !== "bucket" && k !== "classes" && k !== "aids")
			return `unknown key window.${k}`;
	if (!isCount(r.bucket, Number.MAX_SAFE_INTEGER))
		return "window.bucket must be a non-negative integer";
	const c = r.classes ?? {};
	if (c === null || typeof c !== "object" || Array.isArray(c))
		return "window.classes must be an object";
	const classes: Partial<Record<ModelClass, UsageClassRow>> = {};
	for (const [k, v] of Object.entries(c)) {
		const ok = (MODEL_CLASSES as readonly string[]).includes(k);
		if (!ok) return `unknown model class '${k}'`;
		const row = classRow(v);
		if (row === null)
			return `window.classes.${k} must be five non-negative integers`;
		classes[k as ModelClass] = row;
	}
	const aids: AidRow[] = [];
	const a = r.aids ?? [];
	if (!Array.isArray(a)) return "window.aids must be an array";
	if (a.length > MAX_AIDS) return `window.aids exceeds ${String(MAX_AIDS)}`;
	for (const row of a) {
		const aid = aidRow(row);
		if (typeof aid === "string") return aid;
		aids.push(aid);
	}
	return { bucket: r.bucket, classes, aids };
}

/** Strict allowlist validation of one self-report POST body: exact key
 *  sets everywhere, non-negative safe integers, ≤cap windows/aids. Returns
 *  the offending path on the first violation. */
export function validateSelfReport(
	body: unknown,
): { ok: true; payload: SelfReportPayload } | { ok: false; why: string } {
	if (body === null || typeof body !== "object")
		return { ok: false, why: "body must be an object" };
	const b = body as Record<string, unknown>;
	for (const k of Object.keys(b))
		if (k !== "team" && k !== "windows")
			return { ok: false, why: `unknown key body.${k}` };
	if (!isLabel(b.team))
		return { ok: false, why: "body.team must be a 1..64 char string" };
	const wins = b.windows;
	if (!Array.isArray(wins) || wins.length === 0 || wins.length > MAX_WINDOWS)
		return {
			ok: false,
			why: `body.windows must be 1..${String(MAX_WINDOWS)} hourly windows`,
		};
	const windows: SelfReportWindow[] = [];
	for (const w of wins) {
		const out = windowFromUnknown(w);
		if (typeof out === "string") return { ok: false, why: out };
		windows.push(out);
	}
	return { ok: true, payload: { team: b.team, windows } };
}

/** Store one validated report. Upsert-per-row with replace semantics: a
 *  re-POST of an already-sent window is idempotent (the spoke aggregates a
 *  window once; resend = replace, never double-count). */
export function storeSelfReport(
	db: Database,
	spoke: string,
	payload: SelfReportPayload,
): { windows: number; rows: number } {
	const now = Date.now();
	let rows = 0;
	for (const w of payload.windows) {
		for (const [cls, m] of Object.entries(w.classes)) {
			db.query(
				"INSERT INTO federation_usage_rollup (spoke, team, bucket, model_class, in_tok, out_tok, cache_r, cache_c, requests, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(spoke, bucket, model_class) DO UPDATE SET team = excluded.team, in_tok = excluded.in_tok, out_tok = excluded.out_tok, cache_r = excluded.cache_r, cache_c = excluded.cache_c, requests = excluded.requests, received_at = excluded.received_at",
			).run(
				spoke,
				payload.team,
				w.bucket,
				cls,
				m.in_tok,
				m.out_tok,
				m.cache_r,
				m.cache_c,
				m.requests,
				now,
			);
			rows++;
		}
		for (const a of w.aids) {
			db.query(
				"INSERT INTO federation_aid_rollup (spoke, team, bucket, aid, domain, injected, skipped, tok_injected, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(spoke, bucket, aid, domain) DO UPDATE SET team = excluded.team, injected = excluded.injected, skipped = excluded.skipped, tok_injected = excluded.tok_injected, received_at = excluded.received_at",
			).run(
				spoke,
				payload.team,
				w.bucket,
				a.aid,
				a.domain,
				a.injected,
				a.skipped,
				a.tok_injected,
				now,
			);
			rows++;
		}
	}
	return { windows: payload.windows.length, rows };
}

/** Hub-admin read over the stored rollups (clamp days 1..90 by the caller). */
export function readSelfReport(
	db: Database,
	days: number,
	nowMs = Date.now(),
): FedUsageReport {
	const to = Math.floor(nowMs / 3_600_000) * 3_600_000;
	const from = to - days * 86_400_000;
	const win = "bucket >= ? AND bucket <= ?";
	const ur = db
		.query(
			`SELECT bucket, team, spoke, model_class, in_tok, out_tok, cache_r, cache_c, requests
			FROM federation_usage_rollup WHERE ${win} ORDER BY bucket, spoke`,
		)
		.all(from, to) as Array<Record<string, unknown>>;
	type WindowRow = {
		bucket: number;
		team: string;
		spoke: string;
		classes: Record<string, UsageClassRow>;
	};
	const windows: WindowRow[] = [];
	const byKey = new Map<string, WindowRow>();
	for (const r of ur) {
		const key = `${String(r.bucket)}|${String(r.team)}|${String(r.spoke)}`;
		let w = byKey.get(key);
		if (w === undefined) {
			w = {
				bucket: Number(r.bucket),
				team: String(r.team),
				spoke: String(r.spoke),
				classes: {},
			};
			byKey.set(key, w);
			windows.push(w);
		}
		w.classes[String(r.model_class)] = {
			in_tok: Number(r.in_tok),
			out_tok: Number(r.out_tok),
			cache_r: Number(r.cache_r),
			cache_c: Number(r.cache_c),
			requests: Number(r.requests),
		};
	}
	const aids = (
		db
			.query(
				`SELECT bucket, team, spoke, aid, domain, injected, skipped, tok_injected
				FROM federation_aid_rollup WHERE ${win} ORDER BY bucket, spoke`,
			)
			.all(from, to) as Array<Record<string, unknown>>
	).map((r) => ({
		bucket: Number(r.bucket),
		team: String(r.team),
		spoke: String(r.spoke),
		aid: String(r.aid),
		domain: String(r.domain),
		injected: Number(r.injected),
		skipped: Number(r.skipped),
		tok_injected: Number(r.tok_injected),
	}));
	let spokes = 0;
	for (const _row of db
		.query(
			"SELECT DISTINCT spoke FROM federation_usage_rollup WHERE bucket >= ? AND bucket <= ? UNION SELECT DISTINCT spoke FROM federation_aid_rollup WHERE bucket >= ? AND bucket <= ?",
		)
		.all(from, to, from, to))
		spokes++;
	return { days, spokes, windows, aids };
}

// ─── the seam factories ────────────────────────────────────────────────────

/** Reference ManifestCrFactory: manifest content (rules from the LIVE
 *  policy — config-driven) + CR origination/queue/lifecycle over the hub's
 *  federation db, with the policy-revision probe registered (policy@,
 *  routing-policy@). */
export const referenceManifestCr: ManifestCrFactory = (
	db,
	policy,
	policyPath,
) => {
	db.exec(CR_QUEUE_DDL);
	const probes = new Map<string, CrProbe>();
	const rev = policyRevisionProbe(policyPath);
	probes.set("policy@", rev);
	probes.set("routing-policy@", rev);
	const runProbe = (cr: CrRow): { ok: boolean; why: string | null } => {
		let best: string | null = null;
		for (const prefix of probes.keys()) {
			if (!cr.target.startsWith(prefix)) continue;
			if (best === null || prefix.length > best.length) best = prefix;
		}
		if (best === null)
			return {
				ok: false,
				why: `no verification probe registered for target '${cr.target}'`,
			};
		const probe = probes.get(best);
		if (probe === undefined)
			return { ok: false, why: `probe gap for '${cr.target}'` };
		return probe(cr);
	};
	return {
		manifest(): FedManifest {
			const rules = buildRules(policy);
			return {
				version: manifestVersion(rules),
				rules,
				cr_queue: crQueue(db),
			};
		},
		declare(o): CrVerdict {
			const out = declareCR(db, {
				id: o.id,
				action: o.action,
				target: o.target,
				payload: o.payload,
				origin: o.origin as CrOrigin,
			});
			if (!out.ok)
				return {
					ok: false,
					status: out.code === "buckle.cr_private_domain" ? 422 : 400,
					code: out.code,
					why: out.why,
				};
			return { ok: true, row: out.row };
		},
		list(): CrRow[] {
			return crQueue(db);
		},
		transition(o): CrVerdict {
			return transitionCR(db, o.id, o.to, o.note, runProbe, o.actor);
		},
		registerProbe(prefix, probe): void {
			probes.set(prefix, probe);
		},
	};
};

/** Reference UsageIngestFactory: strict-allowlist validate (400) →
 *  per-team opt-in from the LIVE policy (403) → structural private-domain
 *  guard (422) → idempotent rollup upsert; read over the same rollups. */
export const referenceUsageIngest: UsageIngestFactory = (db, policy) => {
	db.exec(USAGE_ROLLUP_DDL);
	db.exec(AID_ROLLUP_DDL);
	return {
		ingest(o):
			| {
					ok: true;
					windows: number;
					rows: number;
			  }
			| {
					ok: false;
					status: number;
					code: string;
					why: string;
			  } {
			// the structural domain guard runs on the RAW body BEFORE
			// validation — a private marker riding an unknown key is still a
			// domain violation
			const priv = crPrivateDomainPath(o.body);
			if (priv !== null)
				return {
					ok: false,
					status: 422,
					code: "buckle.self_report_private_domain",
					why: `content at ${priv} is marked data_domain=private — private-domain aggregates never leave the spoke`,
				};
			const v = validateSelfReport(o.body);
			if (!v.ok)
				return { ok: false, status: 400, code: "buckle.bad_body", why: v.why };
			const enabled = selfReportTeams(policy);
			if (!enabled.includes(v.payload.team))
				return {
					ok: false,
					status: 403,
					code: "buckle.self_report_disabled",
					why: `self-report is not enabled for team '${v.payload.team}' (per-team opt-in, default OFF)`,
				};
			const out = storeSelfReport(db, o.spoke, v.payload);
			return { ok: true, windows: out.windows, rows: out.rows };
		},
		read(days: number, nowMs?: number): FedUsageReport {
			return readSelfReport(db, days, nowMs);
		},
	};
};

/** The reference gov seam in the shape overlayModuleGovSeam validates —
 *  the explicit-wiring alternative to the enterprise overlay (tests/sim;
 *  production hubs wire the overlay). */
export function createReferenceGovSeam(): GovSeamFactories {
	return {
		manifestCr: referenceManifestCr,
		usageIngest: referenceUsageIngest,
	};
}
