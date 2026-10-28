#!/usr/bin/env bun
// W2178 CI face for one playwright config: runs it and fails when the run
// collected fewer than <min> tests — "No tests found" (or a silently shrunk
// corpus) is red, never a green no-op.
// usage: bun scripts/playwright-ci.ts <config-dir> <min> [--project=<name>]
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [dir, minArg, ...rest] = process.argv.slice(2);
const min = Number(minArg);
if (!dir || !Number.isInteger(min) || min < 1) {
	console.error("usage: playwright-ci.ts <config-dir> <min> [--project=<name>]");
	process.exit(1);
}
const cwd = resolve(dir);
const out = join(mkdtempSync(join(tmpdir(), "pw-ci-")), "report.json");
const run = Bun.spawnSync(
	[process.execPath, "--bun", "playwright", "test", "-c", "playwright.config.ts", "--reporter=line,json", ...rest],
	{ cwd, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out }, stdout: "inherit", stderr: "inherit" },
);
type Stats = { expected: number; unexpected: number; skipped: number; flaky: number };
let stats: Stats = { expected: 0, unexpected: 0, skipped: 0, flaky: 0 };
try {
	stats = (JSON.parse(readFileSync(out, "utf8")) as { stats: Stats }).stats;
} catch {
	console.error(`${dir}: no JSON report written (playwright exit ${run.exitCode})`);
}
const total = stats.expected + stats.unexpected + stats.skipped + stats.flaky;
console.log(
	`${dir}: ${total} tests — ${stats.expected} passed, ${stats.unexpected} failed, ${stats.skipped} skipped, ${stats.flaky} flaky (min ${min})`,
);
if (total < min) {
	console.error(`${dir}: collected ${total} < min ${min} — corpus missing or not loading`);
	process.exit(1);
}
process.exit(run.exitCode ?? 1);
