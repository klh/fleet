// Live consult-plane benchmark (W934.2.2). Unlike the deterministic policy
// suite (harness.ts), this runner spawns the REAL coord CLI consult ladder
// against a scratch governor plane (temp HOME, fixture git repo) — real
// SQLite, real routing, real subprocess latency; the expert is a scripted
// stand-in answering through the real consult-reply path (no model calls).
//
// Baseline arms, matched over the same question set:
//   expert — `consult --best "q" --scope s --no-kb`: the ladder is skipped,
//            the ask routes OPEN to the seeded live expert, the stand-in
//            answers and the asker records resolved feedback. Measures a
//            full expert round trip (ask → answer → verify).
//   kb     — plain `consult --best "q" --scope s` afterwards: the plane
//            answers from asker-verified consult_kb reuse with no live lane.
//
// The expert pass must run first: the reuse arm is only answerable once the
// expert arm's verified feedback has landed. This warm-cache bias favors
// the reuse arm — read kb latencies as an upper bound for cold reuse.
// Spec + baseline results: bench/consult/live.md.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type ArmName = "expert" | "kb";

export type AskOutcome =
	| "expert-answered"
	| "kb-answered"
	| "fact-answered"
	| "routed-open"
	| "refused"
	| "error";

export interface AskReceipt {
	arm: ArmName;
	question: string;
	/** the routed consult id (C<number>) when one was created */
	consultRef: string | null;
	outcome: AskOutcome;
	wallMs: number;
	answerChars: number;
	exit: number;
}

export interface ArmSummary {
	arm: ArmName;
	asks: number;
	answered: number;
	refused: number;
	errors: number;
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
}

export interface BenchProperty {
	name: string;
	holds: boolean;
}

export interface LiveReport {
	startedAt: number;
	questions: string[];
	receipts: AskReceipt[];
	arms: ArmSummary[];
	properties: BenchProperty[];
	allHold: boolean;
	reportPath: string;
}

const DEFAULT_QUESTIONS = [
	"why does the blam consult lane stall before the first turn",
	"how does the blam bench seed a verified consult reuse row",
	"what makes the blam consult ladder skip a dead rung",
	"when does the blam plane refuse to route a consult",
];

const CANNED = (q: string): string =>
	`Verified scratch-plane answer for "${q}": the seeded blam expert resolved this on the bench fixture, evidence recorded by the asker feedback step.`;

/** git walks UP through the scaffolded .git — mirror projectIdentity(). */
function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		if (d) return realpathSync(resolve(dir, d));
	}
	return realpathSync(dir);
}

export interface BenchOptions {
	questions?: string[];
	/** output directory for report.json (default: a temp dir) */
	out?: string;
	/** override the coord CLI path (default: the sibling suspenders checkout) */
	coordPath?: string;
}

interface Fixture {
	home: string;
	repo: string;
	proj: string;
	dbPath: string;
	expertSid: string;
	askerSid: string;
	coord: string;
	env: Record<string, string>;
}

function scaffoldFixture(opts: BenchOptions): Fixture {
	const home = mkdtempSync(join(tmpdir(), "blam-consult-live-"));
	const repo = join(home, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "docs"), { recursive: true });
	const git = (...args: string[]): void => {
		Bun.spawnSync(
			[
				"git",
				"-C",
				repo,
				"-c",
				"user.name=blam-bench",
				"-c",
				"user.email=blam@bench.invalid",
				...args,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
	};
	git("init", "-q");
	writeFileSync(
		join(repo, "docs", "README.md"),
		"blam consult live bench fixture\n",
	);
	git("add", "-A");
	git("commit", "-qm", "fixture");
	const coord =
		opts.coordPath ??
		join(
			import.meta.dir,
			"..",
			"..",
			"..",
			"suspenders",
			"hooks",
			"bin",
			"coord.ts",
		);
	return {
		home,
		repo,
		proj: projectOf(repo),
		dbPath: join(home, ".cache", "claude-governor", "governor.db"),
		expertSid: "blam-expert-11111111",
		askerSid: "blam-asker-22222222",
		coord,
		env: {
			...process.env,
			HOME: home,
			SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
		},
	};
}

interface RunResult {
	out: string;
	err: string;
	code: number;
}

function runCli(fx: Fixture, cwd: string, args: string[]): RunResult {
	const p = Bun.spawnSync(["bun", fx.coord, ...args], {
		cwd,
		env: fx.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

/** First CLI open runs the migrations; then seed the live expert stand-in. */
function seedPlane(fx: Fixture): void {
	runCli(fx, fx.repo, ["kb", "stats"]);
	const db = new Database(fx.dbPath);
	const now = Date.now();
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
	).run(fx.expertSid, fx.proj, now, now);
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
	).run(fx.askerSid, fx.proj, now, now);
	db.query(
		"INSERT INTO claims (sid, scope, intent, hot, ts, tp) VALUES (?, ?, ?, 0, ?, '')",
	).run(fx.expertSid, "blam-bench", "blam consult plane bench", now);
	db.close();
}

export function parseOutcome(
	stdout: string,
	exit: number,
): { outcome: AskOutcome; consultRef: string | null; answerChars: number } {
	const ref = /\bC(\d+)\b/.exec(stdout)?.[0] ?? null;
	const answerChars = (() => {
		const m =
			/answered from (?:the knowledge base|a verified fleet fact)[:\s].*?([\s\S]*)$/.exec(
				stdout,
			);
		return m ? m[1].trim().length : 0;
	})();
	if (stdout.includes("answered from the knowledge base"))
		return { outcome: "kb-answered", consultRef: ref, answerChars };
	if (stdout.includes("answered from a verified fleet fact"))
		return { outcome: "fact-answered", consultRef: ref, answerChars };
	if (/CONSULT C\d+/.test(stdout))
		return { outcome: "routed-open", consultRef: ref, answerChars: 0 };
	if (stdout.includes("no ranked expert") || stdout.includes("queue is full"))
		return { outcome: "refused", consultRef: null, answerChars: 0 };
	return {
		outcome: exit === 0 ? "routed-open" : "error",
		consultRef: ref,
		answerChars,
	};
}

const percentile = (xs: number[], p: number): number => {
	if (!xs.length) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
};

function summarize(arm: ArmName, receipts: AskReceipt[]): ArmSummary {
	const rows = receipts.filter((r) => r.arm === arm);
	const walls = rows.map((r) => r.wallMs);
	const answered = rows.filter(
		(r) => r.outcome === "expert-answered" || r.outcome === "kb-answered",
	).length;
	return {
		arm,
		asks: rows.length,
		answered,
		refused: rows.filter((r) => r.outcome === "refused").length,
		errors: rows.filter((r) => r.outcome === "error").length,
		meanMs: walls.length
			? Math.round(walls.reduce((a, b) => a + b, 0) / walls.length)
			: 0,
		p50Ms: percentile(walls, 0.5),
		p95Ms: percentile(walls, 0.95),
	};
}

/** One expert arm: ask (--no-kb) → stand-in replies → asker verifies. */
function runExpertArm(
	fx: Fixture,
	question: string,
): { receipt: AskReceipt; completed: boolean } {
	const t0 = performance.now();
	const ask = runCli(fx, fx.repo, [
		"consult",
		"--best",
		question,
		"--scope",
		"blam-bench",
		"--no-kb",
		"--as",
		fx.askerSid,
	]);
	const askMs = Math.round(performance.now() - t0);
	const parsed = parseOutcome(ask.out, ask.code);
	let completed = false;
	let wallMs = askMs;
	if (parsed.outcome === "routed-open" && parsed.consultRef) {
		const reply = runCli(fx, fx.repo, [
			"consult-reply",
			parsed.consultRef,
			CANNED(question),
			"--as",
			fx.expertSid,
		]);
		const feedback = runCli(fx, fx.repo, [
			"consult-reply",
			parsed.consultRef,
			"--feedback",
			"resolved",
			"--evidence",
			"blam bench: scratch-plane round trip verified",
			"--as",
			fx.askerSid,
		]);
		completed =
			reply.code === 0 &&
			feedback.code === 0 &&
			reply.out.includes("ANSWERED") &&
			feedback.out.includes("resolved");
		wallMs = Math.round(performance.now() - t0);
	}
	return {
		receipt: {
			arm: "expert",
			question,
			consultRef: parsed.consultRef,
			outcome: completed ? "expert-answered" : parsed.outcome,
			wallMs,
			answerChars: completed ? CANNED(question).length : parsed.answerChars,
			exit: ask.code,
		},
		completed,
	};
}

function runKbArm(fx: Fixture, question: string): AskReceipt {
	const t0 = performance.now();
	const ask = runCli(fx, fx.repo, [
		"consult",
		"--best",
		question,
		"--scope",
		"blam-bench",
		"--as",
		fx.askerSid,
	]);
	const parsed = parseOutcome(ask.out, ask.code);
	return {
		arm: "kb",
		question,
		consultRef: parsed.consultRef,
		outcome: parsed.outcome,
		wallMs: Math.round(performance.now() - t0),
		answerChars: parsed.answerChars,
		exit: ask.code,
	};
}

export async function runLiveBench(
	opts: BenchOptions = {},
): Promise<LiveReport> {
	const questions = opts.questions ?? DEFAULT_QUESTIONS;
	const fx = scaffoldFixture(opts);
	seedPlane(fx);
	const receipts: AskReceipt[] = [];
	// expert pass first — the reuse arm needs the verified rows it lands
	const completions: boolean[] = [];
	for (const q of questions) {
		const { receipt, completed } = runExpertArm(fx, q);
		receipts.push(receipt);
		completions.push(completed);
	}
	for (const q of questions) receipts.push(runKbArm(fx, q));
	const outDir = opts.out ?? join(tmpdir(), `blam-consult-live-${Date.now()}`);
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	const expert = summarize("expert", receipts);
	const kb = summarize("kb", receipts);
	const properties: BenchProperty[] = [
		{
			name: "P1 expert round trip: every ask routed OPEN and completed verified",
			holds: completions.every(Boolean) && expert.answered === questions.length,
		},
		{
			name: "P2 kb reuse: every plain ask answered from the KB, no live lane",
			holds: receipts
				.filter((r) => r.arm === "kb")
				.every((r) => r.outcome === "kb-answered"),
		},
		{
			name: "P3 matched arms: identical question sets ran on both arms",
			holds:
				receipts.filter((r) => r.arm === "expert").length ===
					questions.length &&
				receipts.filter((r) => r.arm === "kb").length === questions.length,
		},
		{
			name: "P4 reuse latency: median kb ask ≤ median expert round trip",
			holds: kb.p50Ms <= expert.p50Ms,
		},
	];
	const report: LiveReport = {
		startedAt: Date.now(),
		questions,
		receipts,
		arms: [expert, kb],
		properties,
		allHold: properties.every((p) => p.holds),
		reportPath: join(outDir, "report.json"),
	};
	writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
		mode: 0o600,
	});
	return report;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const asksIdx = argv.indexOf("--asks");
	const outIdx = argv.indexOf("--out");
	const questions =
		asksIdx >= 0
			? (
					JSON.parse(await Bun.file(argv[asksIdx + 1] ?? "").text()) as {
						questions: string[];
					}
				).questions
			: undefined;
	const report = await runLiveBench({
		questions,
		out: outIdx >= 0 ? argv[outIdx + 1] : undefined,
	});
	for (const a of report.arms) {
		console.log(
			`${a.arm}: ${a.answered}/${a.asks} answered, refused ${a.refused}, errors ${a.errors}, mean ${a.meanMs}ms, p50 ${a.p50Ms}ms, p95 ${a.p95Ms}ms`,
		);
	}
	for (const p of report.properties)
		console.log(`${p.holds ? "✓" : "✗"} ${p.name}`);
	console.log(`report: ${report.reportPath}`);
	if (!report.allHold) process.exitCode = 1;
}
