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
import { resolveFleetLane } from "../lib/lanes/fleetlane.ts";

// a lane cannot co-sign for itself — the second person is NOT a lane
const lane = resolveFleetLane(process.cwd());
if (lane) {
	console.error(
		`approve-destructive: refusing — this shell resolves as fleet lane ${lane.sid} (item ${lane.item}). The second person is human: run this from your own terminal, not inside a lane.`,
	);
	process.exit(1);
}

// bun swallows a leading `--` (W250, baked into the kit) and a surviving
// `--` is end-of-options — either way the RAW token list IS the command
// text: unknown-looking tokens must survive verbatim, so the spec is lax
// and cmd comes from parsed.rest, never from the positional list.
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "approve",
	usage:
		'usage: bun approve-destructive.ts -- <the exact command>  (e.g. bun approve-destructive.ts -- "rm -rf ./build")',
	minPos: 1,
	lax: true,
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
const cmd = outcome.parsed.rest
	.slice(outcome.parsed.rest[0] === "--" ? 1 : 0)
	.join(" ")
	.trim();
if (!cmd) {
	console.error(outcome.message);
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
