// post-merge-carry.ts — W2546: the generation-pinned carry through the
// EXISTING reviewed upgrade flow (owner corrections #100967/#100970). When
// the drift range touches a service whose activation receipt pins an
// immutable generation (buckle-spoke), a plain kickstart restarts the OLD
// payload — the 2026-11-02 live reproduction (#101007: harness d8692c35,
// loaded argv still generation 275909df). The supported rebind is
// upgrade-gateway.ts's prepare → review digest → fenced load. This module
// drives THAT step (one activation owner, hash fence intact) with an added
// legitimacy gate: unattended carry auto-approves ONLY a generation-only
// candidate (generation-carry.ts) onto a proven published reviewed main;
// anything broader stays pending for the owner. All process seams
// injectable — tests never touch live launchd or plists.
import { gatewayReviewToken, type GatewayUpgrade } from "../upgrade-gateway.ts";
import {
	generationOnlyCandidate,
	parseLaunchdUnit,
} from "./generation-carry.ts";

export interface CarryDeps {
	/** upgrade-gateway prepareGatewayUpgrade against the live unit+receipt —
	 * the COMPLETE proposal (all snapshot hashes), so the review digest
	 * equals the digest of the exact staged file. */
	prepare: () => GatewayUpgrade;
	/** Read the live unit bytes at proposal.unit. */
	readUnit: (path: string) => string;
	/** plutil -convert json text of a unit's bytes (injected subprocess). */
	unitToJson: (bytes: string) => string | null;
	/** The published harness receipt's revision for provenance proof. */
	publishedRevision: () => string | null;
	/** Revision of the bundle the loaded daemon actually executes
	 * (null = unreadable). Disk unit bytes alone prove nothing about the
	 * running process (#101172). */
	loadedRevision: () => string | null;
	/** upgradeGateway with ctx.gatewayReview = digest (the fenced apply). */
	applyReviewed: (reviewSha256: string) => { status: string; note: string };
	log: (line: string) => void;
}

export interface CarryResult {
	/** "carried" applied via the fenced reviewed flow · "pending" owner
	 * action required (broader candidate or provenance unproven) ·
	 * "failed" the reviewed apply itself failed. */
	state: "carried" | "pending" | "failed";
	reason: string;
	/** the staged proposal digest, for logs and the stamp note. */
	reviewSha256?: string;
}

/** The digest leg shared by carried and pending outcomes: upgradeGateway
 * stages the proposal when run WITHOUT --gateway-review, so the digest is
 * computable without touching any service. */
export function carryGenerationPinned(
	deps: CarryDeps,
	expectedRevision: string,
): CarryResult {
	let proposal: GatewayUpgrade;
	try {
		proposal = deps.prepare();
	} catch (error) {
		return {
			state: "pending",
			reason: `proposal unavailable: ${String(error)}`,
		};
	}
	if (proposal.generation.revision !== expectedRevision) {
		return {
			state: "pending",
			reason: `proposal targets ${proposal.generation.revision.slice(0, 12)}, published main is ${expectedRevision.slice(0, 12)}`,
		};
	}
	if (deps.publishedRevision() !== expectedRevision) {
		return {
			state: "pending",
			reason: "published harness provenance does not match expected main",
		};
	}
	const bundle = proposal.arguments.find((a) => a.endsWith("server.bundle.js"));
	if (bundle === undefined)
		return {
			state: "pending",
			reason: "candidate argv names no generation bundle",
		};
	const liveUnit = parseLaunchdUnit(
		deps.unitToJson(deps.readUnit(proposal.unit)),
	);
	const candidateUnit = parseLaunchdUnit(deps.unitToJson(proposal.candidate));
	const loaded = deps.loadedRevision();
	// Settled state: the disk unit AND the loaded daemon both execute the
	// published generation — nothing to approve; the readiness proof alone
	// settles the label.
	if (
		liveUnit?.ProgramArguments.includes(bundle) &&
		loaded === expectedRevision
	) {
		return {
			state: "carried",
			reason: "loaded unit already executes the published generation bundle",
		};
	}
	// Failed-load retry (#101172): the apply already advanced unit+receipt to
	// the new bundle, but the loaded daemon still executes the old one. The
	// staged candidate equals the live unit — generationOnlyCandidate calls
	// that "no change", so recognize it directly and RE-RUN the fenced load:
	// a fresh prepare snapshots the already-advanced unit+receipt (a legal
	// assertUpgradeSnapshot pass), and the fenced loader retries bootstrap.
	if (
		loaded !== null &&
		loaded !== expectedRevision &&
		liveUnit?.ProgramArguments.includes(bundle) === true
	) {
		deps.log(
			`carry retry: unit advanced to ${expectedRevision.slice(0, 12)} but loaded daemon is ${loaded.slice(0, 12)} — re-running fenced load`,
		);
		const retrySha = gatewayReviewToken(proposal);
		const retried = deps.applyReviewed(retrySha);
		if (retried.status !== "ok") {
			return {
				state: "failed",
				reason: `fenced load retry: ${retried.note}`,
				reviewSha256: retrySha,
			};
		}
		return { state: "carried", reason: retried.note, reviewSha256: retrySha };
	}
	const legitimacy = generationOnlyCandidate(liveUnit, candidateUnit, bundle);
	if (!legitimacy.ok) {
		deps.log(
			`carry refused: candidate not generation-only (${legitimacy.reason}) — staged for owner review`,
		);
		return {
			state: "pending",
			reason: legitimacy.reason ?? "not generation-only",
		};
	}
	const reviewSha256 = gatewayReviewToken(proposal);
	const applied = deps.applyReviewed(reviewSha256);
	if (applied.status !== "ok") {
		return {
			state: "failed",
			reason: `reviewed apply ${applied.status}: ${applied.note}`,
			reviewSha256,
		};
	}
	return { state: "carried", reason: applied.note, reviewSha256 };
}
