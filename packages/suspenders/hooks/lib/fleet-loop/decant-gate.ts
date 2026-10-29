// hooks/lib/fleet-loop/decant-gate.ts — hub design phase 3: decant claims
// are knowledge claims, so a NEW decant claim passes the same Kev
// store/noise/review gate as every other bank before `coord fact set`
// writes it into the knowledge store (knowledge.db knowledge_facts, with
// origin_kind 'decant' and source_ref = the decant run evidence id).
// store/review → written · noise → dropped · unavailable → parked in
// kev_review (the kev-review-drain re-asks later; its store verdict routes
// the claim to the knowledge ingest queue). Reclaims and tombstones touch
// rows that already passed the gate, so they ride through ungated.
// The bin injects the gate; the library default is ungated so unit suites
// never reach a live Kev or the operator's knowledge.db.
import type { CurationInput, KevCuration } from "../knowledge/kev-curation.ts";
import { curationGate, type ReviewEntry } from "../knowledge/kev-review.ts";

export interface GateableWrite {
	mode: "create" | "reclaim";
	claim: { key: string; evidenceId: string; value: string };
}

export interface DecantGateDeps {
	curate: (input: CurationInput) => Promise<KevCuration>;
	defer: (entry: ReviewEntry) => void;
	project: string;
}

export interface DecantGateOutcome<W> {
	keep: W[];
	noise: string[];
	deferred: string[];
}

export async function gateDecantWrites<W extends GateableWrite>(
	writes: W[],
	deps: DecantGateDeps,
): Promise<DecantGateOutcome<W>> {
	const out: DecantGateOutcome<W> = { keep: [], noise: [], deferred: [] };
	for (const w of writes) {
		if (w.mode !== "create") {
			out.keep.push(w);
			continue;
		}
		const v = await deps.curate({
			kind: "decant",
			title: w.claim.key,
			text: w.claim.value,
			reference: w.claim.evidenceId,
		});
		const gate = curationGate(v.choice);
		if (gate === "store") out.keep.push(w);
		else if (gate === "drop") out.noise.push(w.claim.key);
		else {
			deps.defer({
				kind: "decant",
				reference: w.claim.key,
				title: w.claim.key,
				text: `${w.claim.value}\nsource_ref: decant:${w.claim.evidenceId}`,
				sid: "decant-daily",
				project: deps.project,
			});
			out.deferred.push(w.claim.key);
		}
	}
	return out;
}
