#!/usr/bin/env bun
// local-reason-publish-gate.ts — W532.1: the gate between a finished run and
// a benchmarks.md row. A comparison row may only cite a run whose jsonl
// verifies as sealed evidence: one complete seal, the full predeclared round
// matrix attempted exactly once per (round, task, leg), per-round identity
// evidence on every transport-ok row, and an end summary that the rows
// actually recompute to. Exit 0 = the run may be published; anything else
// names what broke.
// usage: bun bench/local-reason-publish-gate.ts <arena/results/local-reason-w532/<run>.jsonl>
import { existsSync, readFileSync } from "node:fs";
import { loadRows, summarize } from "./local-reason-overnight.ts";

export interface GateReport {
	ok: boolean;
	rows: string[];
}

const MISS = "missing";

function sealProblems(seal: Record<string, unknown>): string[] {
	const p: string[] = [];
	for (const k of [
		"head",
		"seed",
		"script_sha",
		"prompts_sha",
		"rubric_sha",
		"review_src_sha",
		"controls",
		"ac_raw",
		"vpn_nc",
		"vpn_routes",
	]) {
		const v = seal[k];
		if (typeof v !== "string" || v.length === 0) p.push(`seal.${k} ${MISS}`);
	}
	const rounds = seal.rounds;
	if (typeof rounds !== "number" || !Number.isInteger(rounds))
		p.push(`seal.rounds not an integer`);
	else if (rounds < 10)
		p.push(`seal.rounds ${rounds} < 10 (smoke/predeclared-floor law)`);
	if (!Array.isArray(seal.tasks) || seal.tasks.length === 0)
		p.push("seal.tasks empty");
	return p;
}

/** The whole verdict: structural checks over the raw lines + a summary
 *  recompute through the same summarize() the runner printed. */
export function verifyRun(file: string): GateReport {
	const rows: string[] = [];
	const bad = (m: string): void => rows.push(m);
	if (!existsSync(file)) return { ok: false, rows: [`no such file: ${file}`] };
	const lines = readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.length > 0);
	if (lines.length === 0) return { ok: false, rows: ["empty run file"] };
	const parsed: Record<string, unknown>[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			const j = JSON.parse(lines[i] ?? "{}") as Record<string, unknown>;
			if (j === null || typeof j !== "object") throw new Error("not an object");
			parsed.push(j);
		} catch {
			bad(`line ${i + 1} does not parse as a JSON object`);
		}
	}
	const seals = parsed.filter((r) => r.type === "seal");
	if (seals.length !== 1) bad(`${seals.length} seal rows (want exactly 1)`);
	const seal = seals[0];
	if (parsed[0]?.type !== "seal") bad("first row is not the seal");
	if (seal !== undefined)
		rows.push(...sealProblems(seal).map((m) => `broken: ${m}`));
	if (seal === undefined || parsed[0]?.type !== "seal")
		return { ok: false, rows };

	const rounds =
		typeof seal.rounds === "number" && Number.isInteger(seal.rounds)
			? seal.rounds
			: 0;
	const tasks = Array.isArray(seal.tasks)
		? seal.tasks.filter((t): t is string => typeof t === "string")
		: [];

	const rounds_ = loadRows(file);
	const warm = rounds_.filter((r) => r.phase === "warm");
	const legs = [...new Set(warm.map((r) => r.leg))].sort();
	if (legs.length < 2) bad(`only ${legs.length} distinct leg(s) attempted`);
	// warmup: exactly one per leg, and a warmup row must precede nothing else
	// about that leg
	for (const leg of legs) {
		const n = rounds_.filter(
			(r) => r.phase === "warmup" && r.leg === leg,
		).length;
		if (n !== 1) bad(`leg ${leg}: ${n} warmup rows (want exactly 1)`);
	}
	// the predeclared matrix: rounds × tasks × legs, each exactly once
	const seen = new Map<string, number>();
	for (const r of warm) {
		const k = `${r.leg}|${r.round}|${r.task}`;
		seen.set(k, (seen.get(k) ?? 0) + 1);
	}
	for (let r = 1; r <= rounds; r++)
		for (const task of tasks)
			for (const leg of legs) {
				const k = `${leg}|${r}|${task}`;
				const n = seen.get(k) ?? 0;
				if (n === 0) bad(`matrix hole: ${k} never attempted`);
				else if (n > 1) bad(`matrix duplicate: ${k} attempted ${n}×`);
			}
	for (const [k, n] of seen)
		if (n > 1) bad(`matrix duplicate: ${k} attempted ${n}×`);
	// per-round evidence: identity, termination, token split — fields present
	// on every warm row, served mandatory when transport ok
	for (const r of warm) {
		const tag = `r${r.round}/${r.task}/${r.leg}`;
		if (typeof r.served !== "string" && r.served !== null)
			bad(`${tag}: no served-model evidence`);
		if (r.ok && typeof r.served !== "string")
			bad(`${tag}: transport-ok row without a served model`);
		if (r.expected === undefined) bad(`${tag}: no expected-model recorded`);
		if (typeof r.identity_mismatch !== "boolean")
			bad(`${tag}: identity_mismatch not evidenced`);
		if (!("finish" in r)) bad(`${tag}: no finish reason recorded`);
		if (!("reason_tok" in r)) bad(`${tag}: reason_tok field absent`);
		if (r.reason_tok !== null && typeof r.reason_tok !== "number")
			bad(`${tag}: reason_tok neither null nor number`);
	}
	// the end row must be what the rows say — recompute, then compare
	const ends = parsed.filter((r) => r.type === "end");
	if (ends.length !== 1) bad(`${ends.length} end rows (want exactly 1)`);
	if (ends.length === 1) {
		const want = summarize(file, legs).sort((a, b) =>
			a.leg.localeCompare(b.leg),
		);
		const got = (ends[0]?.summary as typeof want | undefined)?.sort?.((a, b) =>
			a.leg.localeCompare(b.leg),
		);
		if (!got || JSON.stringify(got) !== JSON.stringify(want))
			bad("end.summary does not recompute from the round rows");
	}
	return { ok: rows.length === 0, rows };
}

if (import.meta.main) {
	const f = process.argv[2] ?? "";
	if (f.length === 0) {
		console.error("usage: bun bench/local-reason-publish-gate.ts <run.jsonl>");
		process.exit(2);
	}
	const rep = verifyRun(f);
	for (const r of rep.rows) console.log(r);
	console.log(`publish-gate ${f}: ${rep.ok ? "PASS" : "FAIL"}`);
	process.exit(rep.ok ? 0 : 1);
}
