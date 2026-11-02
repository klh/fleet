// activation-readiness.ts — W2546: the truthful post-merge activation
// contract. Publication (syncHarness) and activation (kickstart + readiness)
// are SEPARATE successes: a stamp that records one may not claim the other.
// The W821 stamp advanced right after publish, so a failed kick, a
// generation-pinned unit (kickstart -k reuses the loaded ProgramArguments —
// it cannot rebind an immutable-generation path) or an unready service was
// permanently suppressed by "up-to-date". This module owns the stamp shape,
// the per-label expectation classification and the readiness mapping; the
// runner (post-merge-runner.ts) owns orchestration. Pure + injectable —
// never a live launchctl call from here.
import { z } from "zod";
import type { ActivationReceipt, ServiceVerdict } from "./service-drift.ts";

/** Activation ledger riding the post-merge stamp. Absent (or a v1 stamp
 * read through readPostMergeStamp) = published but NOT verified — repair
 * pending, exactly the state the W821 stamp lied about. The three
 * unresolved buckets keep retry SAFE: kickFailed may re-kick (nothing
 * restarted), unready may only re-INSPECT (the kick already landed —
 * re-kicking would restart a running service to "clear" an unready state,
 * e.g. ordinary provider rate pressure), pinned needs the owner's reviewed
 * upgradeGateway. */
export const PostMergeActivationSchema = z.object({
	/** labels the drift range demanded (the kick set). */
	requested: z.array(z.string()),
	/** labels whose kick succeeded AND readiness verified this main. */
	verified: z.array(z.string()),
	/** kickstart exited nonzero — safe to re-kick on a later run. */
	kickFailed: z.array(z.string()),
	/** kick landed but readiness unproven — re-inspect only, never re-kick. */
	unready: z.array(z.string()),
	/** labels held back: receipt pins an immutable generation, so the
	 * reviewed upgradeGateway path (SERVICE-ACTIVATION.md) owns them — a
	 * kickstart cannot rebind their ProgramArguments. */
	needsReviewedUpgrade: z.array(z.string()),
	/** true when --skip-kick published without requesting activation. */
	skipped: z.boolean().optional(),
	/** human-facing last outcome, one line. */
	note: z.string().optional(),
});
export const PostMergeStampSchema = z.object({
	main: z.string(),
	installedAt: z.string(),
	activation: PostMergeActivationSchema.optional(),
});
export type PostMergeActivation = z.infer<typeof PostMergeActivationSchema>;
export type PostMergeStamp = z.infer<typeof PostMergeStampSchema>;

/** Lenient read: a v1 `{main, installedAt}` stamp parses as
 * published-not-verified (repair pending); anything unreadable is null. */
export function readPostMergeStamp(
	bytes: string | null,
): PostMergeStamp | null {
	if (bytes === null) return null;
	try {
		const parsed: unknown = JSON.parse(bytes);
		const legacy = z
			.object({ main: z.string().min(1), installedAt: z.string() })
			.safeParse(parsed);
		if (!legacy.success) return null;
		const stamped = PostMergeStampSchema.safeParse(parsed);
		return stamped.success ? stamped.data : legacy.data;
	} catch {
		return null;
	}
}

/** The cycle is settled only when the published main ALSO has its requested
 * activation verified. Used by the runner and the fleet-loop sweep — one
 * predicate, no drift between them. `skippedHoldoffMs` honors a manual
 * --skip-kick for a bounded window before the sweep catches the pending
 * activation up (later requested activation must happen; it is never
 * suppressed). */
export function syncSettled(
	stamp: PostMergeStamp | null,
	head: string | null,
): boolean {
	if (head === null || stamp === null || stamp.main !== head) return false;
	const activation = stamp.activation;
	if (!activation) return false;
	if (activation.skipped) return false;
	if (activation.needsReviewedUpgrade.length > 0) return false;
	return (
		activation.verified.length >= activation.requested.length &&
		activation.kickFailed.length === 0 &&
		activation.unready.length === 0
	);
}

export function skipHoldoffActive(
	stamp: PostMergeStamp | null,
	now: number,
	holdoffMs = 600_000,
): boolean {
	if (!stamp?.activation?.skipped) return false;
	const at = Date.parse(stamp.installedAt);
	return Number.isFinite(at) && now - at < holdoffMs;
}

/** What the activation receipt expects of one launchd label. */
export type LabelExpectation =
	| { kind: "stable" }
	| { kind: "generation-pinned"; revision: string }
	| { kind: "unfenced" };

/** Receipt-backed labels carry the activation contract: a `generation` pin
 * means the running unit executes an immutable generation path — kickstart
 * restarts the OLD payload, so only the reviewed upgradeGateway flow may
 * move it. No receipt row = no contract to verify against (legacy
 * surfaces): kick stays the reviewed W821 behavior, readiness is logged,
 * never asserted. Unknown provenance never authorizes repair. */
export function expectationFor(
	label: string,
	receipt: ActivationReceipt | null,
): LabelExpectation {
	const service = receipt?.services.find((s) => s.label === label);
	if (!service) return { kind: "unfenced" };
	if (service.generation)
		return { kind: "generation-pinned", revision: service.generation.revision };
	return { kind: "stable" };
}

/** Identity-readiness verdict shape: "pending" keeps polling within the
 * runner budget; "ready"/"failed" end the poll for that label. */
export interface ReadinessVerdict {
	state: "ready" | "pending" | "failed";
	reason: string;
}

/** Readiness verdict for one label from the receipt-backed service
 * inspection (inspectServices — listener ownership, never HTTP status and
 * never a bare PID). */
export function readinessOf(
	verdict: ServiceVerdict | undefined,
): ReadinessVerdict {
	if (verdict === undefined)
		return { state: "failed", reason: "no receipt inspection for label" };
	switch (verdict.state) {
		case "running":
		case "scheduled-idle":
			return { state: "ready", reason: verdict.reason };
		case "starting":
			return { state: "pending", reason: verdict.reason };
		case "degraded":
		case "drift":
		case "unloaded":
		case "disabled":
			return { state: "failed", reason: verdict.reason };
		case "unknown":
			// inspection failure: bounded retry, then failed — never guessed.
			return { state: "pending", reason: verdict.reason };
	}
}

/** Outside-process wire probe verdict (deploy/healthcheck/probe.ts one-shot
 * is the implementation; this type keeps the contract injectable). */
export interface ProbeVerdict {
	ok: boolean;
	status: number;
	reason?: string;
}
export type ProbeFn = (url: string) => ProbeVerdict;

/** One-shot external probe budget — small: the service just (re)started. */
export const PROBE_TIMEOUT_MS = 5_000;

/** The per-label outcome outcomeLine renders: expectation + kick + the
 * readiness proofs behind this attempt's verdict. */
export interface ActivationOutcome {
	label: string;
	expectation: LabelExpectation;
	/** a kickstart was issued and exited 0. */
	kicked: boolean;
	/** kick rc for this attempt (null = no kick attempted). */
	kickCode: number | null;
	readiness: ReadinessVerdict;
}

/** One honest line per label for logs and the stamp note. */
export function outcomeLine(outcome: ActivationOutcome): string {
	switch (outcome.expectation.kind) {
		case "generation-pinned":
			return `${outcome.label}: pinned@${outcome.expectation.revision.slice(0, 12)} — needs reviewed upgradeGateway (kickstart cannot rebind ProgramArguments)`;
		case "unfenced":
			return `${outcome.label}: unfenced — kick rc=${outcome.kickCode ?? "?"}, readiness not receipt-backed`;
		case "stable":
			return `${outcome.label}: kick rc=${outcome.kickCode ?? "?"}, readiness ${outcome.readiness.state} (${outcome.readiness.reason})`;
	}
}
