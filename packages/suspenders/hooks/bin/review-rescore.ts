#!/usr/bin/env bun
// hooks/bin/review-rescore.ts — W1476 (b) CLI face over hooks/lib/fleet-loop/
// review-rescore.ts (the logic): a reviewer prompt, model or tooling change
// reruns the review arena on the whole sealed set and banks the score delta.
//   check [--repo <dir>]  the hourly fleet-loop heartbeat (W779 registry):
//                         one line; due arms on AC → `run` launched detached;
//                         SUSPENDERS_REVIEW_RESCORE=0 idles it
//   run [--repo <dir>] [--reason <text>] [--force]
//                         rescore now (AC-gated); exits 1 when an arm did not
//                         score or the lane key was not minted or revoked
import { rescoreCheck, rescoreRun } from "../lib/fleet-loop/review-rescore.ts";
import { defineVerb, type Parsed, runCli } from "../lib/verb-kit.ts";

const repoOf = (p: Parsed): string => p.flag("--repo") ?? process.cwd();

const VERBS = [
	defineVerb({
		name: "check",
		usage:
			"usage: review-rescore check [--repo <dir>] — due arms on AC → a detached run",
		flags: ["--repo"],
		run: async (p) => {
			console.log(await rescoreCheck({ repo: repoOf(p) }));
			return 0;
		},
	}),
	defineVerb({
		name: "run",
		usage:
			"usage: review-rescore run [--repo <dir>] [--reason <text>] [--force] — rescore the due arms now",
		flags: ["--repo", "--reason"],
		switches: ["--force"],
		run: async (p) => {
			const r = await rescoreRun({
				repo: repoOf(p),
				reason: p.flag("--reason") ?? undefined,
				force: p.flag("--force") === "true",
			});
			const print = r.ok ? console.log : console.error;
			for (const line of r.lines) print(line);
			return r.ok ? 0 : 1;
		},
	}),
];

if (import.meta.main) {
	try {
		await runCli({
			prog: "review-rescore",
			about:
				"review-rescore — W1476 reviewer changes rescored against the whole review-arena set.",
			verbs: VERBS,
		});
	} catch (e) {
		console.error(
			`review-rescore: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	}
}
