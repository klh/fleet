#!/usr/bin/env bun
// ext-run.ts — external known-set slice CLI (W823): seal / verify / run an
// arm over the sealed FRAMES slice / score answers (EM + optional judge).
// Arm-agnostic: --route is any OpenAI-wire chat endpoint, --ext-key-env
// names (never inlines) the env var holding its key. See arena README.
export const USAGE_EXT = `bun bench/arena/ext-run.ts <mode> [options]

modes
  --ext-verify        verify tasks-ext/ + the ext-raw chain it was sealed from
  --ext-seal-from <raw.tsv> [--ext-out <dir>]   seal a slice from a raw snapshot
                      (refuses to overwrite; verify prints after)
  --ext-run --route <base-url> --model <id> [--n k] [--ext-key-env NAME]
                      [--temperature t] [--out <file>]   run one arm over the slice
  --ext-score --answers <file.jsonl> [--n k] [--judge] [--judge-port N]
                      [--judge-limit K] [--out <md>]    score answers, print report

options
  --route             OpenAI-wire base URL, e.g. http://127.0.0.1:8903/v1
  --ext-key-env NAME  env var holding the route's bearer key (config-over-code)
  --n k               first k sealed tasks (manifest rule); default all sealed
  --judge             add the LLM-judge pass on the pinned local tier`;

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCapped, RES_DIR } from "./core.ts";
import type { ExtTask } from "./ext-seal.ts";
import { Refused } from "./runner.ts";
import { parseArgs } from "./run.ts";

export interface ArmSpec {
	route: string;
	model: string;
	key: string;
	temperature: number;
}
export const ARM_SYSTEM =
	"Answer the question. Reply with only the final answer, no reasoning or preamble.";

export async function callArm(spec: ArmSpec, prompt: string): Promise<string> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 300e3);
	try {
		const res = await fetch(`${spec.route}/chat/completions`, {
			method: "POST",
			signal: ac.signal,
			headers: {
				"content-type": "application/json",
				...(spec.key ? { authorization: `Bearer ${spec.key}` } : {}),
			},
			body: JSON.stringify({
				model: spec.model,
				messages: [
					{ role: "system", content: ARM_SYSTEM },
					{ role: "user", content: prompt },
				],
				temperature: spec.temperature,
				max_tokens: 2048,
				stream: false,
			}),
		});
		const body = await readCapped(res.body, 4 * 1024 * 1024);
		if (!res.ok) throw new Error(`arm ${res.status}: ${body.slice(0, 160)}`);
		const j = JSON.parse(body) as {
			choices?: { message?: { content?: string } }[];
		};
		return String(j.choices?.[0]?.message?.content ?? "");
	} finally {
		clearTimeout(timer);
	}
}

export async function extRunArm(o: {
	spec: ArmSpec;
	tasks: ExtTask[];
	out: string;
	log?: (s: string) => void;
}): Promise<number> {
	const log = o.log ?? ((s: string) => console.error(s));
	mkdirSync(dirname(o.out), { recursive: true });
	const put = (x: unknown) => appendFileSync(o.out, `${JSON.stringify(x)}\n`);
	let ok = 0;
	for (const t of o.tasks) {
		const t0 = performance.now();
		try {
			const answer = await callArm(o.spec, t.prompt);
			put({
				type: "answer",
				id: t.id,
				answer,
				wall_ms: Math.round(performance.now() - t0),
				model: o.spec.model,
				route: o.spec.route,
			});
			ok++;
		} catch (e) {
			put({
				type: "answer",
				id: t.id,
				error: String(e instanceof Error ? e.message : e).slice(0, 200),
				wall_ms: Math.round(performance.now() - t0),
			});
		}
		log(`ext ${t.id} ok=${ok}`);
	}
	return ok;
}

import { resolve } from "node:path";
import { EXT_TASK_DIR, extSealFrom, loadExt, verifyExt } from "./ext-seal.ts";

export function extVerifyCmd(): number {
	const v = verifyExt();
	console.log(
		[...v.rows, `manifest ${v.hash} ${v.ok ? "PASS" : "FAIL"}`].join("\n"),
	);
	return v.ok ? 0 : 1;
}
export function extSealCmd(rawPath: string, outDir?: string): number {
	extSealFrom(resolve(rawPath), outDir ? resolve(outDir) : EXT_TASK_DIR);
	const v = verifyExt(outDir ? resolve(outDir) : EXT_TASK_DIR);
	console.log(
		[...v.rows, `manifest ${v.hash} ${v.ok ? "PASS" : "FAIL"}`].join("\n"),
	);
	return v.ok ? 0 : 1;
}

import {
	extReport,
	extRows,
	judgeRunExt,
	mergeJudge,
	scoreSlice,
} from "./ext-score.ts";

export async function extScoreCmd(o: {
	answers: string;
	n?: number;
	judge: boolean;
	port?: number;
	limit?: number;
	out?: string;
}): Promise<number> {
	const tasks = loadExt().tasks.slice(0, o.n ?? 48);
	const f = resolve(o.answers);
	const { answers } = await extRows(f);
	const rows = scoreSlice(tasks, answers);
	if (o.judge)
		await judgeRunExt({ file: f, tasks, port: o.port, limit: o.limit });
	const rows2 = await mergeJudge(rows, f);
	const md = extReport(rows2, f);
	console.log(md);
	if (o.out) writeFileSync(resolve(o.out), `${md}\n`);
	return 0;
}

type Args = Record<string, string | boolean>;
const str = (a: Args, k: string) =>
	typeof a[k] === "string" ? (a[k] as string) : undefined;

async function extRunCmd(a: Args): Promise<number> {
	const route = str(a, "route");
	const model = str(a, "model");
	if (!route || !model)
		throw new Refused("--ext-run needs --route <base-url> --model <id>");
	const tasks = loadExt().tasks.slice(0, Number(str(a, "n") ?? 48));
	const keyEnv = str(a, "ext-key-env");
	const key = keyEnv ? (process.env[keyEnv] ?? "") : "";
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const out = join(RES_DIR, `ext-${ts}-${model.replace(/\W+/g, "-")}.jsonl`);
	const spec: ArmSpec = {
		route,
		model,
		key,
		temperature: Number(str(a, "temperature") ?? 0),
	};
	const okN = await extRunArm({ spec, tasks, out, log: console.error });
	console.log(`answers → ${out} (${okN}/${tasks.length} ok)`);
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	const a = parseArgs(argv);
	if (a["ext-verify"]) return extVerifyCmd();
	const src = str(a, "ext-seal-from");
	if (src) return extSealCmd(src, str(a, "ext-out"));
	if (a["ext-run"]) return extRunCmd(a);
	if (a["ext-score"]) {
		const ans = str(a, "answers");
		if (!ans) throw new Refused("--ext-score needs --answers <file>");
		return extScoreCmd({
			answers: ans,
			n: Number(str(a, "n") ?? 0) || undefined,
			judge: !!a.judge,
			port: Number(str(a, "judge-port") ?? 0) || undefined,
			limit: Number(str(a, "judge-limit") ?? 0) || undefined,
		});
	}
	console.log(USAGE_EXT);
	return 0;
}
if (import.meta.main) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = e instanceof Refused ? e.code : 1;
	}
}
