#!/usr/bin/env bun
// hooks/bin/approve-destructive.ts — the SECOND PERSON in the W250 two-person
// rule. A lane's destructive command is denied once; the human co-signer runs
// THIS from their own terminal (a lane that tries to self-approve gets
// refused — the ppid walk resolves the lane it is running inside), binding an
// approval to the exact command text. Single-use, 24h expiry, signed with
// the same secret/format as skill approvals (lib/approvals.ts is the ONE
// definition).
//
//   bun ~/.claude/hooks/bin/approve-destructive.ts -- rm -rf ./build
//
// The approval binds to the EXACT text the lane will retry — the deny reason
// the gate printed names the minter, the lane retries the identical command.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	approvalSig,
	approvalsDir,
	cmdApprovalSrc,
	secretFile,
} from "../lib/approvals.ts";
import { resolveFleetLane } from "../lib/fleetlane.ts";

// a lane cannot co-sign for itself — the second person is NOT a lane
const lane = resolveFleetLane(process.cwd());
if (lane) {
	console.error(
		`approve-destructive: refusing — this shell resolves as fleet lane ${lane.sid} (item ${lane.item}). The second person is human: run this from your own terminal, not inside a lane.`,
	);
	process.exit(1);
}

// bun swallows the `--` separator (it never reaches process.argv), so accept
// both forms: with `--` (if a future bun passes it through) and without.
const sep = process.argv.indexOf("--");
const cmd = process.argv
	.slice(sep >= 0 ? sep + 1 : 2)
	.join(" ")
	.trim();
if (!cmd) {
	console.error(
		'usage: bun approve-destructive.ts -- <the exact command>  (e.g. bun approve-destructive.ts -- "rm -rf ./build")',
	);
	process.exit(1);
}

const dir = approvalsDir();
const secPath = secretFile();
if (!existsSync(secPath)) {
	console.error(
		`approve-destructive: approval secret missing at ${secPath} — the owner creates it once (0600, 32-byte hex). Then re-run the minter.`,
	);
	process.exit(1);
}
const ts = Math.floor(Date.now() / 1000);
const src = cmdApprovalSrc(cmd);
const sig = approvalSig(src, ts, readFileSync(secPath, "utf8").trim());
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${ts}.approval`);
writeFileSync(
	file,
	`src=${src}
ts=${ts}
sig=${sig}
`,
	{ mode: 0o600 },
);
console.log(`approve-destructive: approval bound to sha256:${src}`);
console.log(`  file: ${file} (single-use, 24h expiry, audited on consumption)`);
console.log(
	`  the lane now retries the IDENTICAL command text and passes the two-person gate once.`,
);
