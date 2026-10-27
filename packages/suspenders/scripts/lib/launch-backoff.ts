import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { GovernorStore } from "../../hooks/lib/govdb/govdb.ts";
import { releaseWorkClaim } from "../../hooks/lib/work/work-release.ts";
import { launchSchema } from "./launch-fencing.ts";

export type LaunchFailureKind =
	| "rate-limit"
	| "upstream"
	| "transport"
	| "configuration"
	| "unknown";
export type LaunchFailure = {
	kind: LaunchFailureKind;
	code: string;
	retryAfterMs: number | null;
};
export type LaunchBackoff = LaunchFailure & {
	attempt: number;
	firstAt: number;
	lastAt: number;
	eligibleAt: number;
	failures: number;
	log: string;
};

const KEY_PREFIX = "dispatch.launch-backoff.";

/** W1025: active rate-limit walls — backoff rows of kind=rate-limit whose
 *  eligibleAt is still in the future. The pacing signal for the dispatch
 *  refill throttle (the 429 churn burns attempt budgets on pacing events,
 *  not failures). Fail-open by construction: unreadable rows never count. */
export const activeRateLimitWalls = (
	store: { query: (sql: string) => { all: () => Array<{ value: string }> } },
	project: string,
	now = Date.now(),
): number => {
	void project; // keys are already project-scoped by the prefix
	let walls = 0;
	try {
		const rows = store
			.query(`SELECT value FROM facts WHERE key LIKE '${KEY_PREFIX}%'`)
			.all() as Array<{ value: string }>;
		for (const row of rows) {
			try {
				const v = JSON.parse(row.value) as {
					kind?: string;
					eligibleAt?: number;
				};
				if (
					v.kind === "rate-limit" &&
					Number.isFinite(v.eligibleAt) &&
					(v.eligibleAt ?? 0) > now
				)
					walls++;
			} catch {
				// junk row: not a wall
			}
		}
	} catch {
		// dark store: never throttles dispatch
	}
	return walls;
};
const RETRY_STEPS_MS = [5_000, 10_000, 23_000, 43_000, 55_000] as const;
const MAX_RETRY_AFTER_MS = 15 * 60_000;

const key = (project: string, item: string): string =>
	`${KEY_PREFIX}${Bun.hash(project).toString(16)}.${item}`;

/** Attempt-scoped evidence (W1165): the lane log is append-only across
 *  attempts, so its tail mixes transcript frames from older runs. Only bytes
 *  appended after `before` (the size the launcher measured at spawn) can
 *  belong to the current attempt — classification reads that region alone,
 *  never old assistant/tool/code frames, and stays bounded. */
export function launchLogSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function launchLogAppended(path: string, before: number): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(before, size - 16_384);
		const bytes = Buffer.alloc(Math.max(0, size - start));
		readSync(fd, bytes, 0, bytes.length, start);
		return bytes.toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function retryAfterMs(evidence: string, now: number): number | null {
	const raw = /retry[- ]after\s*[:=]\s*([^\s,;]+)/i.exec(evidence)?.[1];
	if (!raw) return null;
	const seconds = Number(raw);
	const millis = Number.isFinite(seconds)
		? seconds * 1_000
		: Date.parse(raw) - now;
	return Number.isFinite(millis)
		? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, millis))
		: null;
}

export function classifyLaunchFailure(
	evidence: string,
	now = Date.now(),
): LaunchFailure {
	const retryAfter = retryAfterMs(evidence, now);
	if (
		/\b429\b|rate[_ -]?limited|too many requests|resource_exhausted/i.test(
			evidence,
		)
	)
		return { kind: "rate-limit", code: "429", retryAfterMs: retryAfter };
	if (
		/unknown option|unrecognized arguments?|unsupported\s*params?|invalid api key|\b401\b|\b403\b|cert(?:ificate)? (?:expired|invalid)|ERR_TLS_CERT/i.test(
			evidence,
		)
	)
		return {
			kind: "configuration",
			code: "invalid-launch-or-auth",
			retryAfterMs: null,
		};
	if (/\b502\b|\b503\b|\b504\b|no_route|upstream unavailable/i.test(evidence))
		return {
			kind: "upstream",
			code: "upstream-unavailable",
			retryAfterMs: retryAfter,
		};
	if (
		/ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network error|socket hang up|TLS handshake/i.test(
			evidence,
		)
	)
		return {
			kind: "transport",
			code: "transport-unavailable",
			retryAfterMs: retryAfter,
		};
	return { kind: "unknown", code: "launch-exited", retryAfterMs: retryAfter };
}

export function readLaunchBackoff(
	store: GovernorStore,
	project: string,
	item: string,
): LaunchBackoff | null {
	const row = store
		.query("SELECT value FROM facts WHERE key=?")
		.get(key(project, item)) as { value: string } | null;
	if (!row) return null;
	try {
		const value = JSON.parse(row.value) as LaunchBackoff;
		return Number.isFinite(value.eligibleAt) ? value : null;
	} catch {
		return null;
	}
}

/** Record a retry decision from the current attempt's own evidence only
 *  (W1165): `appended` is the launcher-captured text THIS attempt produced
 *  after spawn — never the append-only transcript. Without it (no new native
 *  launch, or a launcher that saw no output) the record stays
 *  unknown/launch-exited on the bounded step ladder: old transcript text can
 *  neither schedule a provider wall nor mint an auth/configuration hold. */
export function scheduleLaunchBackoff(
	store: GovernorStore,
	project: string,
	item: string,
	log: string,
	step: number,
	now = Date.now(),
	appended: string | null = null,
): LaunchBackoff {
	const previous = readLaunchBackoff(store, project, item);
	const failure = classifyLaunchFailure(appended ?? "", now);
	const index = Math.min(
		Math.max(step, previous?.failures ?? 0, 0),
		RETRY_STEPS_MS.length - 1,
	);
	const jitter = Number(Bun.hash(`${project}:${item}:${step}`) % 2_000n);
	const delay =
		failure.kind === "configuration"
			? 15 * 60_000
			: Math.max(RETRY_STEPS_MS[index] + jitter, failure.retryAfterMs ?? 0);
	const record: LaunchBackoff = {
		...failure,
		attempt: step,
		firstAt: previous?.firstAt ?? now,
		lastAt: now,
		eligibleAt: now + delay,
		failures: (previous?.failures ?? 0) + 1,
		log,
	};
	store
		.query(
			"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,version=version+1,ts=excluded.ts",
		)
		.run(key(project, item), JSON.stringify(record), "dispatch", now);
	store
		.query(
			"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,'dispatch','lane.launch-backoff',?,?,NULL)",
		)
		.run(now, project, JSON.stringify({ item, ...record }));
	return record;
}

/** No new native launch — re-arm a dead lane's hold without evidence (W1165):
 *  the record stays unknown/launch-exited on the bounded step ladder. */
export const rearmLaunchHold = (
	store: GovernorStore,
	project: string,
	item: string,
	log: string,
	step: number,
): LaunchBackoff =>
	scheduleLaunchBackoff(store, project, item, log, step, Date.now());

/** The launcher observed THIS attempt exit: classify from the bytes the
 *  attempt itself appended after `spawnLogSize` — never the transcript. */
export const launchFailBackoff = (
	store: GovernorStore,
	project: string,
	item: string,
	log: string,
	step: number,
	spawnLogSize: number,
): LaunchBackoff =>
	scheduleLaunchBackoff(
		store,
		project,
		item,
		log,
		step,
		Date.now(),
		launchLogAppended(log, spawnLogSize),
	);

/** A proved-dead launch may start a fresh budget after the claim is READY. */
export function resetDeadLaunchBudget(
	store: GovernorStore,
	project: string,
	item: string,
	sid: string,
): void {
	launchSchema(store);
	store.transaction(() => {
		store
			.query("DELETE FROM lane_launch_budgets WHERE project=? AND item=?")
			.run(project, item);
		store
			.query("DELETE FROM facts WHERE key=?")
			.run(`lane.${sid}.launch-attempt`);
	})();
}

/** Release only the observed dead claimant; leave a transferred claim untouched. */
export function parkExhaustedLaunch(
	store: GovernorStore,
	project: string,
	item: string,
	sid: string,
	log: string,
	step: number,
	now = Date.now(),
): LaunchBackoff | null {
	const row = store
		.query(
			"SELECT state,owner_sid,updated_at FROM work_items WHERE project=? AND id=?",
		)
		.get(project, item) as {
		state: string;
		owner_sid: string | null;
		updated_at: number;
	} | null;
	if (!row) return null;
	if (row.state === "CLAIMED" || row.state === "RUNNING") {
		if (row.owner_sid !== sid) return null;
		if (
			!releaseWorkClaim(
				store,
				{
					project,
					id: item,
					owner: sid,
					state: row.state,
					updatedAt: row.updated_at,
				},
				{ by: sid, reason: "owner-release" },
			)
		)
			return null;
	} else if (row.state !== "READY") return null;
	// No new native launch happened here (W1165): no attempt-scoped evidence
	// exists, so the parked hold stays on the unknown step ladder.
	const backoff = scheduleLaunchBackoff(store, project, item, log, step, now);
	resetDeadLaunchBudget(store, project, item, sid);
	return backoff;
}
