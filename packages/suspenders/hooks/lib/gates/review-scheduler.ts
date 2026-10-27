import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import type { ReviewContext } from "./review-receipt.ts";
import { reviewRoundCapRefusal } from "./review-round-cap.ts";

interface Request {
	state: "RUNNING" | "DONE" | "ERROR";
	attempts: number;
	leaseUntil: number;
	token: string;
	nextAt: number;
	error?: string;
	/** W1280: detached reviewer pid — lets reconcileReviewLegs tell an active
	 * leg from a stale one instead of waiting out the 25-minute lease. */
	pid?: number;
	/** W1243: transport failures (leg down, 429/503 waves) defer without
	 * consuming the 3-verdict-attempt budget — attempts is refunded on a
	 * failed finish and deferred counts the backoffs instead. */
	deferred?: number;
}
/** W1243: capped transport backoff — 1m doubling to a 15m ceiling. */
const backoffMs = (deferred: number): number =>
	Math.min(900_000, 60_000 * 2 ** deferred);

// ---- W1280: provider pressure ledger ---------------------------------------
// The 2026-10-25 504/429 storm: SUSPENDERS_REVIEW_CONCURRENCY was unset
// (unbounded, owner law) and the merge ladder admitted every pending review
// each cycle, so 17 reviewer legs raced the code lanes for an upstream that
// productively serves ~8-9 concurrent requests. The fix is NOT a slot
// ceiling — it is AIMD backpressure off the provider's own outcome signals:
// every transport failure opens a GLOBAL pause window that defers new
// admissions; every served verdict decays it and reopens admission
// instantly. Healthy provider = unbounded throughput; saturated provider =
// the storm collapses into a bounded, jittered retry cadence while code
// lanes keep their slots.
interface Pressure {
	fails: number;
	openUntil: number;
	updated: number;
}
/** Global fact key — shared across scheduler, runners and the reconcile sweep. */
export const providerPressureKey = "review.provider.pressure";
/** 30s doubling to a 10m ceiling. */
const pressureMs = (fails: number): number =>
	Math.min(600_000, 30_000 * 2 ** Math.max(0, fails - 1));
/** Deterministic reopen spread (0-90s) — the deferred backlog must not
 * re-fire as one herd the instant the pause expires. */
export const jitterMs = (key: string): number =>
	Number(
		BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0, 8)}`) %
			90_000n,
	);
/** Read the provider pressure ledger. Absent/corrupt = healthy. */
export function providerPressureOf(db: GovernorStore): Pressure {
	try {
		const row = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(providerPressureKey) as { value: string } | null;
		if (!row) return { fails: 0, openUntil: 0, updated: 0 };
		const p = JSON.parse(row.value) as Partial<Pressure>;
		return {
			fails: Number(p.fails) || 0,
			openUntil: Number(p.openUntil) || 0,
			updated: Number(p.updated) || 0,
		};
	} catch {
		return { fails: 0, openUntil: 0, updated: 0 };
	}
}
/** AIMD update — caller must already be inside a transaction (bun:sqlite
 * nesting). A failure opens the global pause; a served verdict HALVES the
 * failure memory and shortens the pause to the decayed level but does not
 * cancel an active cooldown (#70140): with 8 legs in flight and a 429 every
 * ~7s, one isolated success must not reopen the admission gate mid-storm.
 * Only failure memory drained to zero (sustained success) fully reopens. */
export function applyPressure(db: GovernorStore, failed: boolean): void {
	const now = Date.now();
	const current = providerPressureOf(db);
	const next: Pressure = failed
		? {
				fails: current.fails + 1,
				openUntil: now + pressureMs(current.fails + 1),
				updated: now,
			}
		: (() => {
				const fails = Math.floor(current.fails / 2);
				return {
					fails,
					openUntil:
						fails > 0
							? Math.min(current.openUntil, now + pressureMs(fails))
							: 0,
					updated: now,
				};
			})();
	db.query(
		"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
	).run(providerPressureKey, JSON.stringify(next), now);
}

export const reviewRequestKey = (
	project: string,
	item: string,
	c: ReviewContext,
): string =>
	`review.request.${createHash("sha256")
		.update(JSON.stringify([project, item, c.commit, c.base, c.instructions]))
		.digest("hex")}`;

export function finishReviewRequest(
	db: GovernorStore,
	key: string,
	token: string,
	failed: boolean,
	reason?: string,
): void {
	db.transaction(() => {
		const row = db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
			value: string;
		} | null;
		if (!row) return;
		const request = JSON.parse(row.value) as Request;
		if (request.token !== token) return;
		// W1243.1: a finished request is never re-finished — the runner's own
		// receipt and the scheduler's launch-exit watchdog must not corrupt
		// each other (a DONE flipped to ERROR, a double attempt refund).
		if (request.state !== "RUNNING") return;
		request.state = failed ? "ERROR" : "DONE";
		request.error = failed
			? (reason ?? "review transport unavailable")
			: undefined;
		// W1243: a transport failure refunds its reservation attempt and
		// defers instead — the 3-attempt budget is verdicts-only, so a 429/503
		// wave or a dead leg can never exhaust it. Backoff grows on the
		// deferral count (uncapped retries would hot-loop a dead leg).
		if (failed) {
			request.attempts = Math.max(0, request.attempts - 1);
			request.deferred = (request.deferred ?? 0) + 1;
		}
		request.leaseUntil = 0;
		request.nextAt =
			Date.now() + backoffMs(request.deferred ?? request.attempts);
		applyPressure(db, failed);
		db.query(
			"UPDATE facts SET value = ?, version = version + 1, ts = ? WHERE key = ?",
		).run(JSON.stringify(request), Date.now(), key);
	})();
}

/** W1243.1 (#62654): machine-local stderr capture for detached reviewers —
 * the 2026-10-23 scheduler launches died at launch with stderr ignored, so
 * the only evidence was a stranded RUNNING lease. SUSPENDERS_REVIEW_LAUNCH_LOG
 * overrides the path (tests, alternate homes). */
export const reviewLaunchLogPath = (): string =>
	process.env.SUSPENDERS_REVIEW_LAUNCH_LOG ??
	join(homedir(), ".claude-insights", "review-lane-stderr.log");

/** W1243.1 (#62654): launch the reviewer DETACHED — `child.unref()` alone
 * still kills the child when the parent CLI exits (controlled Bun marker
 * probe, finding.review-launch-499-20261023); `detached: true` survives,
 * as other Fleet spawns already do. stderr rides an appended fd, not a
 * pipe: a pipe's read end dies with the parent and would EPIPE-kill the
 * detached reviewer, so the fd keeps evidence readable post-parent. */
export function launchDetachedReview(
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
) {
	let stderr: "ignore" | number = "ignore";
	try {
		const log = reviewLaunchLogPath();
		mkdirSync(dirname(log), { recursive: true });
		stderr = openSync(log, "a");
	} catch {
		// diagnostics are best-effort — the launch must not depend on them
	}
	const child = Bun.spawn(args, {
		cwd,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr,
		detached: true,
	});
	if (typeof stderr === "number")
		writeSync(
			stderr,
			`\n[${new Date().toISOString()}] review launch pid=${child.pid}\n`,
		);
	child.unref();
	return child;
}

/** Last ≤200 chars of the captured launch log — the finish-reason evidence
 * for a reviewer that died at launch (#62654). Absent file = empty string. */
const stderrTail = (path: string): string => {
	try {
		return readFileSync(path, "utf8").trimEnd().slice(-200);
	} catch {
		return "";
	}
};

/** W1280: stamp the detached reviewer's pid onto its RUNNING request so
 * reconcileReviewLegs can tell an active leg from a stale one. Token-guarded
 * like finishReviewRequest; a missing/finished request is a no-op. */
export function stampReviewPid(
	db: GovernorStore,
	key: string,
	token: string,
	pid: number,
): void {
	db.transaction(() => {
		const row = db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
			value: string;
		} | null;
		if (!row) return;
		const request = JSON.parse(row.value) as Request;
		if (request.token !== token || request.state !== "RUNNING") return;
		request.pid = pid;
		db.query(
			"UPDATE facts SET value = ?, version = version + 1, ts = ? WHERE key = ?",
		).run(JSON.stringify(request), Date.now(), key);
	})();
}

/** W1280: liveness probe — ESRCH is death, anything else (EPERM, etc.) is
 * conservatively alive so the lease expiry remains the only backstop. */
const pidAlive = (pid: number): boolean | null => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
	}
};
export interface ReconcileSummary {
	examined: number;
	active: number;
	stale: number;
	recovered: number;
}
/** W1280: sweep RUNNING review requests and recover stale legs — a reviewer
 * whose pid is gone died without finishing (hard kill, lost machine), so
 * finish its request NOW (attempt refund + capped backoff) instead of
 * stranding it for the full 25-minute lease. Live legs and legacy requests
 * without a stamped pid are left untouched (never kill live unknown legs). */
export function reconcileReviewLegs(db: GovernorStore): ReconcileSummary {
	const summary = { examined: 0, active: 0, stale: 0, recovered: 0 };
	const rows = db
		.query("SELECT key, value FROM facts WHERE source = 'review-scheduler'")
		.all() as { key: string; value: string }[];
	for (const row of rows) {
		let request: Request;
		try {
			request = JSON.parse(row.value) as Request;
		} catch {
			continue;
		}
		if (request.state !== "RUNNING") continue;
		summary.examined += 1;
		if (typeof request.pid !== "number" || request.pid <= 0) continue;
		if (pidAlive(request.pid) !== false) {
			summary.active += 1;
			continue;
		}
		summary.stale += 1;
		recoverStaleLeg(db, row, request, summary);
	}
	return summary;
}

/** Re-finish one stale leg — re-reads inside the tx window so a leg that
 * finished since the scan is never double-counted as recovered. */
function recoverStaleLeg(
	db: GovernorStore,
	row: { key: string },
	request: Request,
	summary: ReconcileSummary,
): void {
	const fresh = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(row.key) as { value: string } | null;
	if (!fresh) return;
	const current = JSON.parse(fresh.value) as Request;
	if (current.state !== "RUNNING" || current.token !== request.token) return;
	summary.recovered += 1;
	finishReviewRequest(
		db,
		row.key,
		request.token,
		true,
		`reviewer pid ${request.pid} no longer alive (W1280 reconcile); attempt refunded`,
	);
}

/** One durable lease per exact review context; same-commit FAIL is never
 * retried as a lottery. Verdicts spend the 3-attempt budget; transport
 * failures — including crashed-runner leases (#62309) — refund their attempt
 * and retry unboundedly with capped backoff, so a route outage can never
 * exhaust the budget nor starve the merge ladder. */
export function scheduleReview(o: {
	db: GovernorStore;
	project: string;
	item: string;
	repo: string;
	context: ReviewContext;
	env?: NodeJS.ProcessEnv;
	spawn?: (args: string[], env: NodeJS.ProcessEnv) => void;
}): string {
	const env = o.env ?? process.env;
	const author = o.db
		.query(
			"SELECT completed_by FROM work_completion_records WHERE project = ? AND item = ? AND commit_sha = ?",
		)
		.get(o.project, o.item, o.context.commit) as {
		completed_by: string;
	} | null;
	if (!author) return "review unavailable: exact completion author missing";
	const capped = reviewRoundCapRefusal({
		db: o.db,
		project: o.project,
		item: o.item,
		author: author.completed_by,
		env,
	});
	if (capped) return capped;
	const pin = author
		? (o.db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`lane.${author.completed_by}.model`) as { value: string } | null)
		: null;
	const model = env.SUSPENDERS_REVIEW_MODEL || pin?.value;
	if (!model)
		return "review unavailable: configure SUSPENDERS_REVIEW_MODEL or restore original lane model fact";
	const key = reviewRequestKey(o.project, o.item, o.context);
	const token = randomUUID();
	const now = Date.now();
	const reserved = o.db.transaction(() => {
		const row = o.db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(key) as { value: string } | null;
		const old = row ? (JSON.parse(row.value) as Request) : null;
		if (old?.state === "DONE")
			return "review completed; unresolved findings require repair";
		if (old && old.state === "RUNNING") {
			if (old.leaseUntil > now)
				return `review already running; lease expires ${new Date(old.leaseUntil).toISOString()}`;
			// W1243 (#62309): an expired RUNNING lease is a reviewer that died
			// without finishing — a transport failure, not a consumed verdict.
			// Refund its attempt and defer with the same capped backoff, so
			// crashes can never reach the terminal verdict-budget gate.
			const deferred = (old.deferred ?? 0) + 1;
			const crashed: Request = {
				...old,
				state: "ERROR",
				attempts: Math.max(0, old.attempts - 1),
				deferred,
				leaseUntil: 0,
				nextAt: now + backoffMs(deferred),
				error: "reviewer lease expired without a verdict; attempt refunded",
			};
			o.db
				.query("UPDATE facts SET value=?, version=version+1, ts=? WHERE key=?")
				.run(JSON.stringify(crashed), now, key);
			return `review transport retry deferred until ${new Date(crashed.nextAt).toISOString()}`;
		}
		if (old && old.attempts >= 3)
			return "review retry budget exhausted (3 attempts); explicit repair required";
		// W1280: global admission pause off the provider's own outcome signals
		// (AIMD above) — checked BEFORE the per-request backoff, so an active
		// cooldown defers every leg (even one whose own backoff lapsed) and
		// staggers its reopen into a jittered stream instead of a herd.
		const pressure = providerPressureOf(o.db);
		if (pressure.openUntil > now) {
			const staggered = pressure.openUntil + jitterMs(key);
			if (old && old.nextAt < staggered)
				o.db
					.query(
						"UPDATE facts SET value=?, version=version+1, ts=? WHERE key=?",
					)
					.run(JSON.stringify({ ...old, nextAt: staggered }), now, key);
			return `review transport paused until ${new Date(pressure.openUntil).toISOString()} (provider pressure)`;
		}
		if (old && old.nextAt > now)
			return `review transport retry deferred until ${new Date(old.nextAt).toISOString()}`;
		// W1243: no artificial default ceiling — the reviewer is unbounded and
		// the real constraint is upstream capacity, not scheduler slots (the
		// 2-slot default starved the merge ladder during the 2026-10-23 ERROR
		// storm). SUSPENDERS_REVIEW_CONCURRENCY remains an explicit operator
		// cap only; unset means unbounded.
		const limitRaw = env.SUSPENDERS_REVIEW_CONCURRENCY;
		if (limitRaw !== undefined) {
			const limit = Number(limitRaw);
			if (!Number.isInteger(limit) || limit < 1)
				return "invalid SUSPENDERS_REVIEW_CONCURRENCY";
			const count = o.db
				.query(
					"SELECT COUNT(*) AS n FROM facts WHERE source = 'review-scheduler' AND json_extract(value, '$.state') = 'RUNNING' AND json_extract(value, '$.leaseUntil') > ?",
				)
				.get(now) as { n: number };
			if (count.n >= limit)
				return `review capacity occupied (${count.n}/${limit})`;
		}
		const request: Request = {
			state: "RUNNING",
			attempts: (old?.attempts ?? 0) + 1,
			deferred: old?.deferred,
			leaseUntil: now + 25 * 60_000,
			token,
			nextAt: 0,
		};
		o.db
			.query(
				"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
			)
			.run(key, JSON.stringify(request), now);
		return true;
	})();
	if (reserved !== true) return reserved;
	const args = [
		process.execPath,
		new URL("../../bin/review-lane.ts", import.meta.url).pathname,
		"--item",
		o.item,
		"--project",
		o.project,
		"--executor",
		`buckle:${model}`,
		"--buckle",
		model,
		// W1313: the routing ladder's secondary reviewers ride the spawned
		// reviewer — explicit arg beats inherited env for traceability.
		...(env.SUSPENDERS_REVIEW_FALLBACK_MODELS
			? ["--fallback-models", env.SUSPENDERS_REVIEW_FALLBACK_MODELS]
			: []),
		"--request-key",
		key,
		"--request-token",
		token,
	];
	try {
		if (o.spawn) o.spawn(args, env);
		else {
			const child = launchDetachedReview(args, env, o.repo);
			// W1280: the pid lets reconcileReviewLegs recover a stale leg now
			// instead of waiting out the 25-minute lease.
			stampReviewPid(o.db, key, token, child.pid);
			// W1243.1 (#62654): a reviewer that dies at launch must not strand
			// its RUNNING lease for the full 25-minute expiry — finish it here,
			// with the captured stderr tail as the reason, while this parent
			// still lives. If the parent is already gone the expired-lease
			// refund path recovers the lease on the next schedule call.
			void child.exited.then((code) => {
				if (code === 0) return;
				finishReviewRequest(
					o.db,
					key,
					token,
					true,
					`reviewer exited ${code} at launch: ${stderrTail(reviewLaunchLogPath())}`,
				);
			});
		}
		return `review requested through Buckle (${model})`;
	} catch {
		finishReviewRequest(o.db, key, token, true);
		return "review launch failed; bounded retry retained";
	}
}
