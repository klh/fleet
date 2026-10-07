#!/usr/bin/env bun
// local-reason-overnight.ts — W532 sealed re-bench: the local :8903 reasoner
// vs z.ai flash vs z.ai frontier glm-5.3, with the acceptance controls the
// 2026-10-07 overnight run lacked (lesson.bench-zai-thinking-ceiling):
//   preflight  AC power · corp-VPN-off evidence · engine key · ensureUp(:8903)
//              · per-leg ping with a served-identity assert
//   seal       sha256 over prompts/config/rubric/review-source/script/head,
//              written before round 1 — later changes are detectable
//   rounds     N>=10 per (task, leg); seeded shuffled leg+task order (paired);
//              one attempt per round, no retries — failed rounds stay in the
//              denominator (fail_kind: transport|identity|truncated|empty|tests)
//   grading    code = extracted blocks executed under `bun test` (objective);
//              review = frozen rubric applied blind (anon copies + sealed key)
// usage:
//   bun bench/local-reason-overnight.ts --rounds 10 [--smoke] [--tasks code,review] [--run-id <id>]
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SPECIALISTS } from "../bin/registry.ts";
import { ensureUp } from "../bin/spawner.ts";
import { LOCAL_MODEL, pad, rng, sha, shuffle } from "./arena/core.ts";
import {
	callLeg,
	costOf,
	LEGS,
	type Leg,
	load1,
	nonceOf,
	type Out,
	ping,
} from "./arena/legs.ts";

const OUT_DIR = join(import.meta.dir, "arena/results/local-reason-w532");
const RUBRIC_PATH = join(import.meta.dir, "local-reason-rubric.md");
const LOCAL_PORT = 8903;
const LOCAL_EXPECT = LOCAL_MODEL[LOCAL_PORT];
const LEG_IDS = [
	"local-direct",
	"stack-engine-zai",
	"stack-engine-zai-frontier",
] as const;
type LegId = (typeof LEG_IDS)[number];
const LEG_LABEL: Record<LegId, string> = {
	"local-direct": "local:8903",
	"stack-engine-zai": "zai-flash",
	"stack-engine-zai-frontier": "zai-frontier",
};
type TaskName = "code" | "review";
/** Ceiling-aware budgets: local is bounded by its own context reality; the
 * z.ai legs sit at the provider's real ceiling (measured 2026-10-07: the API
 * rejects >131072 — max_tokens is NOT clamped, it 400s) so a thinking model
 * never truncates mid-thought; the finish gate rejects `length` regardless. */
const maxTokensFor = (legId: string): number =>
	legId === "local-direct" ? 32_768 : 131_072;
const TASK_TIMEOUT: Record<TaskName, number> = {
	code: 600_000,
	review: 900_000,
};
const laneLivenessPath = new URL(
	"../../suspenders/hooks/lib/lane-liveness.ts",
	import.meta.url,
).pathname;

/** The two sealed task prompts (v2: the code task pins the import contract
 * and block order so grading can execute the extract mechanically). */
export function buildPrompts(livenessSrc: string): Record<TaskName, string> {
	return {
		code: `Implement in TypeScript (strict, no deps): parseDuration(s: string): number | null —
accepts compositions like "1h30m", "45s", "2d", "1h 30m", "90m" (units d/h/m/s, case-insensitive,
whitespace-tolerant, order flexible within one string). Returns total seconds, or null on any
malformed input (empty, unknown unit, negative, garbage). Then write bun tests covering: the happy
paths above, "1h30m" == 5400, malformed cases, and a composition with repeated units summing.
Output ONLY two fenced blocks: first the implementation, then the tests. The tests file must be
self-contained and import the implementation exactly like: import { parseDuration } from "./impl.ts".`,
		review: `Review this TypeScript module critically — it is a lane-liveness oracle in an agent
fleet (three consumers share it). Look for: correctness bugs, false-positive/false-negative
liveness paths, performance traps (it runs every dispatch cycle), and API sharp edges. Be specific:
quote the line, name the failure mode, propose the fix. Do NOT pad — if the module is solid, say
where its limits are instead. Output: a numbered findings list, each with severity (high/med/low).

\`\`\`typescript
${livenessSrc.slice(0, 9000)}
\`\`\``,
	};
}

/** Sealed run configuration — hashed into the seal row before round 1. */
export interface BenchConfig {
	run: string;
	seed: string;
	rounds: number;
	tasks: TaskName[];
}

// --------------------------------------------------------------- round gate
export type FailKind =
	| null
	| "transport"
	| "identity"
	| "truncated"
	| "empty"
	| "tests";
export interface CodeGrade {
	ok: boolean;
	tail: string;
}
export interface RoundVerdict {
	ok: boolean; // transport-level (HTTP + no error event)
	pass: boolean; // the acceptance gate (ok && identity && finish && text && tests)
	failKind: FailKind;
	identity: boolean; // served-model mismatch flag (voids the round either way)
}
/** The acceptance gate. Precedence: transport → identity → truncated →
 * empty → tests. Unknown served id counts as a mismatch (never assume). */
export function classify(
	o: Out,
	expected: string | null,
	grade: CodeGrade | null,
): RoundVerdict {
	const identity = o.ok && expected !== null && (o.served ?? null) !== expected;
	const failKind: FailKind = !o.ok
		? "transport"
		: identity
			? "identity"
			: o.finish === "length"
				? "truncated"
				: o.text.length === 0
					? "empty"
					: grade && !grade.ok
						? "tests"
						: null;
	return {
		ok: o.ok,
		pass: failKind === null,
		failKind,
		identity,
	};
}

// --------------------------------------------------------------- code grading
/** Pull the two fenced blocks (implementation, tests) out of an answer.
 * Tolerant of language tags and stray prose around the blocks. */
export function extractBlocks(text: string): [string, string] | null {
	const fences = text.match(/```[a-z]*\n([\s\S]*?)```/g);
	if (!fences || fences.length < 2) return null;
	const impl = (fences[0].match(/```[a-z]*\n([\s\S]*?)```/) ?? [])[1];
	const tests = (fences[1].match(/```[a-z]*\n([\s\S]*?)```/) ?? [])[1];
	if (!impl || !tests) return null;
	return [impl.replace(/\n$/, ""), tests.replace(/\n$/, "")];
}

const W532_TMP = () => join("/tmp", "w532-bench");
/** Execute the extracted impl+tests under `bun test` (timeout-guarded). */
export function gradeCode(text: string, run: string, tag: string): CodeGrade {
	const blocks = extractBlocks(text);
	if (!blocks) return { ok: false, tail: "no two fenced blocks found" };
	const dir = join(W532_TMP(), run, tag);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "impl.ts"), blocks[0]);
	writeFileSync(join(dir, "impl.test.ts"), blocks[1]);
	const p = Bun.spawnSync(["bun", "test", "impl.test.ts"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 120_000,
	});
	const out = `${p.stdout.toString()}\n${p.stderr.toString()}`;
	const ok = p.exitCode === 0;
	return {
		ok,
		tail: (ok ? out : out.slice(-600))
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 500),
	};
}

// --------------------------------------------------------------- preflight
/** AC-power gate (benchmarks.md law: AC only). */
export function acPower(): { ok: boolean; raw: string } {
	const raw = Bun.spawnSync(["pmset", "-g", "ps"]).stdout.toString().trim();
	return { ok: raw.includes("AC Power"), raw };
}
/** Corp-VPN-off evidence: no connected VPN service + no split-tunnel default
 * override (0/1 + 128.0/0 routes are the full-tunnel signature). */
export function vpnEvidence(): {
	ok: boolean;
	nc: string;
	routes: string;
} {
	const nc = Bun.spawnSync(["scutil", "--nc", "list"]).stdout.toString().trim();
	const rn = Bun.spawnSync(["netstat", "-rn", "-f", "inet"])
		.stdout.toString()
		.split("\n");
	const tunnel = rn.filter((l) => /^(0\/1|128\.0\/0)\s/.test(l));
	const connected = nc
		.split("\n")
		.filter((l) => /\(Connected\)/.test(l) && !/\(Connected\s*=/.test(l));
	return {
		ok: connected.length === 0 && tunnel.length === 0,
		nc,
		routes: tunnel.join("\n") || "(no split-tunnel default override)",
	};
}
/** Read the :4100 engine key (config-over-code: PATH only in repo, value on
 * the machine). Returns it; never printed. */
export function engineKeyFromFile(): string | null {
	const p = join(process.env.HOME ?? "", ".claude/local-llm/litellm.key");
	const t = Bun.spawnSync(["cat", p], { stdout: "pipe", stderr: "pipe" });
	if (t.exitCode !== 0) return null;
	const k = t.stdout.toString().trim();
	return k.length > 0 ? k : null;
}

// --------------------------------------------------------------- medians
export function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2
		? (s[mid] as number)
		: ((s[(mid - 1) as number] as number) + (s[mid] as number)) / 2;
}

// --------------------------------------------------------------- rows
export interface RoundRow {
	type: "round";
	run: string;
	round: number;
	task: TaskName;
	leg: string;
	phase: "warmup" | "warm";
	ok: boolean;
	pass: boolean;
	fail_kind: FailKind;
	identity_mismatch: boolean;
	served: string | null;
	expected: string | null;
	wall_ms: number;
	ttft_ms: number | null;
	in_tok: number;
	out_tok: number;
	reason_tok: number;
	reason_chars: number;
	tok_est: boolean;
	finish: string | null;
	cost_usd: number;
	priced: string;
	load1: number;
	nonce: string;
	out_file: string;
	test_tail?: string;
	err?: string;
}

const put = (file: string, x: unknown) =>
	appendFileSync(file, `${JSON.stringify(x)}\n`);

export function rowOf(
	run: string,
	round: number,
	task: TaskName,
	leg: Leg,
	phase: "warmup" | "warm",
	o: Out,
	v: RoundVerdict,
	grade: CodeGrade | null,
	outFile: string,
): RoundRow {
	const c = costOf(leg, o);
	const local = leg.priced === "local";
	return {
		type: "round",
		run,
		round,
		task,
		leg: leg.id,
		phase,
		ok: v.ok,
		pass: v.pass,
		fail_kind: v.failKind,
		identity_mismatch: v.identity,
		served: o.served ?? null,
		expected: leg.servedExpect?.(LOCAL_PORT) ?? null,
		wall_ms: Math.round(o.wall),
		ttft_ms: o.ttft === null ? null : Math.round(o.ttft),
		in_tok: o.inTok,
		out_tok: o.outTok,
		reason_tok: o.reasonTok,
		reason_chars: o.reasoningChars,
		tok_est: o.tokEst,
		finish: o.finish,
		cost_usd: local ? 0 : c.usd,
		priced: local ? "electricity" : c.priced,
		load1: load1(),
		nonce: nonceOf(run, leg.id, task, phase),
		out_file: outFile,
		test_tail: grade?.tail,
		err: o.err,
	};
}

// --------------------------------------------------------------- ordering
const w532Rng = (seed: string, ns: string) => rng(`w532|${seed}|${ns}`);
/** Randomized paired ordering: every (round, task) runs ALL legs; the leg
 * order is seeded-shuffled per pair, and the task order per round. Same seed
 * → same orders; the seed is sealed, so the ordering is auditable. */
export function roundPlan(
	seed: string,
	round: number,
	tasks: TaskName[],
	legs: Leg[],
): { task: TaskName; order: Leg[] }[] {
	const taskOrder = shuffle(w532Rng(seed, `round|${round}`), tasks);
	return taskOrder.map((task) => ({
		task,
		order: shuffle(w532Rng(seed, `legs|${round}|${task}`), legs),
	}));
}

// --------------------------------------------------------------- run types
export interface RunContext {
	run: string;
	rounds: number;
	tasks: TaskName[];
	legs: Leg[];
	prompts: Record<TaskName, string>;
	seed: string;
	head: string;
	file: string;
}

export interface Preflight {
	ac: { ok: boolean; raw: string };
	vpn: { ok: boolean; nc: string; routes: string };
}

export const sealRow = (
	ctx: RunContext,
	rubricSha: string,
	reviewSrcSha: string,
	promptSha: string,
	scriptSrc: string,
	pre: Preflight,
): Record<string, unknown> => ({
	type: "seal",
	at: new Date().toISOString(),
	run: ctx.run,
	rounds: ctx.rounds,
	tasks: ctx.tasks,
	seed: ctx.seed,
	head: ctx.head,
	script_sha: sha(scriptSrc),
	review_src_sha: reviewSrcSha,
	rubric_sha: rubricSha,
	prompts_sha: promptSha,
	ac_raw: pre.ac.raw,
	vpn_nc: pre.vpn.nc,
	vpn_routes: pre.vpn.routes,
	controls:
		"identity+truncation+tests in-gate; no retries; failed rounds stay in the denominator",
});

export interface Executed {
	o: Out;
	v: RoundVerdict;
	grade: CodeGrade | null;
}

/** One attempt, one round. No retries — a failure is recorded and stands. */
export const runPair = async (
	ctx: RunContext,
	round: number,
	task: TaskName,
	leg: Leg,
	phase: "warmup" | "warm",
): Promise<Executed> => {
	const nonce = nonceOf(ctx.run, leg.id, task, phase);
	const prompt = ctx.prompts[task];
	const o = await callLeg(leg, {
		user: `[ref:${nonce}]\n${prompt}`,
		maxTokens: phase === "warmup" ? 16 : maxTokensFor(leg.id),
		effort: null,
		timeoutMs: TASK_TIMEOUT[task],
		port: LOCAL_PORT,
	});
	const grade =
		phase === "warm" && task === "code" && o.ok
			? gradeCode(o.text, ctx.run, `${leg.id}-r${round}`)
			: null;
	const v = classify(o, leg.servedExpect?.(LOCAL_PORT) ?? null, grade);
	return { o, v, grade };
};

const outFileFor = (
	run: string,
	round: number,
	task: string,
	legId: string,
): string => join(OUT_DIR, join(run, `${task}-${legId}-r${round}.md`));
const warmupLine = (legId: string, e: Executed): string =>
	`warmup ${LEG_LABEL[legId as LegId] ?? legId}: pass=${e.v.pass} served=${e.o.served ?? "?"} wall=${Math.round(e.o.wall)}ms ${e.v.failKind ?? ""} ${e.o.err ?? ""}`.trim();

/** Warmup: one excluded round on the code task per leg (cold-load lands here
 * for :8903). A failing warmup aborts before the sealed budget is spent. */
export const warmup = async (ctx: RunContext): Promise<boolean> => {
	for (const leg of ctx.legs) {
		const e = await runPair(ctx, 0, "code", leg, "warmup");
		const row = rowOf(
			ctx.run,
			0,
			"code",
			leg,
			"warmup",
			e.o,
			e.v,
			e.grade,
			outFileFor(ctx.run, 0, "code", leg.id),
		);
		put(ctx.file, row);
		console.log(warmupLine(leg.id, e));
		// warmup asserts transport + served identity only — a 16-token answer
		// from a thinking model always "truncates", which is not a warmup fail
		if (!e.v.ok || e.v.identity) return false;
	}
	return true;
};

/** Resume: (leg, round, task) pairs already on disk are skipped. */
export function doneSet(file: string): Set<string> {
	const done = new Set<string>();
	if (!existsSync(file)) return done;
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	for (const line of lines) {
		try {
			const r = JSON.parse(line) as {
				type: string;
				leg?: string;
				round?: number;
				task?: string;
			};
			if (r.type === "round") done.add(`${r.leg}|${r.round}|${r.task}`);
		} catch {}
	}
	return done;
}

// --------------------------------------------------------------- rows io
export function loadRows(file: string): RoundRow[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as RoundRow)
		.filter((r) => r.type === "round");
}

/** Blind review set: every transport-ok review answer (even void rounds) is
 * re-named anon-N in seeded-shuffled order; the mapping goes to key.jsonl
 * (sha printed). The grader grades blind/ with the key closed. */
export function blindPrep(file: string, outDir: string, seed: string): Blind {
	const rows = loadRows(file).filter(
		(r) => r.task === "review" && r.ok === true,
	);
	mkdirSync(join(outDir, "blind"), { recursive: true });
	const order = shuffle(w532Rng(seed, "blind"), rows);
	const key: string[] = [];
	let n = 0;
	for (const r of order) {
		if (!r.out_file) continue;
		n++;
		const anon = `anon-${pad(n, 2)}.md`;
		const src = r.out_file;
		copyFileSync(src, join(outDir, "blind", anon));
		key.push(JSON.stringify({ anon, out_file: src }));
	}
	const kb = `${key.join("\n")}\n`;
	writeFileSync(join(outDir, "key.jsonl"), kb);
	return { count: n, keySha: sha(kb) };
}

// --------------------------------------------------------------- blind set
export interface Blind {
	count: number;
	keySha: string;
}

// --------------------------------------------------------------- summary
export interface LegSummary {
	leg: string;
	attempted: number;
	pass: number;
	by_kind: Record<string, number>;
	wall_p50_warm: number | null;
	toks_p50_warm: number | null;
	reason_share_p50_warm: number | null;
	cost_usd_total: number;
}

export function summarize(file: string, legs: string[]): LegSummary[] {
	const rows = loadRows(file);
	const out: LegSummary[] = [];
	for (const leg of legs) {
		const mine: RoundRow[] = [];
		const warm: RoundRow[] = [];
		for (const r of rows) {
			if (r.leg !== leg) continue;
			mine.push(r);
			if (r.phase === "warm") warm.push(r);
		}
		const kinds: Record<string, number> = {};
		let pass = 0;
		let cost = 0;
		for (const r of mine) {
			// warmup rows are excluded from the stats by design (cold-load
			// + 16-token truncations) — cost however is real and stays in
			if (r.phase === "warmup") {
				cost += r.cost_usd;
				continue;
			}
			if (r.fail_kind !== null)
				kinds[r.fail_kind] = (kinds[r.fail_kind] ?? 0) + 1;
			if (typeof r.cost_usd === "number") cost += r.cost_usd;
		}
		const walls: number[] = [];
		const toks: number[] = [];
		const shares: number[] = [];
		for (const r of warm) {
			if (r.pass === true) pass++;
			if (typeof r.wall_ms !== "number") continue;
			walls.push(r.wall_ms);
			if (r.wall_ms > 0 && typeof r.out_tok === "number")
				toks.push((r.out_tok / r.wall_ms) * 1000);
			if (
				typeof r.out_tok === "number" &&
				r.out_tok > 0 &&
				typeof r.reason_tok === "number"
			)
				shares.push(r.reason_tok / r.out_tok);
		}
		out.push({
			leg,
			attempted: warm.length,
			pass,
			by_kind: kinds,
			wall_p50_warm: median(walls),
			toks_p50_warm: median(toks),
			reason_share_p50_warm: median(shares),
			cost_usd_total: Math.round(cost * 10_000) / 10_000,
		});
	}
	return out;
}

// --------------------------------------------------------------- overnight CLI
const dateStamp = (): string => {
	const now = new Date();
	const p2 = (x: number) => String(x).padStart(2, "0");
	return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
};

const gateFail = (msg: string): never => {
	console.error(`preflight fail: ${msg}`);
	process.exit(3);
};

async function main(): Promise<void> {
	// 1. args — --rounds N (floor 10; --smoke pins 1), --tasks code,review,
	// --run-id, --smoke
	const argv = process.argv.slice(2);
	let rounds = 10;
	let smoke = false;
	let runId = "";
	let tasks: TaskName[] = ["code", "review"];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--smoke") smoke = true;
		else if (a === "--rounds") {
			const n = Number.parseInt(argv[i + 1] ?? "", 10);
			rounds = Number.isFinite(n) ? n : 10;
			i++;
		} else if (a === "--tasks") {
			const want = (argv[i + 1] ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			tasks = (["code", "review"] as TaskName[]).filter((t) =>
				want.includes(t),
			);
			if (tasks.length === 0) tasks = ["code", "review"];
			i++;
		} else if (a === "--run-id") {
			runId = argv[i + 1] ?? "";
			i++;
		}
	}
	rounds = smoke ? 1 : Math.max(rounds, 10);
	const run = runId.length > 0 ? runId : `w532-${dateStamp()}`;
	// 2. legs — the three sealed legs, canonical order, must all exist
	const legs: Leg[] = [];
	const missing: string[] = [];
	for (const id of LEG_IDS) {
		const leg = LEGS.find((l) => l.id === id);
		if (leg === undefined) missing.push(id);
		else legs.push(leg);
	}
	if (legs.length !== LEG_IDS.length)
		throw new Error(`missing legs in LEGS: ${missing.join(", ")}`);
	// 3. review source
	const src = readFileSync(laneLivenessPath, "utf8");
	// 4. rubric
	if (!existsSync(RUBRIC_PATH))
		throw new Error(
			`missing rubric: ${RUBRIC_PATH} does not exist — create local-reason-rubric.md before the run`,
		);
	const rubric = readFileSync(RUBRIC_PATH, "utf8");
	// 5. preflight gates — exit 3, never run on battery / VPN / keyless
	const ac = acPower();
	const vpn = vpnEvidence();
	if (!smoke && !ac.ok) gateFail(`not on AC power (${ac.raw})`);
	if (!vpn.ok) gateFail(`corp VPN evidence (${vpn.nc} | ${vpn.routes})`);
	const key = engineKeyFromFile();
	if (key === null)
		gateFail("no engine key at ~/.claude/local-llm/litellm.key");
	if (key !== null) process.env.LITELLM_KEY = key;
	// 6. the local :8903 reasoner must be up (waits through cold load)
	const spec = SPECIALISTS.find((s) => s.port === LOCAL_PORT);
	if (spec === undefined)
		gateFail(`no specialist registered on :${LOCAL_PORT}`);
	const ens = await ensureUp(spec);
	if (!ens.up) gateFail(`:${LOCAL_PORT} not up (${ens.error ?? "unknown"})`);
	// 7. per-leg ping with a served-identity assert — never run blind
	for (const leg of legs) {
		const want =
			leg.id === "local-direct"
				? LOCAL_EXPECT
				: (leg.servedExpect?.(LOCAL_PORT) ?? null);
		const r = await ping(leg, leg.id === "local-direct" ? LOCAL_PORT : 0, run);
		if (!r.ok || (r.served ?? null) !== want)
			gateFail(
				`ping ${leg.id}: served=${r.served ?? "?"} expect=${want ?? "n/a"} err=${r.err ?? "none"}`,
			);
		console.log(
			`ping ${LEG_LABEL[leg.id as LegId] ?? leg.id}: served=${r.served ?? "?"} expect=${want ?? "n/a"}`,
		);
	}
	// 8. run context
	const hp = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
		cwd: process.cwd(),
	});
	const head = hp.stdout.toString().trim();
	const seed = run;
	const file = join(OUT_DIR, `${run}.jsonl`);
	mkdirSync(join(OUT_DIR, run), { recursive: true });
	const prompts = buildPrompts(src);
	const ctx: RunContext = {
		run,
		rounds,
		tasks,
		legs,
		prompts,
		seed,
		head,
		file,
	};
	// 9. seal — one row, only on a fresh file
	if (!existsSync(file)) {
		put(
			file,
			sealRow(
				ctx,
				sha(rubric),
				sha(src),
				sha(JSON.stringify(prompts)),
				await Bun.file(import.meta.path).text(),
				{ ac, vpn },
			),
		);
	}
	// 10. resume — warmup once per file, then the (leg|round|task) skip set
	if (loadRows(file).filter((r) => r.phase === "warmup").length === 0) {
		const okw = await warmup(ctx);
		if (!okw) process.exit(3);
	}
	const done = doneSet(file);
	// 11. the sealed rounds — one attempt per (round, task, leg), no retries;
	// the legs of one pair run concurrently (same task, same window — pairing
	// is (round, task), the legs share no endpoint so walls stay fair)
	for (let r = 1; r <= rounds; r++) {
		for (const { task, order } of roundPlan(ctx.seed, r, tasks, legs)) {
			await Promise.all(
				order.map(async (leg) => {
					const key = `${leg.id}|${r}|${task}`;
					if (done.has(key)) return;
					const e = await runPair(ctx, r, task, leg, "warm");
					const of = outFileFor(run, r, task, leg.id);
					writeFileSync(of, e.o.text);
					put(file, rowOf(run, r, task, leg, "warm", e.o, e.v, e.grade, of));
					console.log(
						`[r${r}/${rounds}] ${task} ${leg.id} pass=${e.v.pass} wall=${Math.round(e.o.wall)}ms served=${e.o.served ?? "?"} ${e.v.failKind ?? ""} ${e.o.err ?? ""}`.trim(),
					);
				}),
			);
		}
	}
	// 12. end row + summary + the blind review set
	const summary = summarize(file, [...LEG_IDS]);
	put(file, { type: "end", at: new Date().toISOString(), summary });
	console.log(`summary for ${run} (head ${head}):`);
	for (const s of summary) console.log(JSON.stringify(s));
	const blind = blindPrep(file, join(OUT_DIR, run), seed);
	console.log(
		`blind dir: ${join(OUT_DIR, run, "blind")} (${blind.count} answers, key sha ${blind.keySha})`,
	);
	console.log(
		"morning review: grade blind/ against local-reason-rubric.md; open key.jsonl only after",
	);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(String(e));
		process.exit(1);
	});
}
