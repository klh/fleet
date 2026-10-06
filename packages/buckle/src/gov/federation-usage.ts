// src/gov/federation-usage.ts — W171 federation phase 3: the aggregate
// self-report seam. Spokes POST hourly token aggregates by model-class
// (routing-doctrine classes — never model or actor names, never content)
// plus per-aid rows, opt-in per team via the manifest's
// federation.self_report rule (default OFF = the rule is absent, the hub
// REFUSES ingests for teams policy has not opted in). The structural
// domain guard (crPrivateDomainPath) runs on every ingest — private-domain
// aggregates never land on the hub.
import type { Database } from "bun:sqlite";
import { crPrivateDomainPath } from "./federation-manifest.ts";

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
	classes: Partial<Record<ModelClass, ClassRow>>;
	aids: AidRow[];
}

export interface SelfReportPayload {
	team: string;
	windows: SelfReportWindow[];
}

export interface ClassRow {
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
function classRow(v: unknown): ClassRow | null {
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
	const classes: Partial<Record<ModelClass, ClassRow>> = {};
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

/** The structural private-domain guard, re-exported for the route layer:
 *  any data_domain:"private" marker anywhere in the body rejects BEFORE
 *  storage (domain-separation law, same mechanism as the CR channel). */
export function privateDomainPath(body: unknown): string | null {
	return crPrivateDomainPath(body);
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

/** The hub-side report the dashboards read (GET /federation/usage). */
export interface FedUsageReport {
	days: number;
	spokes: number;
	windows: Array<{
		bucket: number;
		team: string;
		spoke: string;
		classes: Record<string, ClassRow>;
	}>;
	aids: Array<{
		bucket: number;
		team: string;
		spoke: string;
		aid: string;
		domain: string;
		injected: number;
		skipped: number;
		tok_injected: number;
	}>;
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
	const windows: FedUsageReport["windows"] = [];
	const byKey = new Map<string, FedUsageReport["windows"][number]>();
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
