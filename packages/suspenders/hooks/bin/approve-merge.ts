#!/usr/bin/env bun
// hooks/bin/approve-merge.ts — the human slot in the W1303.5/W1308 risk-tier
// gate. The merge ladder defers medium/high candidates until the tier's
// approvals exist; THIS minter is how a human fills a slot. It binds the
// signature to the EXACT candidate — project|branch|commit|tier — using the
// ONE approval definition (lib/approvals.ts, risk flavor): HMAC-signed,
// single-use, 24h expiry. A lane cannot self-approve (same refusal as
// approve-destructive: agent approval never fills a human slot).
//
//   bun ~/.claude/hooks/bin/approve-merge.ts suspenders/W1303.5
//
// Run from the fleet root (or anywhere inside it) in YOUR OWN terminal. The
// tier shown is the same classification the ladder runs, so what you approve
// is what the gate demands. The ladder counts WITHOUT consuming; it burns
// approvals only after a successful guarded merge.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { approvalSig, approvalsDir, secretFile } from "../lib/approvals.ts";
import {
	candidatePaths,
	classifyRiskTier,
	riskApprovalsOf,
} from "../lib/gates/risk-tier.ts";
import { projectIdentity } from "../lib/govdb/govdb.ts";
import { resolveFleetLane } from "../lib/lanes/fleetlane.ts";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

const gitRoot = (cwd: string): string | null => {
	const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};
const repo = gitRoot(process.cwd());
if (!repo) {
	console.error(
		"approve-merge: not inside a git repo — run from the fleet root",
	);
	process.exit(1);
}

// a lane cannot approve a merge — the slot is human, same rule as W250
const lane = resolveFleetLane(process.cwd());
if (lane) {
	console.error(
		`approve-merge: refusing — this shell resolves as fleet lane ${lane.sid} (item ${lane.item}). The risk-tier slot is human: run this from your own terminal.`,
	);
	process.exit(1);
}

const SPEC = defineVerb({
	name: "approve-merge",
	usage:
		"usage: bun approve-merge.ts <branch>  (e.g. bun approve-merge.ts suspenders/W1303.5)",
	minPos: 1,
});
const tokens = process.argv.slice(2);
if (tokens.includes("--help") || tokens.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, tokens);
if (!outcome.ok) {
	console.error(outcome.message);
	process.exit(1);
}
const branch = outcome.parsed.pos[0] ?? "";

const resolveCommit = Bun.spawnSync(
	["git", "rev-parse", "--verify", `${branch}^{commit}`],
	{ cwd: repo, stdout: "pipe", stderr: "pipe" },
);
if (resolveCommit.exitCode !== 0) {
	console.error(`approve-merge: cannot resolve branch ${branch} in ${repo}`);
	process.exit(1);
}

// The SAME classification the ladder runs — the signature binds the tier it
// computes, so a re-tiered diff can never ride an old approval.
const risk = classifyRiskTier(candidatePaths(repo, "HEAD", branch));
if (risk.approvals === 0) {
	console.error(
		`approve-merge: ${branch} classifies ${risk.tier} (0 approvals) — nothing to approve; the ladder merges it on the machine receipt alone.`,
	);
	process.exit(0);
}

const secPath = secretFile();
if (!existsSync(secPath)) {
	console.error(
		`approve-merge: approval secret missing at ${secPath} — the owner creates it once (0600, 32-byte hex). Then re-run the minter.`,
	);
	process.exit(1);
}
const project = projectIdentity(repo);
const src = riskApprovalsOf(repo, branch, risk, project).src;
const ts = Math.floor(Date.now() / 1000);
const sig = approvalSig(src, ts, readFileSync(secPath, "utf8").trim());
mkdirSync(approvalsDir(), { recursive: true, mode: 0o700 });
// unique file name: two humans minting in the same second must not clobber
// each other (high tier demands two approvals); content ts stays seconds.
const file = `${approvalsDir()}/${ts}-${crypto.randomUUID().slice(0, 8)}.approval`;
writeFileSync(file, `src=${src}\nts=${ts}\nsig=${sig}\n`, { mode: 0o600 });
console.log(`approve-merge: ${risk.tier}-tier approval bound to ${branch}`);
console.log(`  commit: ${resolveCommit.stdout.toString().trim()}`);
console.log(`  evidence: ${risk.reasons.join("; ")}`);
console.log(
	`  file: ${file} (single-use, 24h expiry, burned on successful merge)`,
);
console.log(
	`  the ladder needs ${risk.approvals} approval(s); mint ${risk.approvals > 1 ? `each from a DIFFERENT person` : "one"} — the next fleet-loop cycle merges and burns them.`,
);
