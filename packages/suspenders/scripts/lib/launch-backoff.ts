import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { GovernorStore } from "../../hooks/lib/govdb.ts";
import { releaseWorkClaim } from "../../hooks/lib/work-release.ts";
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

/** Only a small tail is inspected. The complete, unchanged error stays in the lane log. */
export function launchLogTail(path: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const bytes = Buffer.alloc(Math.min(size, 16_384));
		readSync(fd, bytes, 0, bytes.length, size - bytes.length);
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

/** Record a retry decision without duplicating possibly sensitive provider bodies. */
export function scheduleLaunchBackoff(
	store: GovernorStore,
	project: string,
	item: string,
	log: string,
	step: number,
	now = Date.now(),
	evidence = launchLogTail(log),
): LaunchBackoff {
	const previous = readLaunchBackoff(store, project, item);
	const failure = classifyLaunchFailure(evidence, now);
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
	const backoff = scheduleLaunchBackoff(store, project, item, log, step, now);
	resetDeadLaunchBudget(store, project, item, sid);
	return backoff;
}
