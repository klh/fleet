// hooks/lib/approvals.ts — the ONE definition of the signed-approval format,
// shared by the minters (approve-skill, approve-destructive) and the gate
// reader. If this format changes, change it HERE only.
//
// File format (~/.claude-insights/.approvals/<epoch-ts>.approval):
//   src=<source-ref | cmd:<sha256(command)>>
//   ts=<epoch-seconds>
//   sig=hmac-sha256("<src>|<ts>", secret)
// Secret: ~/.claude/.skill-review-secret (0600, 32-byte hex)
// Policy: single-use (consumed on match), 24h expiry, source-bound.
// W250: the cmd: flavor binds an approval to the EXACT command text — the
// two-person rule for lane-issued destructive changes. Env seams
// SUSPENDERS_APPROVALS_DIR / SUSPENDERS_APPROVAL_SECRET exist for tests;
// unset they resolve to the owner paths above.
import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";

export const approvalsDir = (): string =>
	process.env.SUSPENDERS_APPROVALS_DIR ??
	`${process.env.HOME}/.claude-insights/.approvals`;
export const secretFile = (): string =>
	process.env.SUSPENDERS_APPROVAL_SECRET ??
	`${process.env.HOME}/.claude/.skill-review-secret`;
const EXPIRY_S = 86400;

const sha256hex = (s: string): string =>
	createHash("sha256").update(s).digest("hex");

// cmd-bound approvals: src=cmd:<sha256(command)> — binds to the exact text
export const cmdApprovalSrc = (cmd: string): string => `cmd:${sha256hex(cmd)}`;

// W1308 risk-bound approvals: src=risk:<sha256(project|branch|commit|tier)> —
// binds a human merge approval to the EXACT candidate the risk-tier gate
// classified. A new commit, a moved base, or a re-tiered diff changes the
// src, so a stale approval can never authorize a different change.
export const riskApprovalSrc = (
	project: string,
	branch: string,
	commit: string,
	tier: string,
): string => `risk:${sha256hex(`${project}|${branch}|${commit}|${tier}`)}`;

// the ONE sig scheme (both flavors): hmac-sha256(secret, "<src>|<ts>")
export const approvalSig = (src: string, ts: number, secret: string): string =>
	createHmac("sha256", secret).update(`${src}|${ts}`).digest("hex");

// internal: scan the approvals dir, verify expiry + signature, consume the
// FIRST file whose src the matcher accepts (single-use policy lives here).
function scanAndConsume(match: (src: string) => boolean): boolean {
	if (!existsSync(approvalsDir()) || !existsSync(secretFile())) return false;
	const secret = readFileSync(secretFile(), "utf8").trim();
	const now = Date.now() / 1000;
	for (const f of readdirSync(approvalsDir())) {
		if (!f.endsWith(".approval")) continue;
		const content = readFileSync(`${approvalsDir()}/${f}`, "utf8");
		const src = /^src=(.*)$/m.exec(content)?.[1] ?? "";
		const ts = Number(/^ts=(.*)$/m.exec(content)?.[1] ?? 0);
		const sig = /^sig=(.*)$/m.exec(content)?.[1] ?? "";
		if (now - ts > EXPIRY_S) {
			try {
				unlinkSync(`${approvalsDir()}/${f}`);
			} catch {}
			continue;
		}
		if (sig !== approvalSig(src, ts, secret)) continue;
		if (match(src)) {
			try {
				unlinkSync(`${approvalsDir()}/${f}`);
			} catch {} // consume (single-use)
			return true;
		}
	}
	return false;
}

export function verifyAndConsume(matchSource: string): boolean {
	// Bind: the approval's source must match the install target.
	// Exact match, or the source-ref appears as a substantial substring of a
	// command word (not a trivial token that matches anything).
	if (matchSource.length > 8)
		return scanAndConsume(
			(src) =>
				src === matchSource ||
				src.includes(matchSource) ||
				matchSource.includes(src),
		);
	return scanAndConsume((src) => src === matchSource);
}

// W250 two-person rule: the approval binds to the EXACT command text.
export function verifyAndConsumeCmd(cmd: string): boolean {
	return scanAndConsume((src) => src === cmdApprovalSrc(cmd));
}

/** W1308: live, signature-verified risk-approval FILES bound to one
 * candidate src (unexpired). Shared by count (pre-merge gate) and consume
 * (post-merge burn) — a partial count must never burn what it counted. */
function liveRiskApprovalFiles(src: string): string[] {
	if (!existsSync(approvalsDir()) || !existsSync(secretFile())) return [];
	const secret = readFileSync(secretFile(), "utf8").trim();
	const now = Date.now() / 1000;
	const files: string[] = [];
	for (const f of readdirSync(approvalsDir())) {
		if (!f.endsWith(".approval")) continue;
		const content = readFileSync(`${approvalsDir()}/${f}`, "utf8");
		const s = /^src=(.*)$/m.exec(content)?.[1] ?? "";
		const ts = Number(/^ts=(.*)$/m.exec(content)?.[1] ?? 0);
		const sig = /^sig=(.*)$/m.exec(content)?.[1] ?? "";
		if (now - ts > EXPIRY_S) continue; // expired: not counted, swept later
		if (sig !== approvalSig(s, ts, secret)) continue;
		if (s === src) files.push(f);
	}
	return files;
}

/** W1308: count the live risk approvals bound to a candidate WITHOUT
 * consuming — the ladder merges only when this reaches the tier's demand. */
export function countRiskApprovals(src: string): number {
	return liveRiskApprovalFiles(src).length;
}

/** W1308: consume exactly n risk approvals bound to the candidate — called
 * by the ladder AFTER a successful guarded merge, so a deferred or failed
 * candidate keeps its approvals for the retry. Single-use per file, same as
 * every other flavor. Returns how many were burned. */
export function consumeRiskApprovals(src: string, n: number): number {
	let used = 0;
	for (const f of liveRiskApprovalFiles(src)) {
		if (used >= n) break;
		try {
			unlinkSync(`${approvalsDir()}/${f}`);
		} catch {}
		used++;
	}
	return used;
}

/** Find the most likely "source ref" token in an install command — the
 *  org/repo or org/repo@ref argument. Heuristic: longest non-flag word
 *  containing a slash that isn't a path into the skills dirs. */
export function extractSourceRef(cmdWords: string[]): string {
	const SKILLS_PATH = /\.claude\/skills|\.agents\/skills/;
	const candidates = cmdWords.filter(
		(w) => w.includes("/") && !w.startsWith("-") && !SKILLS_PATH.test(w),
	);
	return candidates.sort((a, b) => b.length - a.length)[0] ?? "";
}
