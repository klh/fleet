#!/usr/bin/env bun
// fleet-report.ts — thin shim over the `work report` verb (W913): argv
// forwards verbatim, stdout/stderr/exit-code propagate. The installed face
// path stays stable for the W892/W899 supervisor contract + the install
// tail; the glyph/spend-line parser retired here — the verb (hooks/lib/
// work-report.ts) is the ONE implementation of the supervisor table.

const workCli =
	process.env.SUSPENDERS_WORK_CLI ??
	new URL("work.ts", import.meta.url).pathname;

const p = Bun.spawnSync(["bun", workCli, "report", ...process.argv.slice(2)], {
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(p.exitCode ?? 1);
