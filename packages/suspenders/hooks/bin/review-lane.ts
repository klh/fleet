// review-lane.ts — W182 second-opinion runner. One-shot, detached, READ-ONLY
// (never claims the item): assembles the item's diff + thread as review
// context, asks the picked executor, parses the verdict line, and lands the
// findings: coord NOTE(s) on the item thread, a work.review verdict event,
// and fact review.<item>.<executor>. Works on DONE items — reviewing landed
// work is the point. Spawned by the board's POST /api/second-opinion.
// usage:
//   bun review-lane.ts --item <Wn> --project <p> --executor <name> \
//     (--bin <path> | --belt <machine>:<port>[:<model>] | --llm-url <url> [--llm-model <m>])
// exits 0 on a landed verdict, 2 on a failed leg (verdict=error recorded).
import { openStore, projectRootOf } from "../lib/govdb.ts";
import { resolveBelt } from "../lib/belt-locate.ts";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

// ---- args (W820: verb-kit owns parsing — W651 law) -------------------------
// W820: verb-kit owns parsing (W651 law) — reqFlags --item/--project; the
// kit usage line prints + exit 1 on violation; --help renders per-verb help.
const spec = defineVerb({
	name: "review",
	usage: "usage: bun review-lane.ts --item <Wn> --project <p> --executor <name> (--bin <path> | --belt <m>:<p>[:<model>] | --llm-url <url> [--llm-model <m>])",
	flags: ["--item", "--project", "--executor", "--bin", "--belt", "--llm-url", "--llm-model"],
	reqFlags: ["--item", "--project"],
});
const args = process.argv.slice(2);
if (args.some((a) => a === "--help" || a === "-h")) {
	console.log(renderVerbHelp(spec));
	process.exit(0);
}
const parsedArgs = parseVerb(spec, args);
if (!parsedArgs.ok) {
	console.error(parsedArgs.message);
	process.exit(1);
}
const item = parsedArgs.parsed.flag("--item");
const project = parsedArgs.parsed.flag("--project");
const executor = parsedArgs.parsed.flag("--executor") ?? "claude";
if (!item || !project) {
	console.error(
		"usage: bun review-lane.ts --item <Wn> --project <p> --executor <name> (--bin <path> | --belt <m>:<p>[:<model>] | --llm-url <url> [--llm-model <m>])",
	);
	process.exit(1);
}
const repo = projectRootOf(project);
if (!repo || repo.includes("..") || !repo.startsWith("/")) {
	console.error(`review-lane: bad project root for ${project}`);
	process.exit(1);
}

// ---- context: the item, its thread, the diff -------------------------------
const db = openStore();
type Row = Record<string, unknown>;
const w = db
	.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
	.get(project, item) as Row | null;
if (!w) {
	console.error(`review-lane: no work item ${item} in ${project}`);
	process.exit(1);
}

// git in the reviewed repo (arg arrays; cwd = repo unless overridden)
const gitRun = (args: string[], cwd = repo): { code: number; out: string } => {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: p.exitCode ?? 1, out: p.stdout.toString() };
};

// the branch diff vs main — capped; absent branch = claims-only review
function gitDiff(): string {
	const branch = `suspenders/${item}`;
	if (
		gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
			.code !== 0
	)
		return "";
	return gitRun(["diff", `main...${branch}`]).out.slice(0, 60_000);
}

// the coord thread: last 20 events on the item (work + project stamped)
const thread: string[] = (
	db
		.query(
			"SELECT ts, source, kind, payload FROM events WHERE work = ? AND project = ? ORDER BY id DESC LIMIT 20",
		)
		.all(item, project) as Row[]
).map(
	(e) =>
		`${new Date(Number(e.ts)).toISOString()} ${e.source} ${e.kind} ${String(
			e.payload,
		).slice(0, 200)}`,
);

// ---- the review prompt ------------------------------------------------------
const diff = gitDiff();
const prompt = [
	`You are a read-only second-opinion reviewer for Work Graph item ${item} in ${repo}.`,
	`Verify the work against the mission; you are auditing, NOT re-doing it. Do not edit anything.`,
	``,
	`PROTOCOL (Sinai rule): a mechanical coverage proof backs this review — on PASS the diff is reverted in a scratch checkout and the branch's new tests are required to fail there; tests that pass without the change mean no coverage and downgrade the verdict to FAIL.`,
	`MISSION (work show):`,
	`${String(w.title)}${w.description ? ` — ${String(w.description)}` : ""}`,
	`state: ${String(w.state)}; owner: ${String(w.owner_sid ?? "none")}`,
	``,
	`ITEM THREAD (newest first, last 20):`,
	...(thread.length ? thread : ["(no events)"]),
	``,
	`BRANCH DIFF (main...suspenders/${item}, capped):`,
	diff || "(no branch — review the thread/claims only)",
	``,
	`Report findings as terse bullets; end your reply with ONE machine-parseable final line:`,
	`VERDICT: PASS | VERDICT: FAIL - <reason>`,
].join("\n");

// ---- executor legs ----------------------------------------------------------
type Leg =
	| { kind: "bin"; bin: string }
	| { kind: "belt"; target: string }
	| { kind: "llm"; url: string; model: string };
const leg: Leg | null = (() => {
	const bin = parsedArgs.parsed.flag("--bin");
	if (bin) return { kind: "bin", bin };
	const belt = parsedArgs.parsed.flag("--belt");
	if (belt) return { kind: "belt", target: belt };
	const url = parsedArgs.parsed.flag("--llm-url");
	if (url)
		return {
			kind: "llm",
			url,
			model:
				parsedArgs.parsed.flag("--llm-model") ??
				process.env.SUSPENDERS_LLM_MODEL ??
				"local",
		};
	return null;
})();

// ---- run the leg ------------------------------------------------------------
const LEG_TIMEOUT_MS = 15 * 60_000;
async function runLeg(): Promise<string> {
	if (leg?.kind === "bin") {
		const p = Bun.spawn([leg.bin, "-p", prompt], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			cwd: repo,
		});
		const timer = setTimeout(() => p.kill(), LEG_TIMEOUT_MS);
		const out = await new Response(p.stdout).text();
		clearTimeout(timer);
		await p.exited;
		return out;
	}
	if (leg?.kind === "belt") {
		// belt targeting: remotes.ts route-to owns auth + model override
		const belt = await resolveBelt();
		if (!belt) throw new Error("belt repo not found (resolveBelt)");
		const parts = leg.target.split(":");
		const model = parts[2];
		const c = Bun.spawnSync([
			process.execPath,
			`${belt}/bin/remotes.ts`,
			"route-to",
			parts[0],
			parts[1],
			prompt,
			...(model ? ["--model", model] : []),
		]);
		if (c.exitCode !== 0)
			throw new Error(
				`belt route-to failed: ${c.stderr.toString().slice(0, 200)}`,
			);
		return c.stdout.toString();
	}
	if (leg?.kind === "llm") {
		const r = await fetch(leg.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(process.env.SUSPENDERS_LLM_KEY
					? { authorization: `Bearer ${process.env.SUSPENDERS_LLM_KEY}` }
					: {}),
			},
			body: JSON.stringify({
				model: leg.model,
				messages: [{ role: "user", content: prompt }],
				max_tokens: 1500,
				temperature: 0.2,
			}),
			signal: AbortSignal.timeout(LEG_TIMEOUT_MS),
		});
		if (!r.ok)
			throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return j.choices?.[0]?.message?.content ?? "";
	}
	throw new Error("no executor leg (--bin | --belt | --llm-url)");
}

// ---- coverage proof (W634, Sinai rule) --------------------------------------
// Before an approval stands, the change is DISABLED in a scratch checkout and
// the branch's new tests are run there: tests that pass without the change
// are out of scope or wrong, so a PASS with no failing new test is downgraded
// to FAIL. The evidence annotates the verdict.
type Proof = {
	status: "proved" | "no-coverage" | "skipped" | "error";
	detail: string;
	failed?: number;
	passed?: number;
};

// test paths only: the proof keeps these, reverses everything else
const TEST_FILE =
	/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test|spec)_/;

const PROOF_TIMEOUT_MS = 5 * 60_000;

async function coverageProof(branch: string): Promise<Proof> {
	if (
		gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
			.code !== 0
	)
		return { status: "skipped", detail: "no branch diff" };
	const testFiles = gitRun(["diff", "--name-only", `main...${branch}`])
		.out.trim()
		.split("\n")
		.filter((f) => TEST_FILE.test(f));
	if (testFiles.length === 0)
		return { status: "skipped", detail: "no test files in diff" };

	const scratch = mkdtempSync(join(tmpdir(), "review-proof-"));
	let added = false;
	try {
		const wt = gitRun(["worktree", "add", "--detach", scratch, branch]);
		if (wt.code !== 0)
			return {
				status: "error",
				detail: `worktree add failed: ${wt.out.trim().slice(0, 150)}`,
			};
		added = true;
		// the scratch tree shares the repo's node_modules (bun workspaces)
		const nm = join(repo, "node_modules");
		if (existsSync(nm) && !existsSync(join(scratch, "node_modules")))
			symlinkSync(nm, join(scratch, "node_modules"), "dir");
		// disable the change: reverse the full diff (drops the new tests too)…
		const patch = join(scratch, "proof.patch");
		await Bun.write(patch, gitRun(["diff", `main...${branch}`]).out);
		const rev = gitRun(["apply", "-R", "proof.patch"], scratch);
		if (rev.code !== 0)
			return {
				status: "error",
				detail: `reverse apply failed: ${rev.out.trim().slice(0, 150)}`,
			};
		// …then restore the new tests from the index (still at the branch tip)
		const back = gitRun(["checkout", "--", ...testFiles], scratch);
		if (back.code !== 0)
			return { status: "error", detail: "test restore failed" };
		// run the new tests without the change
		const p = Bun.spawn([process.execPath, "test", ...testFiles], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			cwd: scratch,
		});
		const timer = setTimeout(() => p.kill(), PROOF_TIMEOUT_MS);
		const [outText, errText] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
		]);
		clearTimeout(timer);
		await p.exited;
		const output = `${outText}\n${errText}`;
		if (/Cannot find (package|module)/.test(output))
			return { status: "error", detail: "scratch module resolution failed" };
		// the trailing bun summary is the machine-readable part
		const counts = (word: string): number => {
			const hits = [...output.matchAll(new RegExp(`(\\d+) ${word}\\b`, "g"))];
			return Number(hits.at(-1)?.[1] ?? -1);
		};
		const passed = counts("pass");
		const failed = counts("fail");
		if (failed < 0)
			return {
				status: "error",
				detail: `no bun test summary (exit ${p.exitCode})`,
			};
		return failed > 0
			? {
					status: "proved",
					detail: "new tests fail without the change",
					failed,
					passed,
				}
			: {
					status: "no-coverage",
					detail: "all new tests pass without the change",
					failed: 0,
					passed,
				};
	} finally {
		if (added) gitRun(["worktree", "remove", "--force", scratch]);
		rmSync(scratch, { recursive: true, force: true });
	}
}

// ---- verdict parse + emit ----------------------------------------------------
const emitCli = (args: string[]): void => {
	const p = Bun.spawnSync(
		[
			process.execPath,
			new URL("./coord.ts", import.meta.url).pathname,
			...args,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (p.exitCode !== 0)
		console.error(
			`review-lane: coord emit failed: ${p.stderr.toString().slice(0, 200)}`,
		);
};

const noteFor = (headline: string): string =>
	`review ${item} by ${executor} — ${headline}`;

const findings = await runLeg().catch((e: unknown) => {
	console.error(
		`review-lane ${item}: leg failed: ${e instanceof Error ? e.message : String(e)}`,
	);
	return null;
});

// verdict line: the LAST VERDICT: match wins (models restate headers)
const verdictLine = [
	...(findings ?? "").matchAll(/VERDICT: (PASS|FAIL[^\n]*)/g),
].at(-1)?.[1];
const verdict =
	findings && verdictLine
		? verdictLine.startsWith("PASS")
			? "PASS"
			: "FAIL"
		: "ERROR";
const reviewerHeadline = (
	verdictLine ?? (findings ? "no verdict line in reply" : "leg failed")
).slice(0, 300);

// Sinai proof gates the approval: a PASS stands only when the branch's new
// tests FAIL without the change — otherwise the verdict is downgraded, with
// the evidence annotating the headline.
const proof =
	verdict === "PASS" ? await coverageProof(`suspenders/${item}`) : null;
const proofHeadline =
	proof === null
		? ""
		: proof.status === "proved"
			? `coverage-proof: ${proof.failed} new test(s) fail without the change`
			: proof.status === "no-coverage"
				? "coverage-proof FAIL: all new tests pass without the change — no coverage"
				: `coverage-proof ${proof.status}: ${proof.detail}`;
const effective = proof?.status === "no-coverage" ? "FAIL" : verdict;
const headline = proofHeadline
	? `${proofHeadline} | ${reviewerHeadline}`
	: reviewerHeadline;
const proofNote = proof
	? `coverage-proof (${proof.status})${
			proof.failed === undefined
				? ""
				: ` [failed=${proof.failed} passed=${proof.passed ?? 0}]`
		}: ${proof.detail}`
	: "";
const factKey = `review.${item}.${executor}`;
db.query(
	"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'review-lane', 1, ?)",
).run(
	factKey,
	JSON.stringify({
		verdict: effective,
		headline,
		ts: Date.now(),
		coverage: proof ?? undefined,
	}),
	Date.now(),
);

// NOTE targeted at the owner (inbox push) + thread stamp (--work/--project
// land it on the drawer timeline); absent owner → coordinator or fleet-board
const owner = String(w.owner_sid ?? "");
const noteArgs = [
	"emit",
	"NOTE",
	"--to",
	owner ||
		String(
			(
				db
					.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
					.get() as { value: string } | null
			)?.value ?? "fleet-board",
		),
	"--note",
	noteFor(headline),
	`--work=${item}`,
	`--project=${project}`,
	"--as",
	`review:${executor}`,
];
emitCli(noteArgs);

// the verdict event: work.review, payload stamped work+project so the drawer
// timeline picks it up; the findings body rides the note (capped)
emitCli([
	"emit",
	"work.review",
	`--work=${item}`,
	`--project=${project}`,
	`--executor=${executor}`,
	`--verdict=${effective}`,
	"--note",
	`${headline}\n\n${proofNote}\n\n${(findings ?? "").slice(0, 3000)}`,
	"--as",
	`review:${executor}`,
]);
console.log(
	`review-lane: ${item} reviewed by ${executor} — ${effective}: ${headline.slice(0, 120)}`,
);
process.exit(effective === "ERROR" ? 2 : 0);
