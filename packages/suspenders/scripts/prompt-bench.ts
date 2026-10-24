#!/usr/bin/env bun
// prompt-bench.ts — W368: bench the swarm on prompt transforms.
// Per-model legs ride the buckle gate (W1119.2 single-buckle-inference:
// model-as-data, the gate owns placement), plus the deterministic blam
// caveman condenser as the compress baseline — all
// nonce-cold, scored by the deterministic scorer, raw legs as NDJSON.
//
//   bun scripts/prompt-bench.ts [--n 130] [--seed 20261016]
//       [--timeout <ms>] [--out-dir <dir>]
//
// Exit: 0 = ran, 4 = every leg failed.
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCorpus } from "./lib/prompt-bench-corpus.ts";
import {
	scoreCompress,
	scoreEnhance,
	median,
} from "./lib/prompt-bench-score.ts";
import {
	callGate,
	COMPRESS_SYS,
	PROD_ENHANCE_SYS,
	type LegResult,
} from "./lib/prompt-bench-client.ts";
import { condensePrompt } from "../hooks/board/prompt-transform.ts";
import { parseDirectTiersArtifact } from "../../belt/bin/router-policy.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const N = Number(arg("n") ?? 130);
const SEED = Number(arg("seed") ?? 20261016);
const TIMEOUT = Number(arg("timeout") ?? 90_000);
const OUT_DIR = resolve(
	arg("out-dir") ?? join(process.cwd(), ".fleet", "prompt-bench"),
);

const ALIASES = ["local-coder", "local-extract", "local-reason"] as const;

interface Specialist {
	alias: string;
}

/** The bench lanes: aliases present in the emitted direct-tiers catalog
 *  (the W726 map). The gate owns placement (model-as-data); a down rung
 *  fails its legs honestly (a failed leg is data). */
function resolveSpecialists(): Specialist[] {
	const doc =
		parseDirectTiersArtifact(
			readFileSync(
				`${process.env.SUSPENDERS_HOME ?? process.env.HOME}/.claude/local-llm/direct-tiers.json`,
				"utf8",
			),
		) ?? {};
	return ALIASES.filter((a) => typeof doc[a] === "string").map((alias) => ({
		alias,
	}));
}

const nonce = (): string => Math.random().toString(36).slice(2, 10);

export interface BenchRecord {
	ts: number;
	suite: "prompt-transform";
	run: string;
	transform: "compress" | "enhance";
	target: string;
	alias: string;
	port: number | null;
	seedId: string;
	ok: boolean;
	wallMs: number;
	score: number | null;
	retention: number | null;
	ratio: number | null;
	additions: number | null;
	note: string;
	warmup?: boolean;
}

const summarize = (
	rows: BenchRecord[],
): {
	n: number;
	scoreMean: number;
	retP50: number;
	ratioP50: number;
	addP50: number;
	wallP50: number;
} | null => {
	const good = rows.filter((r) => r.ok && !r.warmup);
	if (good.length === 0) return null;
	const mean = (xs: number[]): number =>
		xs.reduce((a, b) => a + b, 0) / xs.length;
	return {
		n: good.length,
		scoreMean: mean(good.map((r) => r.score as number)),
		retP50: median(good.map((r) => r.retention as number)),
		ratioP50: median(good.map((r) => r.ratio as number)),
		addP50: median(good.map((r) => r.additions as number)),
		wallP50: median(good.map((r) => r.wallMs as number)),
	};
};

async function main(): Promise<void> {
	const specialists = resolveSpecialists();
	if (specialists.length === 0) {
		console.log("no live specialist resolved — nothing to bench");
		process.exit(4);
	}
	mkdirSync(OUT_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const ndjson = join(OUT_DIR, `prompt-transform-${stamp}.ndjson`);
	const corpus = buildCorpus(N, SEED);
	console.log(
		`W368 prompt-transform bench: n=${N} seed=${SEED} models=${specialists.map((s) => s.alias).join(",")} ndjson=${ndjson}`,
	);
	const all: BenchRecord[] = [];
	const push = (rec: Omit<BenchRecord, "ts" | "suite">): BenchRecord => {
		const full = { ts: Date.now(), suite: "prompt-transform" as const, ...rec };
		appendFileSync(ndjson, `${JSON.stringify(full)}\n`);
		all.push(full);
		return full;
	};

	// deterministic blam caveman baseline (zero-model legs, same scorer)
	for (const s of corpus) {
		const out = condensePrompt(s.verbose);
		const sc = scoreCompress(s, out);
		push({
			run: stamp,
			transform: "compress",
			target: "blam-caveman",
			alias: "blam-caveman",
			port: null,
			seedId: s.id,
			ok: true,
			wallMs: 0,
			score: sc.score,
			retention: sc.retention,
			ratio: sc.ratio,
			additions: sc.additions,
			note: "deterministic",
		});
	}
	console.log("blam-caveman baseline done");

	const runModelLane = async (sp: Specialist): Promise<void> => {
		let first = true;
		for (const transform of ["compress", "enhance"] as const) {
			for (const s of corpus) {
				const user = transform === "compress" ? s.verbose : s.terse;
				const sys = transform === "compress" ? COMPRESS_SYS : PROD_ENHANCE_SYS;
				const res: LegResult = await callGate(
					{
						model: sp.alias,
						system: sys,
						user,
						nonce: nonce(),
						timeoutMs: TIMEOUT,
					},
					process.env,
				);
				const sc =
					transform === "compress"
						? scoreCompress(s, res.text)
						: scoreEnhance(s, res.text);
				push({
					run: stamp,
					transform,
					target: sp.alias,
					alias: sp.alias,
					port: null,
					seedId: s.id,
					ok: res.ok,
					wallMs: res.wallMs,
					score: res.ok ? sc.score : null,
					retention: res.ok ? sc.retention : null,
					ratio: res.ok ? sc.ratio : null,
					additions: res.ok ? sc.additions : null,
					note: res.note,
					warmup: first,
				});
				first = false;
			}
		}
	};

	await Promise.all(specialists.map(runModelLane));
	console.log("gate lanes done");

	// summary → stdout + curated raw rows into the belt store
	console.log(`\n== summary (run ${stamp}) ==`);
	const rows: string[] = [];
	const emit = (
		target: string,
		transform: string,
		s: ReturnType<typeof summarize>,
		extra: string,
	): void => {
		if (!s) {
			console.log(`${target} ${transform}: no usable legs`);
			return;
		}
		const line = `${target} ${transform}: n=${s.n} scoreMean=${s.scoreMean.toFixed(1)} retP50=${s.retP50.toFixed(3)} ratioP50=${s.ratioP50.toFixed(3)} addP50=${s.addP50} wallP50=${Math.round(s.wallP50)}ms ${extra}`;
		console.log(line);
		rows.push(line);
	};
	emit(
		"blam-caveman",
		"compress",
		summarize(all.filter((r) => r.target === "blam-caveman")),
		"(deterministic)",
	);
	for (const sp of specialists) {
		for (const tr of ["compress", "enhance"] as const) {
			emit(
				sp.alias,
				tr,
				summarize(
					all.filter((r) => r.target === sp.alias && r.transform === tr),
				),
				"(gated)",
			);
		}
	}

	const store = resolve(
		join(process.cwd(), "..", "belt", "bench", "benchmarks.jsonl"),
	);
	const head = {
		ts: new Date().toISOString(),
		suite: "prompt-transform",
		model: "run-manifest",
		metric: "manifest",
		value: all.filter((r) => r.ok).length,
		meta: {
			run: stamp,
			n: N,
			seed: SEED,
			power: "AC",
			nonce_cold: true,
			warmup: "first leg per model discarded",
			scorer: "retention5/6+kw1/6 · no-add · secondary",
			notes: rows.join(" | "),
		},
	};
	appendFileSync(store, `${JSON.stringify(head)}\n`);
	console.log(`manifest row appended to ${store}`);
	if (all.length > 0 && all.every((r) => !r.ok)) process.exit(4);
}

if (import.meta.main) await main();
