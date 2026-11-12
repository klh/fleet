// review-provider-pressure.ts — the W1280 AIMD provider-pressure ledger,
// keyed per provider group (W3012). History: W1280 introduced the ledger as
// ONE shared fact key — every transport failure opened a GLOBAL pause window
// — and W2356 added the lapsed-pause canary probe. The 2026-11-11 storm
// specimen showed both the coupling and a conflation: one provider's 429/503
// wave paused EVERY group's review admissions (44 pending / 0 admitted for
// hours while a second provider was healthy), and deterministic policy/input
// refusals (diff budget, bounded audit, blocking-findings cap) re-armed the
// same ledger on every backoff — a refusal is the INPUT failing, so it
// re-fires identically forever and must never pause a healthy provider.
// W3012 keys the ledger by the routed provider group (the request's model)
// and classifies the deterministic refusals out of AIMD entirely. Ceilings,
// canary, jitter and the scheduler's admission authority are unchanged.
import { createHash } from "node:crypto";
import type { GovernorStore } from "../govdb/govdb-store.ts";

export interface Pressure {
	fails: number;
	openUntil: number;
	updated: number;
	/** W2356: the expiry canary — the one leg admitted when a pause lapsed,
	 * holding peers off until it finishes (or this window lapses). Any
	 * applyPressure clears it: the canary's finish IS the resolution. */
	probe?: { key: string; until: number };
}
/** W1280 legacy global fact key — the row pre-W3012 in-flight rows still
 * read and write (a legacy finish without a routed group feeds it), and the
 * transition cross-check in admission holds new groups against its
 * time-bounded window/probe. Failure MEMORY is not inherited from it: it
 * decays only by lapse, never by a grouped served verdict. */
export const providerPressureKey = "review.provider.pressure";
/** W3012: group-scoped ledger key — group = the routed/requested model id
 * (the provider group a review leg actually rides). */
export const providerPressureKeyOf = (group?: string): string =>
	group ? `${providerPressureKey}.${group}` : providerPressureKey;
/** 30s doubling to a 2m ceiling (W2356: was 10m — see the W1280 ledger
 * header in review-scheduler.ts). */
const pressureMs = (fails: number): number =>
	Math.min(120_000, 30_000 * 2 ** Math.max(0, fails - 1));
/** W2356: how long an admitted canary holds the probe window — spans a
 * normal verdict leg (~100-400s observed) while bounding a hung one; the
 * crash/launch-failure finish paths resolve it far sooner. */
export const canaryProbeMs = 300_000;
/** Deterministic reopen spread (0-90s) — the deferred backlog must not
 * re-fire as one herd the instant the pause expires. */
export const jitterMs = (key: string): number =>
	Number(
		BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0, 8)}`) %
			90_000n,
	);
/** Read the provider pressure ledger for one group (undefined group = the
 * legacy global row). Absent/corrupt = healthy. */
export function providerPressureOf(
	db: GovernorStore,
	group?: string,
): Pressure {
	try {
		const row = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(providerPressureKeyOf(group)) as { value: string } | null;
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
/** W3012: worst-case pressure across every ledger row (all groups plus the
 * legacy global row) — the reconcile sweep's human face: is ANY provider
 * group pressured right now. */
export function providerPressureAggregate(db: GovernorStore): Pressure {
	const rows = db
		.query("SELECT value FROM facts WHERE key LIKE ?")
		.all(`${providerPressureKey}%`) as { value: string }[];
	const acc: Pressure = { fails: 0, openUntil: 0, updated: 0 };
	for (const row of rows) {
		try {
			const p = JSON.parse(row.value) as Partial<Pressure>;
			acc.fails = Math.max(acc.fails, Number(p.fails) || 0);
			acc.openUntil = Math.max(acc.openUntil, Number(p.openUntil) || 0);
			acc.updated = Math.max(acc.updated, Number(p.updated) || 0);
			if (
				!acc.probe &&
				p.probe &&
				typeof p.probe.key === "string" &&
				Number.isFinite(p.probe.until)
			)
				acc.probe = { key: p.probe.key, until: Number(p.probe.until) };
		} catch {
			// corrupt row — skip it (healthy contributes nothing)
		}
	}
	return acc;
}
/** AIMD update for one group — caller must already be inside a transaction
 * (bun:sqlite nesting). A failure opens that group's pause; a served verdict
 * HALVES the failure memory and shortens the pause to the decayed level but
 * does not cancel an active cooldown (#70140): with 8 legs in flight and a
 * 429 every ~7s, one isolated success must not reopen the admission gate
 * mid-storm. Only failure memory drained to zero (sustained success) fully
 * reopens. */
export function applyPressure(
	db: GovernorStore,
	failed: boolean,
	group?: string,
): void {
	const now = Date.now();
	const current = providerPressureOf(db, group);
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
	).run(providerPressureKeyOf(group), JSON.stringify(next), now);
}
/** W3012: the deterministic policy/input refusal classes — the reason
 * strings the review stack throws for LOCAL blockers (review-lane diff
 * budget, review-receipt bounded audit + blocking-findings cap). None of
 * them is the provider failing: the leg never reached (or never needed) the
 * wire, the identical re-drive fails identically, so they keep W1243's
 * refund/backoff but NEVER re-arm provider AIMD. */
export const deterministicRefusalMarkers = [
	"review-lane: full exact diff unavailable or exceeds review budget",
	"exact-commit review history exceeds bounded audit",
	"too many prior blocking findings",
] as const;
export const deterministicRefusal = (reason?: string): boolean =>
	Boolean(
		reason && deterministicRefusalMarkers.some((m) => reason.startsWith(m)),
	);
