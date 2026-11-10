import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { emitStoredEvent } from "../../coord/event-publish.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { rePinFallback } from "../hub/model-health.ts";
import {
	type ProcessProbeFn,
	psProcessProbe,
	sameProcess,
} from "../same-process.ts";
import type { FleetLoopSettings } from "../stack-config.ts";
import {
	PROTECTED_REVIEW_CLASS,
	protectedFamily,
	protectedFamilyRefusal,
} from "./protected-family.ts";
import { liveReviewLeg, liveReviewRefusal } from "./review-live-dedup.ts";
import { parkReviewRequest, reviewTransportPark } from "./review-park.ts";
import type { ReviewContext } from "./review-receipt.ts";
import { reviewRoundCapRefusal } from "./review-round-cap.ts";
import { wireModelMatch } from "./wire-model-check.ts";

interface Request {
	state: "RUNNING" | "DONE" | "ERROR" | "PARKED";
	attempts: number;
	leaseUntil: number;
	token: string;
	nextAt: number;
	error?: string;
	/** W1280: detached reviewer pid — lets reconcileReviewLegs tell an active
	 * leg from a stale one instead of waiting out the 25-minute lease. */
	pid?: number;
	/** W2180: process birth recorded at stampReviewPid — pid identity pairs
	 * with the start time (same-process check); legacy pid-only rows keep the
	 * conservative W1280 fallback (ESRCH alone kills). */
	process_start_ms?: number;
	/** W1243: transport failures (leg down, 429/503 waves) defer without
	 * consuming the 3-verdict-attempt budget — attempts is refunded on a
	 * failed finish and deferred counts the backoffs instead. */
	deferred?: number;
	/** W2194: when the health sweep had the pinned group DOWN, the model the
	 * request was re-pinned FROM — the receipt banks the swap, never a
	 * silent alias (the wire audit still grades the new pin as itself). */
	repinned_from?: string;
	/** W2754: admission timestamp for the per-minute start budget rung —
	 *  absent on legacy rows (not counted by the budget query). */
	admitted_at?: number;
	/** W2754: deterministic-proof park stamp (Date.now() at the finish that
	 *  carried the reviewProofParkMarker reason); admission refuses while
	 *  now - stamp < SUSPENDERS_REVIEW_PROOF_PARK_MS. */
	proof_park_at?: number;
	/** W2792.1: wire-model fallback park stamp (Date.now() at the finish that
	 *  carried the reviewWireParkMarker reason); admission refuses while
	 *  now - stamp < SUSPENDERS_REVIEW_WIRE_PARK_MS. */
	wire_park_at?: number;
	/** W2955: the (project, item) the request belongs to — the branch-level
	 *  dedup probe matches on these; legacy rows lack them and stay invisible
	 *  to the probe (degrades to pre-W2955 admission). */
	project?: string;
	item?: string;
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
// W2356 (2026-10-31): the pause could not tell a brief upstream flap from
// sustained saturation — a ~2-min flash 503 burst rode the doubling to the
// 10m ceiling, and each expiry re-admitted the whole deferred herd onto a
// still-flapping ladder, so every leg failed and re-armed the ceiling again:
// ~35 min of zero review admissions while the upstream was healthy again.
// Two corrections: the ceiling drops to 2m, and a lapsed pause admits ONE
// canary leg whose finish decides reopen (served → memory drained, instant
// full reopen) versus re-arm — the herd never refires on an unproven ladder.
interface Pressure {
	fails: number;
	openUntil: number;
	updated: number;
	/** W2356: the expiry canary — the one leg admitted when a pause lapsed,
	 * holding peers off until it finishes (or this window lapses). Any
	 * applyPressure clears it: the canary's finish IS the resolution. */
	probe?: { key: string; until: number };
}
/** Global fact key — shared across scheduler, runners and the reconcile sweep. */
export const providerPressureKey = "review.provider.pressure";
/** 30s doubling to a 2m ceiling (W2356: was 10m — see the ledger header). */
const pressureMs = (fails: number): number =>
	Math.min(120_000, 30_000 * 2 ** Math.max(0, fails - 1));
/** W2356: how long an admitted canary holds the probe window — spans a
 * normal verdict leg (~100-400s observed) while bounding a hung one; the
 * crash/launch-failure finish paths resolve it far sooner. */
const canaryProbeMs = 300_000;
/** Deterministic reopen spread (0-90s) — the deferred backlog must not
 * re-fire as one herd the instant the pause expires. */
export const jitterMs = (key: string): number =>
	Number(
		BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0, 8)}`) %
			90_000n,
	);
/** Read the provider pressure ledger. Absent/corrupt = healthy. */

// ---- W2754 completion-throughput rungs --------------------------------------
/** W2754: a coverage-proof failure on a PASS-content verdict (scratch tree
 *  changed mid-run, unfingerprintable tree, module resolution) is DETERMINISTIC
 *  — the identical leg fails identically until the proof environment changes,
 *  so W1243's refund-then-readmit re-drives full model legs for nothing (the
 *  2026-11-06 W2731 specimen: same commit+base re-driven twice in 10 minutes).
 *  The finish stamps proof_park_at; admission refuses while the stamp is
 *  fresh. The gate stays fail-closed: the receipt banks ERROR, a PASS never
 *  banks without its proof. */
export const reviewProofParkMarker = "coverage-proof deterministic failure";

/** W2754: a PASS-content verdict with an error/unknown proof outcome is the
 *  deterministic-proof class — a FAIL needs no proof; proved/skipped proofs
 *  never block. */
export const deterministicProofFailure = (
	verdict: string | undefined,
	proofStatus: string | undefined,
): boolean =>
	verdict === "PASS" && (proofStatus === "error" || proofStatus === "unknown");

/** W2754 knob (conf row wins, env fills, default 6h; 0 disables): how long a
 *  deterministic-proof park refuses re-admission.
 *  SUSPENDERS_REVIEW_PROOF_PARK_MS. */
const ProofParkKnobSchema = z.union([
	z.literal("0"),
	z.string().regex(/^\d+$/),
]);
export function reviewProofParkMs(
	env: NodeJS.ProcessEnv,
	confVal?: number,
): number {
	if (typeof confVal === "number") return confVal;
	const parsed = ProofParkKnobSchema.safeParse(
		env.SUSPENDERS_REVIEW_PROOF_PARK_MS?.trim(),
	);
	return parsed.success ? Number(parsed.data) : 21_600_000;
}

/** W2792.1: a PASS-content verdict served by a cross-family wire model (the
 *  2026-11-06 W2779.4 loop — opus requested, glm served via the routing
 *  gateway's fallback map) is DETERMINISTIC while the serving ladder is
 *  unchanged: every re-drive walks the same ladder and distrusts the same
 *  receipt, refund-then-readmit style, until transport park. The finish
 *  stamps wire_park_at; admission refuses while the stamp is fresh. The gate
 *  stays fail-closed (the receipt banks ERROR, never a clean PASS) — the
 *  park only bounds the re-drive churn. */
export const reviewWireParkMarker = "wire-model fallback";

/** W2792.1 knob (conf row wins, env fills, default 1h; 0 disables):
 *  SUSPENDERS_REVIEW_WIRE_PARK_MS. */
const WireParkKnobSchema = z.union([z.literal("0"), z.string().regex(/^\d+$/)]);
export function reviewWireParkMs(
	env: NodeJS.ProcessEnv,
	confVal?: number,
): number {
	if (typeof confVal === "number") return confVal;
	const parsed = WireParkKnobSchema.safeParse(
		env.SUSPENDERS_REVIEW_WIRE_PARK_MS?.trim(),
	);
	return parsed.success ? Number(parsed.data) : 3_600_000;
}

/** Newest bound receipt ts for this commit whose base differs from `base`,
 *  null when the exact base was already reviewed (not a base move) or the
 *  history is unreadable (fail-open — W1243: unreadable history never
 *  starves the merge ladder). */
export function newestOutOfBaseReceipt(
	db: GovernorStore,
	project: string,
	item: string,
	commit: string,
	base: string,
): number | null {
	try {
		const events = db
			.query(
				"SELECT ts, payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.work') = ? AND json_extract(payload, '$.project') = ? ORDER BY id DESC LIMIT 50",
			)
			.all(item, project) as { ts: number; payload: string }[];
		let newest: number | null = null;
		for (const event of events) {
			let receipt: { commit?: unknown; base?: unknown };
			try {
				receipt = JSON.parse(JSON.parse(event.payload).receipt);
			} catch {
				continue;
			}
			if (receipt.commit !== commit) continue;
			if (receipt.base === base) return null;
			if (newest === null) newest = Number(event.ts);
		}
		return newest;
	} catch {
		return null;
	}
}

/** W2754 knob (conf row wins, env fills, default 10m; 0 disables): a base-move
 *  re-review waits this long past the newest out-of-base receipt before its
 *  first knock — landing waves coalesce into one re-review per window instead
 *  of one per ladder pass. SUSPENDERS_REVIEW_BASE_SETTLE_MS. */
const SettleKnobSchema = z.union([z.literal("0"), z.string().regex(/^\d+$/)]);
export function reviewBaseSettleMs(
	env: NodeJS.ProcessEnv,
	confVal?: number,
): number {
	if (typeof confVal === "number") return confVal;
	const parsed = SettleKnobSchema.safeParse(
		env.SUSPENDERS_REVIEW_BASE_SETTLE_MS?.trim(),
	);
	return parsed.success ? Number(parsed.data) : 600_000;
}

/** W2754 knob (conf row wins, env fills, default 30; 0 = unbounded — the
 *  W1243 posture on demand): per-minute review START budget on the shared
 *  provider account. SUSPENDERS_REVIEW_RATE_BUDGET. */
const RateBudgetKnobSchema = z.union([
	z.literal("0"),
	z.string().regex(/^\d+$/),
]);
export function reviewRateBudget(
	env: NodeJS.ProcessEnv,
	confVal?: number,
): number {
	if (typeof confVal === "number") return confVal;
	const parsed = RateBudgetKnobSchema.safeParse(
		env.SUSPENDERS_REVIEW_RATE_BUDGET?.trim(),
	);
	return parsed.success ? Number(parsed.data) : 30;
}

/** One NEED_DECISION per deterministic-proof park stamp — the completion
 *  author learns the proof environment is the blocker and that the leg
 *  re-drives itself once the park window lapses. */
function emitProofParkDecision(
	db: GovernorStore,
	project: string,
	item: string,
	author: string,
	stamp: number,
): void {
	const prior = db
		.query(
			"SELECT id FROM events WHERE kind = 'NEED_DECISION' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.work') = ? AND json_extract(payload, '$.review_proof_park') = ? LIMIT 1",
		)
		.get(project, item, String(stamp));
	if (prior) return;
	emitStoredEvent(db, project, {
		kind: "NEED_DECISION",
		source: "review-scheduler",
		scope: item,
		to: author,
		note:
			item +
			": coverage-proof failed deterministically (content PASS banked, proof unknown — gate stays fail-closed). No model re-drive while the park window is fresh (W2754, the W2731 ruling); the leg re-drives once SUSPENDERS_REVIEW_PROOF_PARK_MS (default 6h) lapses or the proof environment is repaired.",
		extra: { work: item, review_proof_park: String(stamp) },
	});
}

/** W2792.1: one NEED_DECISION per wire-park stamp — the completion author
 *  learns the routing fallback is the blocker and the receipt is graded
 *  DEGRADED (PASS content, untrusted wire): no re-drive while the window is
 *  fresh; remedies are a same-class re-review after the window, a wire-stable
 *  review pin, or removing the cross-family fallback for review legs. */
function emitWireParkDecision(
	db: GovernorStore,
	project: string,
	item: string,
	author: string,
	stamp: number,
): void {
	const prior = db
		.query(
			"SELECT id FROM events WHERE kind = 'NEED_DECISION' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.work') = ? AND json_extract(payload, '$.review_wire_park') = ? LIMIT 1",
		)
		.get(project, item, String(stamp));
	if (prior) return;
	emitStoredEvent(db, project, {
		kind: "NEED_DECISION",
		source: "review-scheduler",
		scope: item,
		to: author,
		note:
			item +
			": review served by a cross-family wire model (content PASS banked, receipt graded DEGRADED — not merge-authorizing). No model re-drive while the park window is fresh (W2792.1); the ladder would re-serve the same mismatch. Remedy: wait out SUSPENDERS_REVIEW_WIRE_PARK_MS (default 1h) and let a same-class leg confirm, pin the review to a wire-stable model, or drop the cross-family fallback for review legs in routing-policy.json.",
		extra: { work: item, review_wire_park: String(stamp) },
	});
}

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
			...(p.probe &&
			typeof p.probe.key === "string" &&
			Number.isFinite(p.probe.until)
				? { probe: { key: p.probe.key, until: Number(p.probe.until) } }
				: {}),
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
	// W2356: any finish resolves the canary — a failed one re-arms the pause
	// above, a served verdict is the reopen proof. Either way no probe may
	// outlive the decision it exists to produce.
	next.probe = undefined;
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
		// W2754: a deterministic-proof failure is a LOCAL blocker, not provider
		// pressure — stamp proof_park_at (marker-prefixed reason) so admission
		// refuses re-drive while fresh, and leave the AIMD ledger alone.
		const proofPark = Boolean(
			failed && request.error?.startsWith(reviewProofParkMarker),
		);
		if (proofPark) request.proof_park_at = Date.now();
		// W2792.1: the wire-model fallback class parks the same way — the
		// serving ladder is unchanged, so an identical re-drive re-serves the
		// mismatch deterministically (never provider pressure, never AIMD).
		const wirePark = Boolean(
			failed && request.error?.startsWith(reviewWireParkMarker),
		);
		if (wirePark) request.wire_park_at = Date.now();
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
		// W2754: deterministic-proof parks never open the global AIMD pause —
		// one lane's local proof blocker is not the provider account failing.
		// W2792.1: the wire-model fallback park is the same class — the
		// provider served a verdict; the mismatch is routing policy, not a
		// provider outage.
		if (!proofPark && !wirePark) applyPressure(db, failed);
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
		request.process_start_ms = Date.now();
		db.query(
			"UPDATE facts SET value = ?, version = version + 1, ts = ? WHERE key = ?",
		).run(JSON.stringify(request), Date.now(), key);
	})();
}

// W1280 probed pid-alone (kill(pid,0)); W2180 replaces that with the shared
// same-process identity (pid + start, <2s tolerance): ESRCH or a recycled pid
// is stale, same or unknown stays active — an unprobeable leg is never death
// evidence, and the lease expiry remains the only other backstop.
export interface ReconcileSummary {
	examined: number;
	active: number;
	stale: number;
	recovered: number;
}
/** W1280: sweep RUNNING review requests and recover stale legs — a reviewer
 * whose pid is gone died without finishing (hard kill, lost machine), so
 * finish its request NOW (attempt refund + capped backoff) instead of
 * stranding it for the full 25-minute lease. W2180: a live pid whose start
 * sits outside the 2s tolerance of its stamp is a RECYCLED pid — death
 * evidence. Live legs whose start cannot be observed (or legacy pid-only
 * rows) stay untouched: unknown is never death, the lease remains the only
 * other backstop. */
export function reconcileReviewLegs(
	db: GovernorStore,
	probe: ProcessProbeFn = psProcessProbe,
): ReconcileSummary {
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
		const verdict = sameProcess(
			{ pid: request.pid, processStartMs: request.process_start_ms },
			probe,
		);
		if (verdict === "dead" || verdict === "recycled") {
			summary.stale += 1;
			recoverStaleLeg(db, row, request, summary, verdict);
		} else {
			summary.active += 1;
		}
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
	verdict: "dead" | "recycled",
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
		verdict === "recycled"
			? `reviewer pid ${request.pid} recycled by a different process (start mismatch, W2180); attempt refunded`
			: `reviewer pid ${request.pid} no longer alive (W1280 reconcile); attempt refunded`,
	);
}

/** W2351: the review spawn env — the machine conf's reviewer rows (the
 *  fleet_loop block, delivered through the injected live-settings getter)
 *  fill the keys the environment leaves unset. Env stays the override;
 *  conf is the durable source. An explicitly EMPTY env row counts as set
 *  (the operator's kill switch); no settings = env-only, byte-identical to
 *  the pre-W2351 spawn. Returns a shallow copy — `base` never mutates. */
export function reviewSpawnEnv(
	base: NodeJS.ProcessEnv,
	settings?: FleetLoopSettings,
): NodeJS.ProcessEnv {
	const filled = { ...base };
	if (
		filled.SUSPENDERS_REVIEW_FALLBACK_MODELS === undefined &&
		settings?.reviewFallbackModels !== undefined
	)
		filled.SUSPENDERS_REVIEW_FALLBACK_MODELS = settings.reviewFallbackModels;
	if (
		filled.SUSPENDERS_REVIEW_STEPDOWN_CLASSES === undefined &&
		settings?.reviewStepdownClasses !== undefined
	)
		filled.SUSPENDERS_REVIEW_STEPDOWN_CLASSES = settings.reviewStepdownClasses;
	// W2405: the leg caps ride the same layering — env wins, conf fills,
	// unset conf = the code defaults (review-lane.ts / review-prompt.ts).
	if (
		filled.SUSPENDERS_REVIEW_LEG_TIMEOUT_MS === undefined &&
		settings?.reviewLegTimeoutMs !== undefined
	)
		filled.SUSPENDERS_REVIEW_LEG_TIMEOUT_MS = String(
			settings.reviewLegTimeoutMs,
		);
	if (
		filled.SUSPENDERS_REVIEW_LEG_MAX_TOKENS === undefined &&
		settings?.reviewLegMaxTokens !== undefined
	)
		filled.SUSPENDERS_REVIEW_LEG_MAX_TOKENS = String(
			settings.reviewLegMaxTokens,
		);
	return filled;
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
	/** W2351: the live fleet_loop settings getter (the loop passes its
	 *  hot-applied watcher view) — the conf's reviewer rows fill the spawn
	 *  env where the environment is unset. Absent = env-only. */
	settings?: () => FleetLoopSettings;
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
		confCap: o.settings?.().reviewRoundCap,
	});
	if (capped) return capped;
	const pin = author
		? (o.db
				.query("SELECT value FROM facts WHERE key = ?")
				.get(`lane.${author.completed_by}.model`) as { value: string } | null)
		: null;
	// W2194: the pin-layer fallback — a pinned model that is DOWN (per the
	// fresh model.health facts) re-pins to the freshest healthy group,
	// loudly; the request records repinned_from (never a silent alias — the
	// W1302.6 wire audit grades the new pin as itself).
	let model = env.SUSPENDERS_REVIEW_MODEL || pin?.value;
	let repinnedFrom: string | null = null;
	// W2571: a protected-family item is pinned full-5.3-only BEFORE any
	// health/fallback layer runs — the model-health repin is skipped
	// entirely (stale health facts re-pinned glm-5.3 to flash, root
	// #102182) and a non-full-class pin refuses loudly instead of launching.
	const protectedItem = protectedFamily(o.db, o.project, o.item);
	if (protectedItem) {
		if (!model || wireModelMatch(model, PROTECTED_REVIEW_CLASS) !== "match")
			return protectedFamilyRefusal(model);
	} else if (model && env.SUSPENDERS_MODEL_HEALTH !== "0") {
		const rePin = rePinFallback(o.db, model, env);
		if (rePin.note) console.log(rePin.note);
		if (rePin.model) {
			repinnedFrom = model;
			model = rePin.model;
		}
	}
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
		// W2548: a PARKED request never re-admits on its own — the park IS
		// the bound on W1243's unbounded transport retry. Only the explicit
		// release verb (coord review-unpark) flips it back to ERROR.
		if (old?.state === "PARKED")
			return `review transport parked after ${old.deferred ?? 0} consecutive deferrals — release explicitly (coord review-unpark ${o.item}) or raise/disable SUSPENDERS_REVIEW_TRANSPORT_PARK`;
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
		// W2754: a deterministic-proof park refuses re-admission while its
		// stamp is fresh — the identical leg would fail identically, so the
		// refund path must not re-drive a full model leg (the W2731 ruling:
		// no further model retries for a deterministic proof failure). Checked
		// before the transport machinery: a local proof failure is not provider
		// pressure, and one leg per park window bounds the spend instead of
		// reaching transport-park only after six wasted legs.
		const proofParkMs = reviewProofParkMs(
			env,
			o.settings?.().reviewProofParkMs,
		);
		if (
			proofParkMs > 0 &&
			old &&
			old.state === "ERROR" &&
			typeof old.proof_park_at === "number" &&
			now - old.proof_park_at < proofParkMs
		) {
			emitProofParkDecision(
				o.db,
				o.project,
				o.item,
				author.completed_by,
				old.proof_park_at,
			);
			return `review parked: deterministic proof failure (stamped ${new Date(
				old.proof_park_at,
			).toISOString()}) — no model re-drive until ${new Date(
				old.proof_park_at + proofParkMs,
			).toISOString()} (SUSPENDERS_REVIEW_PROOF_PARK_MS)`;
		}
		// W2792.1: the wire-model fallback park — a cross-family-served PASS
		// re-drives identically while the routing ladder is unchanged, so the
		// refund path must not re-drive a full model leg for nothing (the
		// W2779.4 specimen: opus requested, glm served, twice, ERROR both).
		const wireParkMs = reviewWireParkMs(env, o.settings?.().reviewWireParkMs);
		if (
			wireParkMs > 0 &&
			old &&
			old.state === "ERROR" &&
			typeof old.wire_park_at === "number" &&
			now - old.wire_park_at < wireParkMs
		) {
			emitWireParkDecision(
				o.db,
				o.project,
				o.item,
				author.completed_by,
				old.wire_park_at,
			);
			return `review parked: wire-model fallback (stamped ${new Date(
				old.wire_park_at,
			).toISOString()}) — no model re-drive until ${new Date(
				old.wire_park_at + wireParkMs,
			).toISOString()} (SUSPENDERS_REVIEW_WIRE_PARK_MS)`;
		}
		// W2548: the transport-park bound on W1243's unbounded retry — an
		// ERROR request whose consecutive deferrals reached the threshold
		// parks instead of knocking again (every knock walks the full
		// fallback ladder against implementation lanes). Checked before the
		// pressure gate so the park lands on the first knock past the
		// threshold even mid-pause. 0 disables (unbounded W1243 behavior).
		const parkAt = reviewTransportPark(env);
		if (
			parkAt > 0 &&
			old &&
			old.state === "ERROR" &&
			(old.deferred ?? 0) >= parkAt &&
			parkReviewRequest({
				db: o.db,
				key,
				request: old,
				project: o.project,
				item: o.item,
				author: author.completed_by,
			})
		)
			return `review transport parked after ${old.deferred} consecutive deferrals — release explicitly (coord review-unpark ${o.item}) or raise/disable SUSPENDERS_REVIEW_TRANSPORT_PARK`;
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
		// W2356: a LAPSED pause is not yet a reopen — the 2026-10-31 over-freeze
		// re-admitted the whole jittered herd the instant it expired, every leg
		// failed on the still-flapping ladder, and the failure memory re-armed
		// the ceiling: freezes stacked while the upstream was healthy again.
		// Instead ONE canary leg holds the probe window: its finish is proof
		// either way (served verdict → memory drained by applyPressure, instant
		// full reopen; failure → pause re-armed, peers never saw a gap). A hung
		// canary self-releases when canaryProbeMs lapses; the knob disables the
		// probe for the W1280-era full-herd reopen.
		const canaryOff = env.SUSPENDERS_REVIEW_CANARY === "0";
		if (!canaryOff && pressure.fails > 0) {
			const probe = pressure.probe;
			const probeHeld =
				probe && probe.key !== key && probe.until > now ? probe : undefined;
			if (probeHeld) {
				if (old && old.nextAt < probeHeld.until)
					o.db
						.query(
							"UPDATE facts SET value=?, version=version+1, ts=? WHERE key=?",
						)
						.run(JSON.stringify({ ...old, nextAt: probeHeld.until }), now, key);
				return `review transport probe in flight (canary holds admission until ${new Date(probeHeld.until).toISOString()})`;
			}
		}
		if (old && old.nextAt > now)
			return `review transport retry deferred until ${new Date(old.nextAt).toISOString()}`;
		// W2754: a base-move re-review coalesces landing-wave churn — each
		// landing re-keys the request context, so the re-knock waits one
		// settle window past the newest out-of-base receipt instead of
		// re-reviewing per ladder pass (reviews-per-landing → 1/window).
		const settleMs = reviewBaseSettleMs(env, o.settings?.().reviewBaseSettleMs);
		if (settleMs > 0 && (!old || old.state === "ERROR")) {
			const newest = newestOutOfBaseReceipt(
				o.db,
				o.project,
				o.item,
				o.context.commit,
				o.context.base,
			);
			const settleAt = newest === null ? 0 : newest + settleMs;
			if (settleAt > now) {
				const settled: Request = old
					? { ...old, state: "ERROR", nextAt: settleAt }
					: {
							state: "ERROR",
							attempts: 0,
							deferred: 0,
							leaseUntil: 0,
							token,
							nextAt: settleAt,
						};
				o.db
					.query(
						"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
					)
					.run(key, JSON.stringify(settled), now);
				return `review re-review deferred until ${new Date(settleAt).toISOString()} (base-move settle)`;
			}
		}
		// W2955: trigger dedup — one live review per (branch, label-event).
		// A later label event re-keys the request (commit/base/instructions),
		// so a landing wave would spend a fresh model leg while the previous
		// leg still holds its lease. Ride the live receipt instead.
		const live = liveReviewLeg(o.db, o.project, o.item, key, now);
		if (live) return liveReviewRefusal(o.item, live);
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
		// W2754: per-minute START budget on the shared provider account —
		// review legs are the churn source (28 sessions/15m observed
		// 2026-11-04); the rung bounds review-class spend so implementation
		// lanes keep account capacity. 0 = unbounded (the W1243 posture).
		const budget = reviewRateBudget(env, o.settings?.().reviewRateBudget);
		if (budget > 0) {
			const spent = o.db
				.query(
					"SELECT COUNT(*) AS n FROM facts WHERE source = 'review-scheduler' AND json_extract(value, '$.admitted_at') > ?",
				)
				.get(now - 60_000) as { n: number };
			if (spent.n >= budget)
				return `review rate budget spent (${spent.n}/${budget} starts this minute)`;
		}
		const request: Request = {
			state: "RUNNING",
			attempts: (old?.attempts ?? 0) + 1,
			deferred: old?.deferred,
			project: o.project,
			item: o.item,
			leaseUntil: now + 25 * 60_000,
			token,
			nextAt: 0,
			admitted_at: now,
			...(repinnedFrom ? { repinned_from: repinnedFrom } : {}),
		};
		o.db
			.query(
				"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
			)
			.run(key, JSON.stringify(request), now);
		// W2356: an admission that rode a lapsed pause IS the canary — stamp
		// the probe window so peers hold until this leg's finish resolves it.
		if (!canaryOff && pressure.fails > 0)
			o.db
				.query("UPDATE facts SET value=?, version=version+1, ts=? WHERE key=?")
				.run(
					JSON.stringify({
						...pressure,
						probe: { key, until: now + canaryProbeMs },
					}),
					now,
					providerPressureKey,
				);
		return true;
	})();
	if (reserved !== true) return reserved;
	// W2351: the conf's reviewer rows ride the spawn — env rows win where
	// set, the conf fills where unset, so a respawned/envless watch still
	// hands the reviewer its operator ladder.
	const spawnEnv = reviewSpawnEnv(env, o.settings?.());
	// W2571: a protected item launches pin-only — the operator/conf fallback
	// ladder and the context-overflow stepdown never ride the spawn, so no
	// flash rung can be walked downstream.
	if (protectedItem) {
		delete spawnEnv.SUSPENDERS_REVIEW_FALLBACK_MODELS;
		delete spawnEnv.SUSPENDERS_REVIEW_STEPDOWN_CLASSES;
	}
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
		...(spawnEnv.SUSPENDERS_REVIEW_FALLBACK_MODELS
			? ["--fallback-models", spawnEnv.SUSPENDERS_REVIEW_FALLBACK_MODELS]
			: []),
		"--request-key",
		key,
		"--request-token",
		token,
	];
	try {
		if (o.spawn) o.spawn(args, spawnEnv);
		else {
			const child = launchDetachedReview(args, spawnEnv, o.repo);
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
		return `review requested through Buckle (${model})${
			repinnedFrom ? ` — re-pinned from ${repinnedFrom} (group DOWN)` : ""
		}`;
	} catch {
		finishReviewRequest(o.db, key, token, true);
		return "review launch failed; bounded retry retained";
	}
}
