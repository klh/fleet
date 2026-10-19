// bench/w949 — ARM B (mechanical layer: decant FTS + per-session
// stats over the SAME fleet transcripts). Private bench db: the live
// ~/.decant db is locked by the standing serve instance.
// Timing/bytes accounted like ARM A; the sync pass is the measured
// mechanical indexing cost, amortized across all queries.

import { mkdirSync, readdirSync } from "node:fs";
import { QUESTIONS } from "./questions.ts";

const DECANT = "/opt/homebrew/bin/decant";
const DB = "/private/tmp/w949-bench.db";
const OUT = `${import.meta.dir}/results`;
mkdirSync(OUT, { recursive: true });

interface Step {
	cmd: string;
	ms: number;
	bytes: number;
	out: string;
}

const steps: Step[] = [];
const results: Array<{
	qid: string;
	steps: Step[];
	bytes: number;
	ms: number;
}> = [];

function run(cmd: string[]): string {
	const t0 = Bun.nanoseconds();
	const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	const ms = Number((Bun.nanoseconds() - t0) / 1e6);
	const out = p.stdout.toString();
	const err = p.stderr.toString();
	steps.push({
		cmd: cmd.slice(1).join(" ").replaceAll(`${process.env.HOME}/`, "~/"),
		ms,
		bytes: out.length + err.length,
		out: `${out}${err}`,
	});
	return out;
}

const decant = (args: string[]): string =>
	run([DECANT, "--db", DB, ...args, "--no-sync"]);

// ── indexing cost: one full sync of the fleet transcript corpus ───────────
const PROJECTS = `${process.env.HOME}/.claude/projects`;
const fleetDirs = readdirSync(PROJECTS).filter((d) => d.includes("klh-fleet"));
const syncT0 = Bun.nanoseconds();
for (const dir of fleetDirs) {
	run([DECANT, "--db", DB, "sync", "--path", `${PROJECTS}/${dir}`, "--json"]);
}
const syncMs = Number((Bun.nanoseconds() - syncT0) / 1e6);

// Shared surfaces (counted once): per-session rollup rows + FTS hits.
const lsOut = decant(["ls", "--json", "--limit", "600"]);
const statsOut = decant(["stats", "--json"]);

const perQ: Record<string, string[]> = {
	T1: ["W932"],
	T2: ["W935"],
	T3: ["W918"],
	T4: ["W918.5"],
	T5: ["W927"],
	J1: ["scrub pre-push allow marker", "scrub pre-push"],
	J2: ["copied sleep zombie", "fake zombie sleep"],
	J3: ["rev-parse failed capsule", "capsule checkpoint"],
	J4: ["merge ladder claimed branch", "merge ladder"],
	J5: ["retry_after_cap_s", "retry after 429"],
};

for (const q of QUESTIONS) {
	const before = steps.length;
	for (const kw of perQ[q.id] ?? []) {
		decant(["search", kw, "--json", "--limit", "10"]);
	}
	const qSteps = steps.slice(before);
	results.push({
		qid: q.id,
		steps: qSteps,
		bytes: qSteps.reduce((n, s) => n + s.bytes, 0),
		ms: qSteps.reduce((n, s) => n + s.ms, 0),
	});
}

await Bun.write(
	`${OUT}/arm-b.json`,
	JSON.stringify(
		{
			arm: "B",
			layer: "decant FTS + session stats",
			syncMs,
			sessions: fleetDirs.length,
			sharedBytes: {
				ls: lsOut.length,
				stats: statsOut.length,
			},
			questions: results,
		},
		null,
		2,
	),
);
console.log("ARM B done:", `${OUT}/arm-b.json`);
