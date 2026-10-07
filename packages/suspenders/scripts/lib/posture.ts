// W503 — the dispatch posture: how wide the fleet runs. State is a repo-
// local file (`.fleet/posture`, same trust class as retires-paused) the
// owner flips at runtime — no plist edit, no restart. Two postures:
//
//   steady  fixed width (--target, default 6) — the historical behavior
//   plaid   keyword fan-out (owner keywords: ultrawork / plaid / rw):
//           every READY/resumable item dispatches — width follows the WORK,
//           until the owner flips back. "As many agents as the work allows,
//           drive to done."
//
// plaid deliberately passes the fanout-rate-budget cap (~6 lanes; one
// flash-tier key 429-kills wider fan-outs) — it is an owner-explicit
// choice, surfaced here so it stays a decision, never a default.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export type Posture = "steady" | "plaid";
export const POSTURES: readonly Posture[] = ["steady", "plaid"];

/** Validated parse: "plaid"/"steady" case/space tolerant, junk → null. */
export function parsePosture(raw?: string): Posture | null {
	const v = raw?.trim().toLowerCase();
	return v === "steady" || v === "plaid" ? v : null;
}

/** `.fleet/posture` contents, or steady when absent/unreadable/junk —
 *  fail-safe narrow: an owner typo must never widen the fleet. */
export function readPosture(fleetDir: string): Posture {
	try {
		const raw = readFileSync(`${fleetDir}/posture`, "utf8");
		return parsePosture(raw) ?? "steady";
	} catch {
		return "steady";
	}
}

export function writePosture(fleetDir: string, p: Posture): void {
	mkdirSync(fleetDir, { recursive: true });
	writeFileSync(`${fleetDir}/posture`, `${p}\n`);
}

/** Effective dispatch width: steady caps at target; plaid is work-driven
 *  (unbounded — the READY pool draining is the natural stop). */
export function postureWidth(p: Posture, target: number): number {
	return p === "plaid" ? Number.POSITIVE_INFINITY : target;
}
