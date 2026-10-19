// bench/w949 — ARM A (LLM-banked layer: coord facts + consult_kb).
// Deterministic protocol: 1× shared fact-list discovery, 1× kb stats,
// per question kb search + ≤2 fact get (agent-chosen key guesses).
// Accounts wall-latency + bytes-read per question; tokens ≈ bytes/4.

import { mkdirSync } from "node:fs";
import { QUESTIONS } from "./questions.ts";

const COORD = `${process.env.HOME}/.claude/hooks/suspenders/bin/coord.ts`;
const SID = "autow949-p98b319584008df14";
const OUT = `${import.meta.dir}/results`;
mkdirSync(OUT, { recursive: true });

interface Step {
	cmd: string;
	ms: number;
	bytes: number;
	out: string;
}

function run(cmd: string[]): { ms: number; out: string; err: string } {
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
	return { ms, out, err };
}

const steps: Step[] = [];
const coord = (args: string[]): string => run(["bun", COORD, ...args]).out;
interface ArmAResult {
	qid: string;
	steps: Step[];
	bytes: number;
	ms: number;
}
const results: ArmAResult[] = [];

const _discovery = coord([
	"fact",
	"list",
	"--prefix",
	"lesson.",
	"--limit",
	"40",
	"--as",
	SID,
]);
const kbStats = coord(["kb", "stats", "--as", SID]);

const KEY_GUESSES: Record<string, string[]> = {
	T1: ["finding.w932", "lesson.w932"],
	T2: ["fact.w935", "lesson.w935"],
	T3: ["finding.w918", "lesson.w918"],
	T4: ["finding.w918.5", "lesson.w918.5"],
	T5: ["finding.w927", "lesson.w927"],
	J1: ["lesson.scrub-prepush-flags-branch-base"],
	J2: ["lesson.copied-sleep-fake-zombie"],
	J3: ["lesson.work-done-capsule-checkpoint"],
	J4: ["lesson.merge-ladder-self-ship-veto"],
	J5: ["lesson.retry-after-uncapped-floor"],
};

for (const q of QUESTIONS) {
	const before = steps.length;
	coord(["kb", "search", q.q.split(/\s+/).slice(0, 6).join(" ")]);
	for (const key of KEY_GUESSES[q.id] ?? []) {
		coord(["fact", "get", key, "--as", SID]);
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
	`${OUT}/arm-a.json`,
	JSON.stringify(
		{
			arm: "A",
			layer: "coord facts + consult_kb",
			discoveryBytes: steps.slice(0, 2).reduce((n, s) => n + s.bytes, 0),
			kbStats: kbStats,
			questions: results,
		},
		null,
		2,
	),
);
console.log("ARM A done:", `${OUT}/arm-a.json`);
