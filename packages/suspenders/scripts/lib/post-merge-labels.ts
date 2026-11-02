// post-merge-labels.ts — W2546: per-label activation for the post-merge
// runner. One label's path to "verified" is BOTH proofs the owner law
// demands (#101043): receipt-backed service identity where a contract
// exists (inspectServices → listener-owned running, or a carried unit's
// loaded-generation match) AND an outside-process wire probe
// (deploy/healthcheck/probe.ts one-shot) — identity alone is never
// application readiness, and neither is a kickstart exit code. A
// generation-pinned label is rebound ONLY through the reviewed upgrade
// flow (post-merge-carry.ts); a plain kick would restart the OLD payload
// (#101007). All process seams live on the deps interface.
import {
	outcomeLine,
	readinessOf,
	type LabelExpectation,
	type ProbeFn,
	type ReadinessVerdict,
} from "./activation-readiness.ts";
import type { ServiceVerdict } from "./service-drift.ts";

export interface PostMergeRunnerDeps {
	/** install.ts --step syncHarness --yes child (already published for
	 * this main when the activation leg runs alone). */
	publish: () => { code: number; out: string };
	/** ~/.config/klh/service-activation.json — null when unreadable. */
	readReceipt: () => import("./service-drift.ts").ActivationReceipt | null;
	/** receipt-backed inspection for one label (undefined = no row). */
	inspectLabel: (label: string) => ServiceVerdict | undefined;
	/** launchctl kickstart -k gui/<uid>/<label>; returns its exit code. */
	kick: (label: string) => number;
	/** deploy/healthcheck/probe.ts one-shot against the label's URL. */
	probe: ProbeFn;
	/** revision of the daemon a carried label loads (null = unreadable). */
	loadedRevisionFor: (label: string) => string | null;
	/** daemon supervision state for the carry label (unknown ≠ absent). */
	daemonStateFor: (label: string) => "loaded" | "absent" | "unknown";
	/** the label's public status URL (receipt port + known path). */
	probeUrlFor: (label: string) => string | null;
	/** generation-pinned carry through the reviewed upgrade flow. */
	carry: (
		expectedRevision: string,
	) => import("./post-merge-carry.ts").CarryResult;
	log: (line: string) => void;
	sleep: (ms: number) => void;
	now: () => number;
	writeStamp: (
		stamp: import("./activation-readiness.ts").PostMergeStamp,
	) => void;
}

export interface LabelOutcome {
	label: string;
	expectation: LabelExpectation;
	verified: boolean;
	line: string;
	/** kick rc for this attempt (null = no kick attempted). */
	kickCode: number | null;
	/** carried via the reviewed flow this attempt. */
	carried: boolean;
}

/** Probe poll inside the budget: a just-kicked listener needs a moment.
 * A definitive HTTP answer (any status) is a real verdict — only
 * connection-level failures during startup keep polling. The deps type is
 * the structural subset (W2546 #101757): the install step's readiness
 * proof reuses this same loop without a full runner. */
export function pollProbe(
	deps: Pick<PostMergeRunnerDeps, "probe" | "now" | "sleep">,
	url: string,
	budgetMs: number,
	intervalMs: number,
): { ok: boolean; status: number } {
	const deadline = deps.now() + budgetMs;
	for (;;) {
		const probe = deps.probe(url);
		if (probe.ok) return probe;
		if (probe.status > 0) return probe;
		if (deps.now() + intervalMs > deadline) return probe;
		deps.sleep(intervalMs);
	}
}

/** Identity poll for a kicked stable label: pending/unknown keep polling
 * inside the budget; ready ends it; hard states fail fast — an unready
 * service is never "deployed". */
export function awaitIdentity(
	deps: Pick<PostMergeRunnerDeps, "inspectLabel" | "now" | "sleep">,
	label: string,
	budgetMs: number,
	intervalMs: number,
): ReturnType<typeof readinessOf> {
	const deadline = deps.now() + budgetMs;
	for (;;) {
		const readiness = readinessOf(deps.inspectLabel(label));
		if (readiness.state !== "pending") return readiness;
		if (deps.now() + intervalMs > deadline)
			return { state: "failed", reason: "readiness budget exhausted" };
		deps.sleep(intervalMs);
	}
}

function stableOutcome(
	deps: PostMergeRunnerDeps,
	label: string,
	expectation: LabelExpectation,
	kickCode: number,
	verified: boolean,
	readiness: ReadinessVerdict,
): LabelOutcome {
	const full = {
		label,
		expectation,
		kicked: kickCode === 0,
		kickCode,
		readiness,
	};
	deps.log(outcomeLine(full));
	return {
		label,
		expectation,
		verified,
		line: outcomeLine(full),
		kickCode,
		carried: false,
	};
}

/** Kick + verify a stable (receipt-backed, non-pinned) label. Readiness is
 * BOTH proofs (#101043): receipt-backed service identity AND the
 * outside-process wire probe. An unfenced label (no receipt row) has no
 * identity contract — the kick rc stands, the probe is still required. */
export function activateStable(
	deps: PostMergeRunnerDeps,
	label: string,
	expectation: LabelExpectation,
	budgetMs: number,
	intervalMs: number,
): LabelOutcome[] {
	const kickCode = deps.kick(label);
	if (kickCode !== 0)
		return [
			stableOutcome(deps, label, expectation, kickCode, false, {
				state: "failed",
				reason: `kickstart exit ${kickCode}`,
			}),
		];
	if (expectation.kind === "stable") {
		const identity = awaitIdentity(deps, label, budgetMs, intervalMs);
		if (identity.state !== "ready")
			return [
				stableOutcome(deps, label, expectation, kickCode, false, identity),
			];
	}
	return probeOutcome(deps, label, expectation, kickCode, budgetMs, intervalMs);
}

/** The probe leg: no URL = readiness unproven (never verified); a URL is
 * polled inside the budget — connection-refused during startup keeps
 * polling, any definitive HTTP status is a real verdict. */
function probeOutcome(
	deps: PostMergeRunnerDeps,
	label: string,
	expectation: LabelExpectation,
	kickCode: number,
	budgetMs: number,
	intervalMs: number,
): LabelOutcome[] {
	const url = deps.probeUrlFor(label);
	if (url === null)
		return [
			stableOutcome(deps, label, expectation, kickCode, false, {
				state: "failed",
				reason: "no probe URL known for label — readiness unproven",
			}),
		];
	const probed = pollProbe(deps, url, budgetMs, intervalMs);
	return [
		stableOutcome(deps, label, expectation, kickCode, probed.ok, {
			state: probed.ok ? "ready" : "failed",
			reason: probed.ok
				? `external probe ok (${url})`
				: `external probe failed (${url}, status ${probed.status})`,
		}),
	];
}
