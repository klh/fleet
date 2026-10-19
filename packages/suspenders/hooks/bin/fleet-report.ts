#!/usr/bin/env bun
// fleet-report.ts — the ONE supervisor report (W892 standard, owner GO 2026-10-19).
// W909: the face is a THIN wrapper — it shells `work report` (the W892 verb)
// and prints the table verbatim; ONE pad/column implementation lives in
// hooks/lib/work-report.ts (repo law: the reporter computes the pads, the
// face never hand-rolls them). Columns: ITEM/ST/TASK/TOKENS/CACHE/OUT-MIN/
// AGENT/MODEL/EFFORT/CONSULT. ST: R riding | Q queued | D done | F failed.
// Usage: bun fleet-report.ts [W-id ...] (default: the active pool — riding +
// queued + up to 5 most-recent done; ids resolve strictly).

const WORK = process.env.SUSPENDERS_WORK_CLI ?? "";
const workCli = WORK || new URL("work.ts", import.meta.url).pathname;

const p = Bun.spawnSync(["bun", workCli, "report", ...process.argv.slice(2)], {
	stdout: "pipe",
	stderr: "pipe",
});
const out = new TextDecoder().decode(p.stdout ?? new Uint8Array()).trimEnd();
const err = new TextDecoder().decode(p.stderr ?? new Uint8Array()).trimEnd();

if (!out.trim()) {
	// the verb said nothing on stdout — surface its stderr, else the legacy
	// empty-pool line (never a silent empty reply)
	if (err) console.error(err);
	else console.log("no pool items");
	process.exit(p.exitCode ?? 0);
}
console.log(out);
console.log(
	"ST: R riding | Q queued | D done | F failed  ·  deep-link: #lanes?w=<id> (W890)",
);
