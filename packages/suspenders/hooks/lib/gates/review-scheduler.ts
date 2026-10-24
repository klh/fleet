import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import type { ReviewContext } from "./review-receipt.ts";

interface Request {
	state: "RUNNING" | "DONE" | "ERROR";
	attempts: number;
	leaseUntil: number;
	token: string;
	nextAt: number;
	error?: string;
	/** W1243: transport failures (leg down, 429/503 waves) defer without
	 * consuming the 3-verdict-attempt budget — attempts is refunded on a
	 * failed finish and deferred counts the backoffs instead. */
	deferred?: number;
}
/** W1243: capped transport backoff — 1m doubling to a 15m ceiling. */
const backoffMs = (deferred: number): number =>
	Math.min(900_000, 60_000 * 2 ** deferred);

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
		new URL("../bin/review-lane.ts", import.meta.url).pathname,
		"--item",
		o.item,
		"--project",
		o.project,
		"--executor",
		`buckle:${model}`,
		"--buckle",
		model,
		"--request-key",
		key,
		"--request-token",
		token,
	];
	try {
		if (o.spawn) o.spawn(args, env);
		else {
			const child = launchDetachedReview(args, env, o.repo);
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
