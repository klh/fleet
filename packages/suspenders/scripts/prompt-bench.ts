#!/usr/bin/env bun
// prompt-bench.ts — W368: bench the local swarm on prompt transforms.
// Per-model legs on the :890x direct wire (the path resolveEnhanceTarget
// takes), a :4000 router leg (stack path, _routing-attributed), and the
// deterministic blam caveman condenser as the compress baseline — all
// nonce-cold, scored by the deterministic scorer, raw legs as NDJSON.
//
//   bun scripts/prompt-bench.ts [--n 130] [--seed 20261016]
//       [--router on|off] [--timeout <ms>] [--out-dir <dir>]
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
	callDirect,
	callRouter,
	COMPRESS_SYS,
	PROD_ENHANCE_SYS,
	type LegResult,
} from "./lib/prompt-bench-client.ts";
import { condensePrompt } from "../hooks/board/prompt-transform.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const N = Number(arg("n") ?? 130);
const SEED = Number(arg("seed") ?? 20261016);
const ROUTER = (arg("router") ?? "on") !== "off";
const TIMEOUT = Number(arg("timeout") ?? 90_000);
const OUT_DIR = resolve(arg("out-dir") ?? join(process.cwd(), ".fleet", "prompt-bench"));

const ALIASES = ["local-coder", "local-extract", "local-reason"] as const;
const ROUTER_URL = "http://127.0.0.1:4000/v1/messages";

interface Specialist {
	alias: string;
	port: number;
	base: string;
	id: string;
}

/** resolveEnhanceTarget's own recipe: the emitted direct-tiers map, live
 *  /v1/models probe for the wire id (the alias is never the wire id). */
async function resolveSpecialists(): Promise<Specialist[]> {
	const home = process.env.SUSPENDERS_HOME ?? process.env.HOME;
	const doc = JSON.parse(
		readFileSync(`${home}/.claude/local-llm/direct-tiers.json`, "utf8"),
	) as Record<string, string>;
	const out: Specialist[] = [];
	for (const alias of ALIASES) {
		const base = doc[alias];
		if (typeof base !== "string") continue;
		try {
			const r = await fetch(`${base.replace(/\/$/, "")}/models`, {
				signal: AbortSignal.timeout(3000),
			});
			if (!r.ok) continue;
			const j = (await r.json()) as { data?: { id?: string }[] };
			const id = j.data?.[0]?.id;
			if (!id) continue;
			const port = Number(new URL(base).port);
			out.push({ alias, port, base: base.replace(/\/$/, ""), id });
		} catch {
			// specialist down → no lane
		}
	}
	return out;
}

const nonce = (): string =>
	Math.random().toString(36).slice(2, 10);

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

const appendRecord = (
	file: string,
	rec: Omit<BenchRecord, "ts" | "suite">,
): void => {
	appendFileSync(
		file,
		`${JSON.stringify({ ts: Date.now(), suite: "prompt-transform", ...rec })}\n`,
	);
};

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
	const specialists = await resolveSpecialists();
	if (specialists.length === 0) {
		console.log("no live specialist resolved — nothing to bench");
		process.exit(4);
	}
	mkdirSync(OUT_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const ndjson = join(OUT_DIR, `prompt-transform-${stamp}.ndjson`);
	const corpus = buildCorpus(N, SEED);
	console.log(
		`W368 prompt-transform bench: n=${N} seed=${SEED} models=${specialists.map((s) => `${s.alias}→:${s.port}`).join(",")} router=${ROUTER ? "on" : "off"} ndjson=${ndjson}`,
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
				const sys =
					transform === "compress" ? COMPRESS_SYS : PROD_ENHANCE_SYS;
				const res: LegResult = await callDirect({
					base: sp.base,
					model: sp.id,
					system: sys,
					user,
					nonce: nonce(),
					timeoutMs: TIMEOUT,
				});
				const sc = transform === "compress"
					? scoreCompress(s, res.text)
					: scoreEnhance(s, res.text);
				push({
					run: stamp,
					transform,
					target: sp.id,
					alias: sp.alias,
					port: sp.port,
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

	const runRouterLane = async (): Promise<void> => {
		if (!ROUTER) return;
		for (const s of corpus) {
			const res = await callRouter({
				url: ROUTER_URL,
				system: PROD_ENHANCE_SYS,
				user: s.terse,
				nonce: nonce(),
				timeoutMs: TIMEOUT,
			});
			const sc = scoreEnhance(s, res.text);
			push({
				run: stamp,
				transform: "enhance",
				target: res.servedPort ? `router:${res.servedPort}` : "router",
				alias: "router",
				port: res.servedPort,
				seedId: s.id,
				ok: res.ok,
				wallMs: res.wallMs,
				score: res.ok ? sc.score : null,
				retention: res.ok ? sc.retention : null,
				ratio: res.ok ? sc.ratio : null,
				additions: res.ok ? sc.additions : null,
				note: res.note,
			});
		}
	};

	await Promise.all(specialists.map(runModelLane));
	console.log("direct lanes done");
	await runRouterLane();
	console.log("router lane done");

	// summary → stdout + curated raw rows into the belt store
	console.log(`\n== summary (run ${stamp}) ==`);
	const rows: string[] = [];
	const emit = (target: string, transform: string, s: ReturnType<typeof summarize>, extra: string): void => {
		if (!s) {
			console.log(`${target} ${transform}: no usable legs`);
			return;
		}
		const line = `${target} ${transform}: n=${s.n} scoreMean=${s.scoreMean.toFixed(1)} retP50=${s.retP50.toFixed(3)} ratioP50=${s.ratioP50.toFixed(3)} addP50=${s.addP50} wallP50=${Math.round(s.wallP50)}ms ${extra}`;
		console.log(line);
		rows.push(line);
	};
	emit("blam-caveman", "compress", summarize(all.filter((r) => r.target === "blam-caveman")), "(deterministic)");
	for (const sp of specialists) {
		for (const tr of ["compress", "enhance"] as const) {
			emit(
				sp.id,
				tr,
				summarize(all.filter((r) => r.target === sp.id && r.transform === tr)),
				`(${sp.alias} :${sp.port})`,
			);
		}
	}
	const byServed = new Map<number, BenchRecord[]>();
	for (const r of all.filter((x) => x.alias === "router"))
		byServed.set(r.port ?? -1, [...(byServed.get(r.port ?? -1) ?? []), r]);
	for (const [port, rs] of byServed)
		emit(`router:${port}`, "enhance", summarize(rs), "(via :4000)");

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
	if (all.length > 0 && all.every((r) => !r.ok))
		process.exit(4);
}

if (import.meta.main) await main();
