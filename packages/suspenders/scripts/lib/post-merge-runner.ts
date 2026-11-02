// post-merge-runner.ts — W2546: the post-merge sync orchestration, split
// from the CLI face so every process boundary is an injected seam (tests
// never touch live launchd). Contract: publish and activate are separate
// successes — the stamp's activation ledger records publication
// (requested/verified/needsReviewedUpgrade), advances on publish, and never
// claims a service the machinery did not prove. A kick that fails, a
// readiness poll that exhausts, or a label pinned to an immutable
// generation (kickstart cannot rebind ProgramArguments — the reviewed
// upgradeGateway path owns it) leaves the ledger unsettled, so the next
// cycle retries exactly the missing labels — publication is never repeated
// for the same main.
import {
	expectationFor,
	outcomeLine,
	type LabelExpectation,
	type PostMergeActivation,
	type PostMergeStamp,
} from "./activation-readiness.ts";
import {
	activateStable,
	awaitIdentity,
	pollProbe,
	type LabelOutcome,
	type PostMergeRunnerDeps,
} from "./post-merge-labels.ts";

/** A carried label settles only on BOTH proofs the owner law demands:
 * loaded-generation identity (the unit now executes the published main's
 * bundle) AND an outside-process wire probe (identity alone — listener or
 * PID — is not application readiness). Polls both inside the budget: a
 * just-reloaded unit needs a moment before its listener answers. */
function pollCarriedReadiness(
	deps: PostMergeRunnerDeps,
	label: string,
	head: string,
	budgetMs: number,
	intervalMs: number,
): { verified: boolean; outcome: Parameters<typeof outcomeLine>[0] } {
	const deadline = deps.now() + budgetMs;
	for (;;) {
		const attempt = carriedReadiness(deps, label, head);
		// a definitive wire answer (ok or a real HTTP status) ends the poll;
		// connection-refused during startup keeps polling inside the budget
		if (
			attempt.outcome.readiness.state === "ready" ||
			/at http|probe ok/.test(attempt.outcome.readiness.reason)
		)
			return attempt;
		if (deps.now() + intervalMs > deadline) return attempt;
		deps.sleep(intervalMs);
	}
}

function carriedReadiness(
	deps: PostMergeRunnerDeps,
	label: string,
	head: string,
): { verified: boolean; outcome: Parameters<typeof outcomeLine>[0] } {
	const expectation = { kind: "generation-pinned" as const, revision: head };
	const fail = (reason: string) => ({
		verified: false,
		outcome: {
			label,
			expectation,
			kicked: true,
			kickCode: null,
			readiness: { state: "failed" as const, reason },
		},
	});
	const loaded = deps.loadedRevisionFor(label);
	if (loaded !== head)
		return fail("loaded generation is not the published main");
	const url = deps.probeUrlFor(label);
	if (url === null) return fail("no probe URL known for label");
	const probe = deps.probe(url);
	if (!probe.ok)
		return fail(`external probe failed (${url}, status ${probe.status})`);
	return {
		verified: true,
		outcome: {
			label,
			expectation,
			kicked: true,
			kickCode: null,
			readiness: {
				state: "ready" as const,
				reason: `external probe ok (${url})`,
			},
		},
	};
}

export interface PostMergeRunArgs {
	/** fleet main this run publishes/activates. */
	head: string;
	/** labels the drift range demands (or the prior stamp's requested set
	 * when only activation is pending). */
	labels: string[];
	/** prior stamp — publication is skipped when it already carries head. */
	prior: PostMergeStamp | null;
	skipKick: boolean;
	/** readiness poll budget per label (default 30s: the belt-swarm
	 * manifest contract for a child respawn). */
	readinessBudgetMs?: number;
	pollIntervalMs?: number;
}

export interface PostMergeRunResult {
	exit: number;
	/** the activation ledger written to the stamp (null = nothing written:
	 * publication failed, prior stamp stands). */
	activation: PostMergeActivation | null;
}

/** The stamp note when activation is incomplete: one line naming the
 * unsettled labels (kick-failed first — retry-safe — then unready), or the
 * reviewed-upgrade hold. */
function failedNote(
	outcomes: LabelOutcome[],
	needsReviewedUpgrade: string[],
): string {
	const kickFailed = outcomes.filter(
		(o) => o.kickCode !== null && o.kickCode !== 0,
	);
	const unready = outcomes.filter((o) => o.kickCode === 0 && !o.verified);
	const unresolved = [
		...kickFailed,
		...unready.filter((o) => !kickFailed.includes(o)),
	];
	if (unresolved.length > 0)
		return `activation incomplete: ${unresolved.map((o) => o.label).join(",")}`;
	if (needsReviewedUpgrade.length > 0)
		return "held for reviewed upgradeGateway (immutable generation)";
	return "activation verified";
}

/** Same-head unready recheck (#101118): the kick/carry already landed on
 * this main, so NEVER kick again — poll the existing identity + wire
 * proofs to a verdict. A label that stays unready stays in `unready`
 * (re-inspectable, never re-kicked). */
function recheckWithoutKick(
	deps: PostMergeRunnerDeps,
	label: string,
	expectation: LabelExpectation,
	argsHead: string,
	budgetMs: number,
	intervalMs: number,
): LabelOutcome {
	const deadline = deps.now() + budgetMs;
	for (;;) {
		const outcome = recheckAttempt(
			deps,
			label,
			expectation,
			argsHead,
			budgetMs,
			intervalMs,
		);
		if (outcome.verified) return outcome;
		if (deps.now() + intervalMs > deadline) return outcome;
		deps.sleep(intervalMs);
	}
}

/** One recheck attempt: pinned labels re-poll both carry proofs; stable
 * labels re-poll identity + wire probe. No kick is ever issued. */
function recheckAttempt(
	deps: PostMergeRunnerDeps,
	label: string,
	expectation: LabelExpectation,
	argsHead: string,
	budgetMs: number,
	intervalMs: number,
): LabelOutcome {
	if (expectation.kind === "generation-pinned") {
		const attempt = carriedReadiness(deps, label, argsHead);
		return {
			label,
			expectation,
			verified: attempt.verified,
			line: outcomeLine(attempt.outcome),
			kickCode: null,
			carried: true,
		};
	}
	const identity = awaitIdentity(deps, label, budgetMs, intervalMs);
	const url = deps.probeUrlFor(label);
	const probed =
		url === null
			? { ok: false, status: 0 }
			: pollProbe(deps, url, budgetMs, intervalMs);
	const verified = identity.state === "ready" && probed.ok;
	return {
		label,
		expectation,
		verified,
		line: `${label}: recheck (no re-kick) readiness ${identity.state}, probe ${probed.ok ? "ok" : `failed (${probed.status})`}`,
		kickCode: 0,
		carried: false,
	};
}

/** Publish (unless current) then activate every requested label. Exit 0
 * settled (or honest --skip-kick publication) · 1 publication failed · 2
 * activation incomplete — failed, exhausted, or held for the reviewed
 * upgradeGateway path; the stamp keeps the truthful partial ledger either
 * way, so retry state is actionable and never suppressed. */
export function runPostMergeSync(
	deps: PostMergeRunnerDeps,
	args: PostMergeRunArgs,
): PostMergeRunResult {
	const budgetMs = args.readinessBudgetMs ?? 30_000;
	const intervalMs = args.pollIntervalMs ?? 1_000;
	const alreadyPublished = args.prior?.main === args.head;
	if (!alreadyPublished) {
		const install = deps.publish();
		if (install.code !== 0) {
			deps.log(
				`sync failed rc=${install.code} — stamp not advanced, will retry`,
			);
			return { exit: 1, activation: null };
		}
	}
	const receipt = deps.readReceipt();
	const requested = args.labels;
	if (requested.length === 0 && !alreadyPublished) {
		// drift touched nothing that serves: publication IS the whole success
		deps.writeStamp({
			main: args.head,
			installedAt: new Date(deps.now()).toISOString(),
			activation: {
				requested: [],
				verified: [],
				kickFailed: [],
				unready: [],
				needsReviewedUpgrade: [],
			},
		});
		deps.log("synced (no serving labels in drift range)");
		return {
			exit: 0,
			activation: {
				requested: [],
				verified: [],
				kickFailed: [],
				unready: [],
				needsReviewedUpgrade: [],
			},
		};
	}

	const outcomes: LabelOutcome[] = [];
	for (const label of requested) {
		const expectation = expectationFor(label, receipt);
		// Lifecycle eligibility BEFORE any action (#101043): a deferral or an
		// already-complete verification never carries, kicks, or restarts.
		if (args.skipKick) {
			deps.log(`${label}: activation deferred (--skip-kick — published only)`);
			outcomes.push({
				label,
				expectation,
				verified: false,
				line: "",
				kickCode: null,
				carried: false,
			});
			continue;
		}
		// Retention is SAME-MAIN only (#101118/#101160): a prior stamp for a
		// different head is history, not proof — at a new head touched labels
		// activate anew. alreadyPublished == prior.main === this head.
		const priorActivation = alreadyPublished
			? args.prior?.activation
			: undefined;
		if (priorActivation?.verified.includes(label)) {
			outcomes.push({
				label,
				expectation,
				verified: true,
				line: `${label}: verified on prior stamp — retained`,
				kickCode: null,
				carried: false,
			});
			continue;
		}
		if (priorActivation?.unready.includes(label)) {
			// The kick already landed on this main (#101118): re-kicking would
			// restart a running service to "clear" ordinary rate pressure.
			// Inspect + probe only.
			const rechecked = recheckWithoutKick(
				deps,
				label,
				expectation,
				args.head,
				budgetMs,
				intervalMs,
			);
			outcomes.push(rechecked);
			continue;
		}
		if (expectation.kind === "generation-pinned") {
			// The supported rebind: carry through the reviewed upgrade flow
			// (prepare → digest → fenced apply). A plain kickstart here would
			// restart the OLD payload (#101007). Carry failure/pending leaves
			// the label actionable in the ledger — never blind-kicked.
			const carry = deps.carry(args.head);
			deps.log(
				`${label}: generation carry ${carry.state}${carry.reviewSha256 ? ` (review ${carry.reviewSha256.slice(0, 12)})` : ""} — ${carry.reason}`,
			);
			if (carry.state !== "carried") {
				outcomes.push({
					label,
					expectation,
					verified: false,
					line: `${label}: carry ${carry.state} — ${carry.reason}`,
					kickCode: null,
					carried: false,
				});
				continue;
			}
			const readiness = pollCarriedReadiness(
				deps,
				label,
				args.head,
				budgetMs,
				intervalMs,
			);
			deps.log(outcomeLine(readiness.outcome));
			outcomes.push({
				label,
				expectation,
				verified: readiness.verified,
				line: outcomeLine(readiness.outcome),
				kickCode: null,
				carried: true,
			});
			continue;
		}
		outcomes.push(
			...activateStable(deps, label, expectation, budgetMs, intervalMs),
		);
	}

	const verified = outcomes.filter((o) => o.verified).map((o) => o.label);
	// Pinned labels that did NOT verify this cycle: carry failed/pending or
	// readiness unproven — the reviewed upgradeGateway path owns the rebind.
	// A carried-and-verified label is NOT held: the cycle settles on proof.
	const needsReviewedUpgrade = outcomes
		.filter((o) => o.expectation.kind === "generation-pinned" && !o.verified)
		.map((o) => o.label);
	const kickFailed = outcomes
		.filter((o) => o.kickCode !== null && o.kickCode !== 0 && !o.carried)
		.map((o) => o.label);
	const unready = outcomes.filter(
		(o) =>
			o.kickCode === 0 &&
			!o.verified &&
			!o.carried &&
			o.expectation.kind !== "generation-pinned",
	);
	const activation: PostMergeActivation = {
		requested,
		verified,
		kickFailed,
		unready: unready.map((o) => o.label),
		needsReviewedUpgrade,
		...(args.skipKick ? { skipped: true } : {}),
		note: args.skipKick
			? "published without requested activation (--skip-kick)"
			: failedNote(outcomes, needsReviewedUpgrade),
	};
	deps.writeStamp({
		main: args.head,
		installedAt: new Date(deps.now()).toISOString(),
		activation,
	});
	// The stamp never settles while a requested label is unsettled: kick-failed
	// may re-kick next cycle (nothing restarted), unready may only re-inspect
	// (the kick already landed), pinned needs the reviewed upgradeGateway —
	// so the sweep keeps surfacing exactly the missing proof.
	const settled =
		kickFailed.length === 0 &&
		unready.length === 0 &&
		needsReviewedUpgrade.length === 0 &&
		verified.length >= requested.length;
	const exit = args.skipKick || settled ? 0 : 2;
	return { exit, activation };
}
