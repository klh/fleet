// local-reason-publish-gate.test.ts — the gate is law: a run jsonl publishes
// a benchmarks.md row only when verifyRun says so.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "./local-reason-overnight.ts";
import { verifyRun } from "./local-reason-publish-gate.ts";

const row = (
	leg: string,
	round: number,
	task: string,
	over: Record<string, unknown> = {},
): Record<string, unknown> => ({
	type: "round",
	run: "t1",
	round,
	task,
	leg,
	phase: "warm",
	ok: true,
	pass: true,
	fail_kind: null,
	identity_mismatch: false,
	served: "m",
	expected: "m",
	wall_ms: 100,
	ttft_ms: 5,
	in_tok: 10,
	out_tok: 10,
	reason_tok: 5,
	reason_chars: 20,
	tok_est: false,
	finish: "stop",
	cost_usd: 0.01,
	priced: "remote",
	load1: 1,
	nonce: "n",
	out_file: "f",
	...over,
});

const seal = (): Record<string, unknown> => ({
	type: "seal",
	at: "t",
	run: "t1",
	rounds: 10,
	tasks: ["code", "review"],
	seed: "t1",
	head: "h",
	script_sha: "s",
	review_src_sha: "r",
	rubric_sha: "ru",
	prompts_sha: "p",
	controls: "c",
	ac_raw: "AC Power",
	vpn_nc: "n",
	vpn_routes: "r",
});

const write = (file: string, ls: unknown[]): void => {
	writeFileSync(file, `${ls.map((l) => JSON.stringify(l)).join("\n")}\n`);
};

/** Seal + warmup per leg + full 10×2×2 matrix + end row (summary recomputed). */
const validRun = (file: string): void => {
	const legs = ["a", "b"];
	const lines: Record<string, unknown>[] = [seal()];
	for (const leg of legs)
		lines.push(
			row(leg, 0, "code", {
				phase: "warmup",
				pass: false,
				fail_kind: "truncated",
				finish: "length",
			}),
		);
	for (let r = 1; r <= 10; r++)
		for (const task of ["code", "review"])
			for (const leg of legs) lines.push(row(leg, r, task));
	write(file, lines);
	lines.push({
		type: "end",
		at: "t",
		summary: summarize(file, legs),
	});
	write(file, lines);
};

test.describe("verifyRun", () => {
	test("a complete sealed run passes @unit", () => {
		const dir = mkdtempSync(join(tmpdir(), "w532-gate-"));
		const file = join(dir, "run.jsonl");
		validRun(file);
		const rep = verifyRun(file);
		rmSync(dir, { recursive: true, force: true });
		expect(rep).toEqual({ ok: true, rows: [] });
	});

	test("mutations each name what broke @unit", () => {
		const cases: [string, (ls: Record<string, unknown>[]) => void][] = [
			["no seal", (ls) => void ls.splice(0, 1)],
			[
				"sub-floor rounds",
				(ls) => {
					const s = ls[0] as Record<string, unknown>;
					s.rounds = 1;
				},
			],
			["matrix hole", (ls) => void ls.splice(3, 1)],
			[
				"ok row without served",
				(ls) => {
					const r = ls[3] as Record<string, unknown>;
					r.served = null;
				},
			],
			[
				"reason_tok string",
				(ls) => {
					const r = ls[3] as Record<string, unknown>;
					r.reason_tok = "5";
				},
			],
			[
				"tampered summary",
				(ls) =>
					void ls.push({
						type: "end",
						at: "t",
						summary: [{ leg: "a", attempted: 99 }],
					}),
			],
		];
		for (const [label, mutate] of cases) {
			const dir = mkdtempSync(join(tmpdir(), "w532-gate-"));
			const file = join(dir, "run.jsonl");
			const base = (): Record<string, unknown>[] => {
				const legs = ["a", "b"];
				const lines: Record<string, unknown>[] = [seal()];
				for (const leg of legs)
					lines.push(
						row(leg, 0, "code", {
							phase: "warmup",
							pass: false,
							fail_kind: "truncated",
							finish: "length",
						}),
					);
				for (let r = 1; r <= 10; r++)
					for (const task of ["code", "review"])
						for (const leg of legs) lines.push(row(leg, r, task));
				return lines;
			};
			const lines = base();
			mutate(lines);
			if (label !== "tampered summary")
				lines.push({
					type: "end",
					at: "t",
					summary: summarize(file, ["a", "b"]),
				});
			write(file, lines);
			const rep = verifyRun(file);
			rmSync(dir, { recursive: true, force: true });
			expect(rep.ok, `${label}: ${rep.rows.join("; ")}`).toBe(false);
		}
	});
});
