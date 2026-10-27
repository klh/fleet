// review-rescore-arena.fixture.ts — W1476 (b) helpers for
// tests/review-rescore-arena.e2e.ts: the belt half of "reviewer prompt, model
// or tool changes are rescored against the whole set". Rigs are OS-tmpdir git
// repos carrying a test surface (s.ts shared, one file per arm) with the seal
// and results dirs inside; arms run injected executors (no LLM, no port) and
// the real lane plugin runs in-process against an OpenAI-wire stub. The real
// arena CLI runs main at import, so it is only ever spawned. Spec-file shape
// law: every declaration lives here, the spec registers tests.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha } from "../../packages/belt/bench/arena/core.ts";
import {
	type Finding,
	MAX_ROUNDS,
	type ReviewTask,
} from "../../packages/belt/bench/arena/review-core.ts";
import { INCIDENTS } from "../../packages/belt/bench/arena/review-incident.ts";
import type {
	LanePlugin,
	LaneReply,
} from "../../packages/belt/bench/arena/review-lane-arm.ts";
import type { ArmRun } from "../../packages/belt/bench/arena/review-pipeline.ts";
import {
	appendLedger,
	type LedgerRow,
	LOCK_FILE,
	readLedger,
	readSeal,
	type SealInfo,
	type Surface,
} from "../../packages/belt/bench/arena/review-rescore.ts";
import {
	type ArmLegFactory,
	type RescoreStatus,
	type RescoreSummary,
	rescore,
	rescoreStatus,
} from "../../packages/belt/bench/arena/review-rescore-run.ts";
import type { ArmId } from "../../packages/belt/bench/arena/review-score.ts";
import { commitFile, REPO_ROOT, tempRepo } from "./review-evals.fixture.ts";

export const ARENA_CLI = join(
	REPO_ROOT,
	"packages/belt/bench/arena/review-run.ts",
);
export const SURFACE_FILE = join(
	REPO_ROOT,
	"packages/belt/bench/arena/review-surface.json",
);
export const DESIGN_WHY =
	"no sealed set — bun packages/belt/bench/arena/review-run.ts --design";
export const LANE_KEY = "bksk_fixture_lane";
export const INCIDENT_IDS = INCIDENTS.map((d) => d.id);

type Env = Record<string, string | undefined>;

const diffOf = (lines: string[]): string => `${lines.join("\n")}\n`;

/** A seeded null-deref: the + line drops the optional chain (x.ts:10). */
export const SEEDED: ReviewTask = {
	id: "w1476-seeded",
	src: "seeded",
	title: "load: read the config value",
	mission: "load returns the config value or the fallback",
	diff: diffOf([
		"--- a/x.ts",
		"+++ b/x.ts",
		"@@ -8,4 +8,4 @@",
		" export function load(cfg: Config | null): string {",
		'   const fallback = "none";',
		"-  const v = cfg?.value;",
		"+  const v = cfg.value;",
		"   return v ?? fallback;",
	]),
	defects: [
		{
			id: "d1",
			cls: "null-deref",
			file: "x.ts",
			line: 10,
			desc: "dereferences a possibly-null config",
		},
	],
};

/** A clean rename — the right verdict is PASS with no findings. */
export const CLEAN: ReviewTask = {
	id: "w1476-clean",
	src: "clean",
	title: "total: rename the accumulator",
	mission: "rename the reducer accumulator; behavior unchanged",
	diff: diffOf([
		"--- a/z.ts",
		"+++ b/z.ts",
		"@@ -3,3 +3,3 @@",
		" export function total(xs: number[]): number {",
		"-  return xs.reduce((a, x) => a + x, 0);",
		"+  return xs.reduce((sum, x) => sum + x, 0);",
		" }",
	]),
	defects: [],
};

/** An incident case: the admin guard dropped (y.ts:19). */
export const INCIDENT: ReviewTask = {
	id: "w1476-incident",
	src: "incident",
	title: "promote: inline the role update",
	mission: "promote keeps the admin-only guard",
	diff: diffOf([
		"--- a/y.ts",
		"+++ b/y.ts",
		"@@ -17,5 +17,4 @@",
		" export function promote(user: User, target: User): void {",
		"   audit(user, target);",
		'-  if (!user.admin) throw new Error("admin only");',
		'   target.role = "admin";',
		" }",
	]),
	defects: [
		{
			id: "d2",
			cls: "dropped-check",
			file: "y.ts",
			line: 19,
			desc: "the admin check is gone",
		},
	],
};

export const TASKS: ReviewTask[] = [SEEDED, CLEAN];

export const LANE_REPLY =
	"B1-null-deref: high x.ts:10 — dereferences a possibly-null config\nVERDICT: FAIL - one blocker\n";

/** The stub reviewer: flags the seeded task (the lane prompt carries the
 *  diff verbatim), passes everything else. */
export const laneReplyFor = (prompt: string): string =>
	prompt.includes(SEEDED.diff) ? LANE_REPLY : "VERDICT: PASS\n";

// ---------------------------------------------------------------- rigs

export const surfaceBody = (path: string): string =>
	`export const surface = ${JSON.stringify(path)};\n`;

/** The rig surface: s.ts shared, one file per arm, the lane model required. */
export const testSurface = (
	minIntervalSeconds = 0,
	maxFailureRate = 0,
): Surface => ({
	lanePlugin: "prompt.ts",
	minIntervalSeconds,
	maxFailureRate,
	shared: ["s.ts"],
	arms: {
		a: { paths: ["a.ts"], env: ["REVIEW_ARM_A_PORT"], required: [] },
		b: { paths: ["b.ts"], env: [], required: [] },
		lane: {
			paths: ["prompt.ts"],
			env: ["REVIEW_LANE_MODEL"],
			required: ["REVIEW_LANE_MODEL"],
		},
	},
});

export interface Rig {
	repo: string;
	resDir: string;
	sealDir: string;
}

/** A git rig with the surface files committed; seal + results dirs inside. */
export function rig(): Rig {
	const repo = tempRepo();
	for (const p of ["s.ts", "a.ts", "b.ts", "prompt.ts"])
		commitFile(repo, p, surfaceBody(p), `add ${p}`);
	return { repo, resDir: join(repo, ".results"), sealDir: join(repo, ".seal") };
}

/** A working-copy edit (uncommitted). */
export const touch = (r: Rig, path: string, body: string): void =>
	writeFileSync(join(r.repo, path), body);

/** A committed surface edit. */
export const commitSurface = (r: Rig, path: string, body: string): string =>
	commitFile(r.repo, path, body, `edit ${path}`);

export const scratch = (): string =>
	mkdtempSync(join(tmpdir(), "w1476-rescore-"));

/** Write a surface file into `dir` (raw JSON, malformed on purpose). */
export function surfaceFile(dir: string, raw: unknown): string {
	const file = join(dir, `surface-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(raw));
	return file;
}

// ---------------------------------------------------------------- seal

/** Seal `tasks` the --design way (body + MANIFEST sha16); `hash` tampers the
 *  MANIFEST. Returns the MANIFEST hash. */
export function writeSeal(
	dir: string,
	tasks: ReviewTask[] = TASKS,
	hash?: string,
): string {
	mkdirSync(dir, { recursive: true });
	const body = `${JSON.stringify(tasks)}\n`;
	const manifest = { hash: hash ?? sha(body).slice(0, 16), count: tasks.length };
	writeFileSync(join(dir, "tasks.json"), body);
	writeFileSync(join(dir, "MANIFEST.json"), `${JSON.stringify(manifest)}\n`);
	return manifest.hash;
}

export function sealOf(dir: string): { tasks: ReviewTask[]; info: SealInfo } {
	const seal = readSeal(dir);
	if (!seal) throw new Error(`no seal at ${dir}`);
	return seal;
}

/** (Re-)seal the rig with `tasks`. */
export function sealRig(
	r: Rig,
	tasks: ReviewTask[] = TASKS,
): { tasks: ReviewTask[]; info: SealInfo } {
	writeSeal(r.sealDir, tasks);
	return sealOf(r.sealDir);
}

// ---------------------------------------------------------------- status

export interface StatusOpts {
	seal: SealInfo | null;
	env?: Env;
	force?: boolean;
	surface?: Surface;
	incidentIds?: string[];
}

export const statusOf = (r: Rig, o: StatusOpts): Promise<RescoreStatus> =>
	rescoreStatus({
		root: r.repo,
		surface: o.surface ?? testSurface(),
		seal: o.seal,
		resDir: r.resDir,
		env: o.env ?? {},
		force: o.force,
		incidentIds: o.incidentIds,
	});

/** arm → `DUE <why>` | `idle <why>`. */
export const whys = (st: RescoreStatus): Record<string, string> =>
	Object.fromEntries(
		st.arms.map((a) => [a.arm, `${a.due ? "DUE" : "idle"} ${a.why}`]),
	);

/** Bank a scored ledger row at the arm's current fingerprint (no run);
 *  returns the row's ts. */
export async function markScored(
	r: Rig,
	arm: ArmId,
	o: { seal: SealInfo; env?: Env; surface?: Surface },
): Promise<string> {
	const st = await statusOf(r, o);
	const cur = st.arms.find((a) => a.arm === arm);
	if (!cur) throw new Error(`no arm ${arm}`);
	const ts = new Date().toISOString();
	appendLedger(r.resDir, {
		ts,
		arm,
		status: "scored",
		reason: "fixture",
		fingerprint: cur.fingerprint,
		parts: cur.parts,
		changed: cur.changed,
		head: st.head,
		seal: o.seal.hash,
		runId: null,
		model: null,
		plugin: null,
		score: null,
		runFailures: 0,
		prevRunId: null,
		delta: null,
	});
	return ts;
}

export const ledgerOf = (r: Rig): Promise<LedgerRow[]> => readLedger(r.resDir);

// ---------------------------------------------------------------- lock

export const lockPath = (r: Rig): string => join(r.resDir, LOCK_FILE);
export const hasLock = (r: Rig): boolean => existsSync(lockPath(r));

/** A lock file owned by `pid` (a live foreign rescore, or a dead one). */
export function holdLock(r: Rig, pid: number): void {
	mkdirSync(r.resDir, { recursive: true });
	writeFileSync(
		lockPath(r),
		JSON.stringify({ pid, ts: Date.now(), reason: "fixture" }),
	);
}

/** The pid of a child that has already exited. */
export async function deadPid(): Promise<number> {
	const p = Bun.spawn([process.execPath, "-e", "0"]);
	await p.exited;
	return p.pid;
}

// ---------------------------------------------------------------- arms

const run = (findings: Finding[], verdict: "PASS" | "FAIL"): ArmRun => ({
	arm: "a",
	findings,
	verdict,
	roundsToPass: verdict === "PASS" ? 1 : MAX_ROUNDS + 1,
	openBlockers: [],
	tokIn: 100,
	tokOut: 20,
	calls: 1,
	wallMs: 5,
	trace: [],
	ok: true,
});

/** An injected arm-A executor: "finds" flags every seeded defect, "blind"
 *  passes everything, "throws" drops the transport on defect tasks. */
export const legA =
	(mode: "finds" | "blind" | "throws"): ArmLegFactory =>
	async () => ({
		exec: async (t: ReviewTask) => {
			if (mode === "throws" && t.defects.length) throw new Error("leg reset");
			if (mode !== "finds" || !t.defects.length) return run([], "PASS");
			return run(
				t.defects.map(
					(d): Finding => ({
						id: `B1-${d.cls}`,
						severity: "high",
						file: d.file,
						line: d.line,
						issue: d.desc,
					}),
				),
				"FAIL",
			);
		},
	});

/** A leg that cannot run (a down port): the factory's string answer. */
export const downLeg =
	(why: string): ArmLegFactory =>
	async () =>
		why;

export interface RescoreRigOpts {
	runId: string;
	seal: { tasks: ReviewTask[]; info: SealInfo };
	legs: Partial<Record<ArmId, ArmLegFactory>>;
	arms?: ArmId[];
	force?: boolean;
	env?: Env;
	surface?: Surface;
}

export const rescoreRig = (
	r: Rig,
	o: RescoreRigOpts,
): Promise<RescoreSummary> =>
	rescore({
		root: r.repo,
		surface: o.surface ?? testSurface(),
		resDir: r.resDir,
		env: o.env ?? {},
		arms: o.arms,
		force: o.force,
		seal: o.seal.info,
		tasks: o.seal.tasks,
		reason: "fixture",
		runId: o.runId,
		legs: o.legs,
	});

// ---------------------------------------------------------------- lane

export interface PluginCall {
	url: string;
	model: string;
	key?: string;
	prompt: string;
	timeoutMs: number;
}

/** A lane plugin double: a fixed reply (null = the leg's HTTP 502). */
export function stubPlugin(reply: LaneReply | null): {
	plugin: LanePlugin;
	calls: PluginCall[];
} {
	const calls: PluginCall[] = [];
	return {
		calls,
		plugin: {
			prompter: (t) => `review ${t.id}`,
			request: async (o) => {
				calls.push(o);
				if (!reply) throw new Error("Review LLM HTTP 502");
				return reply;
			},
			version: "stub.ts@00000000",
		},
	};
}

export interface StubCall {
	model: string;
	auth: string | null;
	prompt: string;
	maxTokens: number;
	temperature: number;
}

/** An in-process OpenAI-wire endpoint the real lane plugin calls (a spawned
 *  child cannot reach a parent-side Bun.serve on this macOS). */
export function openAiStub(replyFor: (prompt: string) => string): {
	url: string;
	port: number;
	calls: StubCall[];
	stop: () => Promise<void>;
} {
	const calls: StubCall[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			const body = (await req.json()) as {
				model: string;
				messages: { content: string }[];
				max_tokens: number;
				temperature: number;
			};
			const prompt = body.messages[0]?.content ?? "";
			calls.push({
				model: body.model,
				auth: req.headers.get("authorization"),
				prompt,
				maxTokens: body.max_tokens,
				temperature: body.temperature,
			});
			return Response.json({
				model: "served-review-model",
				choices: [
					{ finish_reason: "stop", message: { content: replyFor(prompt) } },
				],
				usage: { prompt_tokens: 321, completion_tokens: 54 },
			});
		},
	});
	const port = server.port ?? 0;
	return {
		url: `http://127.0.0.1:${port}/v1/chat/completions`,
		port,
		calls,
		stop: async () => {
			await server.stop(true);
		},
	};
}

// ---------------------------------------------------------------- CLI

export interface CliResult {
	code: number;
	out: string;
	err: string;
	status: RescoreStatus | null;
}

/** The real arena CLI in a child on the rig's seal + results dirs, every
 *  inherited REVIEW_* knob stripped (the fingerprint reads env pins). */
export function arenaCli(
	args: string[],
	dirs: { sealDir: string; resDir: string },
): CliResult {
	const env: Env = {};
	for (const [k, v] of Object.entries(process.env))
		if (!k.startsWith("REVIEW_")) env[k] = v;
	env.REVIEW_SEAL_DIR = dirs.sealDir;
	env.REVIEW_RESULTS_DIR = dirs.resDir;
	const p = Bun.spawnSync([process.execPath, ARENA_CLI, ...args], {
		cwd: REPO_ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = p.stdout.toString();
	const tag = "RESCORE-STATUS ";
	const line = out.split("\n").find((l) => l.startsWith(tag));
	return {
		code: p.exitCode ?? -1,
		out,
		err: p.stderr.toString(),
		status: line ? (JSON.parse(line.slice(tag.length)) as RescoreStatus) : null,
	};
}
