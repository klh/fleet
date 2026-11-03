// fleet-loop/merge-defer.ts — W2561: the per-item merge defer. W1302.1's
// merge-hold is repo-wide and the W641 lease only covers CLAIMED/RUNNING, so
// a DONE-item branch had NO per-item hold: root #101230 — W2549 auto-landed
// e0b2300e mid-install and runtime-sync kicked belt-swarm/dashboard/board
// 12:07Z inside the W2546 outage window. The defer file is the same contract
// shape as a hold (owner/reason/expiresAt, ISO or epoch ms, ≤7-day cap), one
// file per branch: `.fleet/merge-defer/<branch>.json`. mergeOne defers the
// branch (and its retirement) while the defer is active; createRuntimeSync
// skips its sweep while ANY active defer exists (a held landing must not
// publish+restart surfaces either — the exact #101230 mechanism). An expired
// or malformed defer never blocks forever (the A2 lesson): the pure view
// carries the state, runtimeSync's read ages out expired defers with a
// NEED_DECISION, and enforceMergeDefers (cycle/flush entry) sweeps every
// non-active defer aside the same way enforceMergeHold does.
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity } from "../govdb/govdb.ts";
import { emitLoopEvent } from "./events.ts";
import { parseHoldBody } from "./merge-hold.ts";

export const MERGE_DEFER_DIR = ".fleet/merge-defer";

/** Same contract shape as a MergeHold — one file per deferred branch. */
export type MergeDefer = {
	branch: string;
	owner: string;
	reason: string;
	expiresAt: number;
};

export type MergeDeferView =
	| { state: "none" }
	| { state: "active"; defer: MergeDefer }
	| { state: "expired"; defer: MergeDefer }
	| { state: "malformed"; branch: string; why: string };

// branches are namespaced ("suspenders/W2561") — a bare `<branch>.json` would
// nest a directory the readdir scan never sees, so the filename carries the
// branch percent-encoded (flat, one file per branch, reversible).
const encodeBranch = (branch: string): string =>
	branch.replace(/%/g, "%25").replace(/\//g, "%2F");
const decodeBranch = (file: string): string =>
	decodeURIComponent(file.slice(0, -".json".length));

/** W2580 (N3a, review #103237): the REAL on-disk file name for a branch's
 * defer — what an operator copies from a log line must be the encoded path
 * the scan reads (`suspenders%2FW2561.json`), never the raw branch nesting
 * a directory the readdir never sees. */
export const deferFileName = (branch: string): string =>
	`${encodeBranch(branch)}.json`;

const deferPath = (repo: string, branch: string): string =>
	join(repo, MERGE_DEFER_DIR, deferFileName(branch));

// reuse the hold's provenance validation (owner/reason/expiresAt, ISO or ms,
// ≤7-day cap) — one source for the contract shape, never two
const bodyToView = (branch: string, raw: string): MergeDeferView => {
	const view = parseHoldBody(raw);
	if (view.state === "active")
		return { state: "active", defer: { branch, ...view.hold } };
	if (view.state === "expired")
		return { state: "expired", defer: { branch, ...view.hold } };
	if (view.state === "malformed")
		return { branch, state: "malformed", why: view.why };
	return { state: "none" };
};

/** Read + validate one branch's defer: pure, never throws, no side effects. */
export function readMergeDefer(repo: string, branch: string): MergeDeferView {
	const file = deferPath(repo, branch);
	if (!existsSync(file)) return { state: "none" };
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (e) {
		return {
			branch,
			state: "malformed",
			why: `unreadable: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	return bodyToView(branch, raw);
}

/** THE per-item ladder predicate (W2561): true only for a present,
 * well-formed, unexpired defer file. Malformed/expired read inactive (the
 * A2 fail-open direction) — enforcement makes that safe by refusing loudly. */
export function mergeDeferredActive(repo: string, branch: string): boolean {
	return readMergeDefer(repo, branch).state === "active";
}

/** Every branch that has a defer file, any state — the sync-gate scan.
 * W2580 (N3b, review #103237): one bad-percent filename no longer disables
 * the ENTIRE scan (the old catch-all returned [] silently). The undecodable
 * file is QUARANTINED aside (the setAside semantics — `.json.rejected`), so
 * the warning + NEED_DECISION fire exactly ONCE, never per scan (the scan
 * runs from both enforcement and the sync gate every cycle); every OTHER
 * defer keeps gating. A missing/unreadable dir still reads as no defers. */
export function deferredBranches(
	repo: string,
	warn: (line: string) => void = console.error,
): string[] {
	let files: string[];
	try {
		files = readdirSync(join(repo, MERGE_DEFER_DIR));
	} catch {
		return [];
	}
	const branches: string[] = [];
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			branches.push(decodeBranch(f));
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			const file = join(repo, MERGE_DEFER_DIR, f);
			let quarantined = false;
			try {
				renameSync(file, `${file}.rejected`);
				quarantined = true;
			} catch {
				/* rename raced or dir readonly — warn every scan until fixed */
			}
			warn(
				`DEFER-UNREADABLE ${MERGE_DEFER_DIR}/${f} — bad percent-encoding (${why}); ${quarantined ? "set aside" : "could not set aside"}, scan continues`,
			);
			if (quarantined)
				emitLoopEvent("NEED_DECISION", "merge-defer", {
					project: projectIdentity(repo),
					reason: `defer file ${f} is not decodable (${why}); quarantined as ${f}.rejected — rename or remove it`,
					file: `${MERGE_DEFER_DIR}/${f}`,
				});
		}
	}
	return branches;
}

/** Set a non-active defer aside (.expired / .rejected suffix); never throws. */
function setAside(repo: string, branch: string, kind: "expired" | "rejected") {
	try {
		renameSync(deferPath(repo, branch), `${deferPath(repo, branch)}.${kind}`);
	} catch {
		/* already set aside by a concurrent entry; callers still log */
	}
}

/** The expired-defer age-out (shared by anyMergeDeferred and
 * enforceMergeDefers): set aside + log + NEED_DECISION, never throws. */
function expireDefer(
	repo: string,
	branch: string,
	defer: MergeDefer,
	log?: (line: string) => void,
) {
	setAside(repo, branch, "expired");
	log?.(
		`DEFER-EXPIRED ${MERGE_DEFER_DIR}/${deferFileName(branch)} — owner=${defer.owner} expired at ${new Date(defer.expiresAt).toISOString()}; set aside, ladder+sync resume for ${branch}`,
	);
	emitLoopEvent("NEED_DECISION", "merge-defer", {
		project: projectIdentity(repo),
		reason: `expired per-item merge defer (owner ${defer.owner}, reason: ${defer.reason}) set aside for ${branch}; ladder and runtime sync resume for it`,
		branch,
		owner: defer.owner,
		expiresAt: defer.expiresAt,
	});
}

/** The sync gate (W2561): true when ANY active defer exists — a held landing
 * must not publish+restart surfaces (the #101230 mechanism). Expired defers
 * age out HERE too (the cycle's enforcement may not have run yet when the
 * sync step reads the dir) so none gates the sweep forever. */
export function anyMergeDeferred(
	repo: string,
	log?: (line: string) => void,
): boolean {
	let active = false;
	for (const branch of deferredBranches(repo, log)) {
		const view = readMergeDefer(repo, branch);
		if (view.state === "active") active = true;
		else if (view.state === "expired")
			expireDefer(repo, branch, view.defer, log);
	}
	return active;
}

/** Controller-side enforcement (cycle/flush/ship entry, the enforceMergeHold
 * role): set every expired/malformed defer aside with one NEED_DECISION each
 * so the pure predicate's fail-open direction can never defer or gate
 * forever. Never throws. */
export function enforceMergeDefers(
	repo: string,
	log: (line: string) => void,
): void {
	for (const branch of deferredBranches(repo, log)) {
		const view = readMergeDefer(repo, branch);
		if (view.state === "expired") {
			expireDefer(repo, branch, view.defer, log);
			continue;
		}
		if (view.state === "malformed") {
			setAside(repo, branch, "rejected");
			log(
				`DEFER-REJECTED ${MERGE_DEFER_DIR}/${deferFileName(branch)} — ${view.why}; set aside, ladder+sync resume for ${branch}`,
			);
			emitLoopEvent("NEED_DECISION", "merge-defer", {
				project: projectIdentity(repo),
				reason: `malformed per-item merge defer for ${branch} (${view.why}) set aside; a defer requires owner, reason and expiresAt (≤7 days)`,
				branch,
			});
		}
	}
}
