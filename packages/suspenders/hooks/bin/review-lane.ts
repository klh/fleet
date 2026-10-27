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

import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addedWorkspaceDependencies,
	missingImportsExplained,
	type Proof,
	TEST_FILE,
} from "../lib/gates/coverage-proof.ts";
import { requestReviewLeg, reviewPrompt } from "../lib/gates/review-prompt.ts";
import {
	priorBlockingReviewLines,
	publishReviewReceipt,
	reviewContext,
	reviewFindingIds,
} from "../lib/gates/review-receipt.ts";
import {
	finishReviewRequest,
	reviewRequestKey,
} from "../lib/gates/review-scheduler.ts";
import { wireModelAudit } from "../lib/gates/wire-model-check.ts";
import { openStore, projectRootOf } from "../lib/govdb/govdb.ts";
import { resolveBelt } from "../lib/hub/belt-locate.ts";
import { branchForItem } from "../lib/lanes/item-branch.ts";
import {
	adminKey,
	BUCKLE_FRONT,
	mintLaneKey,
	revokeLaneKey,
} from "../lib/lanes/lane-auth.ts";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

// ---- args (W820: verb-kit owns parsing — W651 law) -------------------------
// W820: verb-kit owns parsing (W651 law) — reqFlags --item/--project; the
// kit usage line prints + exit 1 on violation; --help renders per-verb help.
const spec = defineVerb({
	name: "review",
	usage:
		"usage: bun review-lane.ts --item <Wn> --project <p> --executor <name> (--buckle <model> | --bin <path> | --belt <m>:<p>[:<model>] | --llm-url <url> [--llm-model <m>])",
	flags: [
		"--item",
		"--project",
		"--executor",
		"--bin",
		"--belt",
		"--llm-url",
		"--llm-model",
		"--buckle",
		"--request-key",
		"--request-token",
	],
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
const requestKey = parsedArgs.parsed.flag("--request-key");
const requestToken = parsedArgs.parsed.flag("--request-token");
if (Boolean(requestKey) !== Boolean(requestToken))
	throw new Error("scheduled review requires request key and token together");
const reviewFailureReason = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error))
		.replace(/\bbksk_[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
		.slice(0, 250);
const failedEarly = (error: unknown) => {
	if (requestKey && requestToken)
		finishReviewRequest(
			db,
			requestKey,
			requestToken,
			true,
			reviewFailureReason(error),
		);
	console.error(
		`review-lane: runner failed before a bound receipt (${reviewFailureReason(error)}); scheduled retry retained`,
	);
	process.exit(2);
};
process.on("uncaughtException", failedEarly);
process.on("unhandledRejection", failedEarly);
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
function gitDiff(base: string, commit: string): string {
	const result = gitRun(["diff", `${base}...${commit}`]);
	if (result.code !== 0 || result.out.length > 512_000)
		throw new Error(
			"review-lane: full exact diff unavailable or exceeds review budget; decompose before approval",
		);
	return result.out;
}

// the coord thread: last 20 events on the item (work + project stamped);
// W1236.1: each line also carries the event's note text (parsed from the
// payload JSON, capped) — prior review findings and their B-IDs live there,
// and a reviewer who cannot see them can never emit the RESOLVED lines the
// receipt contract demands.
const noteOf = (payload: unknown): string => {
	try {
		return String(
			(JSON.parse(String(payload)) as { note?: unknown }).note ?? "",
		).slice(0, 400);
	} catch {
		return "";
	}
};
const thread: string[] = (
	db
		.query(
			"SELECT ts, source, kind, payload FROM events WHERE work = ? AND project = ? ORDER BY id DESC LIMIT 20",
		)
		.all(item, project) as Row[]
).map((e) =>
	[
		new Date(Number(e.ts)).toISOString(),
		e.source,
		e.kind,
		String(e.payload).slice(0, 200),
		noteOf(e.payload),
	]
		.filter(Boolean)
		.join(" "),
);

// ---- the review prompt ------------------------------------------------------
// W1279: the review binds the item's CANONICAL branch — its own ref when it
// exists, else the kept child's parent-named branch (split --keep rebinds the
// tree's lane-context, not the branch) — never a blind suspenders/<item>.
const boundBranch = branchForItem(repo, item) ?? `suspenders/${item}`;
const boundContext = reviewContext(repo, boundBranch);
const priorBlocking = priorBlockingReviewLines(
	db,
	project,
	item,
	boundContext.commit,
);
if (requestKey && requestKey !== reviewRequestKey(project, item, boundContext))
	throw new Error("review context changed before scheduled runner started");
const diff = gitDiff(boundContext.base, boundContext.commit);
const reviewerSid = `review-${crypto.randomUUID()}`;
db.query(
	"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, 'reviewer', ?, ?, 'RUNNING')",
).run(reviewerSid, project, Date.now(), Date.now());
const prompt = reviewPrompt({
	item,
	repo,
	commit: boundContext.commit,
	base: boundContext.base,
	context: boundContext.text,
	title: String(w.title),
	description: w.description ? String(w.description) : "",
	state: String(w.state),
	owner: String(w.owner_sid ?? "none"),
	thread,
	priorBlocking,
	diff,
});

// ---- executor legs ----------------------------------------------------------
type Leg =
	| { kind: "buckle"; model: string }
	| { kind: "bin"; bin: string }
	| { kind: "belt"; target: string }
	| { kind: "llm"; url: string; model: string };
const leg: Leg | null = (() => {
	const buckle = parsedArgs.parsed.flag("--buckle");
	if (buckle) return { kind: "buckle", model: buckle };
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
// W1263: the SERVED wire model of the last OpenAI-wire leg attempt — receipts
// never recorded which upstream actually answered, so the review-leg route
// was untraceable from the receipt alone. Stamp it into the review fact.
let legWireModel: string | undefined;
// W1302.6 (O3): the model class this review REQUESTED (buckle/llm legs name
// one; bin legs do not). Held for the served-vs-requested assertion below.
const requestedModel =
	leg?.kind === "buckle" || leg?.kind === "llm"
		? leg.model
		: leg?.kind === "belt"
			? leg.target.split(":")[2] || undefined
			: undefined;
async function requestLlm(
	url: string,
	model: string,
	key?: string,
): Promise<string> {
	const reply = await requestReviewLeg({
		url,
		model,
		key,
		prompt,
		timeoutMs: LEG_TIMEOUT_MS,
		onWireModel: (wire) => {
			legWireModel = wire;
		},
	});
	return reply.text;
}
async function runLeg(): Promise<string> {
	if (leg?.kind === "buckle") {
		const admin = adminKey();
		if (!admin) throw new Error("Buckle review admin credential unavailable");
		const scoped = await mintLaneKey(reviewerSid, admin);
		if (!scoped) throw new Error("Buckle review scoped key mint refused");
		let result = "";
		let failed = false;
		let failure: unknown;
		try {
			result = await requestLlm(
				`${BUCKLE_FRONT}/w/${reviewerSid}/v1/chat/completions`,
				leg.model,
				scoped.key,
			);
		} catch (error) {
			failed = true;
			failure = error;
		}
		if (!(await revokeLaneKey(scoped.keyId, admin)))
			throw new Error("Buckle review scoped key revocation failed");
		if (failed) throw failure;
		return result;
	}
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
		return requestLlm(leg.url, leg.model, process.env.SUSPENDERS_LLM_KEY);
	}
	throw new Error("no executor leg (--buckle | --bin | --belt | --llm-url)");
}

// ---- coverage proof (W634, Sinai rule) --------------------------------------
// Before an approval stands, the change is DISABLED in a scratch checkout and
// the branch's new tests are run there: tests that pass without the change
// are out of scope or wrong, so a PASS with no failing new test is downgraded
// to FAIL. The evidence annotates the verdict.
// W1262: Proof/TEST_FILE and the missing-module classification live in
// hooks/lib/gates/coverage-proof.ts (unit face for the classifier).

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
	// W1262 (W1258 regression): reverse-applying the diff removes exactly the
	// modules the diff ADDED — a restored new test importing one fails right
	// there. That failure is the proof itself (the change is what provides the
	// module), so it must not classify as an environmental error; only missing
	// imports that resolve to NOTHING the diff added stay environmental.
	const addedProd = gitRun([
		"diff",
		"--name-only",
		"--diff-filter=A",
		`main...${branch}`,
	])
		.out.trim()
		.split("\n")
		.filter((f) => f && !TEST_FILE.test(f));
	const mergeBase = gitRun(["merge-base", "main", branch]).out.trim();
	const manifestPaths = [
		...new Set(
			testFiles
				.filter((path) => /^packages\/[^/]+\//.test(path))
				.map((path) => `${path.split("/").slice(0, 2).join("/")}/package.json`),
		),
	];
	const addedWorkspaceDeps = manifestPaths.flatMap((path) => {
		const before = gitRun(["show", `${mergeBase}:${path}`]);
		const after = gitRun(["show", `${branch}:${path}`]);
		return addedWorkspaceDependencies(
			before.code === 0 ? before.out : "{}",
			after.code === 0 ? after.out : "{}",
			path,
		);
	});

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
		if (/Cannot find (package|module)/.test(output)) {
			// W1262 (W1258 regression): a missing import that names a module the
			// diff ADDED means the reversed change is what provides the module —
			// the failure is the proof. Only an unexplained one is environmental.
			if (
				!missingImportsExplained(
					output,
					addedProd,
					testFiles,
					addedWorkspaceDeps,
					scratch,
				)
			)
				return {
					status: "error",
					detail: "scratch module resolution failed",
				};
		}
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

// verdict line: the LAST VERDICT: match wins (models restate headers)
const verdictLineOf = (reply: string | null): string | undefined =>
	reply
		? [...reply.matchAll(/VERDICT: (PASS|FAIL[^\n]*)/g)].at(-1)?.[1]
		: undefined;

// W1236: one leg attempt is not a verdict — 429 waves drain and thinking
// models sometimes reply without the machine-parseable line. Two bounded
// attempts with a short backoff before the ERROR receipt records why.
// W1236.1: findings ACCUMULATE across attempts — a retry that produces the
// verdict line must not silently erase substantive findings from the earlier
// attempt (FAIL60967: first reply carried a blocker, second was a bare PASS;
// the blocker vanished). Blocker IDs ride the combined text into the
// receipt, so a PASS over preserved blockers fails the contract check
// instead of landing clean.
const legParts: string[] = [];
let legFailure = "leg failed";
let verdictLine = verdictLineOf(null);
for (let legAttempt = 1; legAttempt <= 2; legAttempt++) {
	const attemptText = await runLeg().catch((e: unknown) => {
		legFailure = reviewFailureReason(e);
		console.error(
			`review-lane ${item}: leg attempt ${legAttempt} failed: ${e instanceof Error ? e.message : String(e)}`,
		);
		return null;
	});
	if (attemptText) legParts.push(attemptText);
	verdictLine = verdictLineOf(legParts.join("\n\n"));
	if (verdictLine || legAttempt === 2) break;
	await new Promise((resolve) => setTimeout(resolve, 20_000));
}
const findings = legParts.length ? legParts.join("\n\n") : null;
const verdict =
	findings && verdictLine
		? verdictLine.startsWith("PASS")
			? "PASS"
			: "FAIL"
		: "ERROR";
const reviewerHeadline = (
	verdictLine ?? (findings ? "no verdict line in reply" : legFailure)
).slice(0, 300);

// Sinai proof gates the approval: a PASS stands only when the branch's new
// tests FAIL without the change — otherwise the verdict is downgraded, with
// the evidence annotating the headline.
const proof = verdict === "PASS" ? await coverageProof(boundBranch) : null;
const proofHeadline =
	proof === null
		? ""
		: proof.status === "proved"
			? `coverage-proof: ${proof.failed} new test(s) fail without the change`
			: proof.status === "no-coverage"
				? "coverage-proof FAIL: all new tests pass without the change — no coverage"
				: `coverage-proof ${proof.status}: ${proof.detail}`;
// W1302.6 (O3): the receipt asserts the served wire model against the
// requested class. A mismatch can never land as a clean PASS — the W1278.1
// review was requested as glm-5.3-flash and served by chatgpt/gpt-6-sol.
const wireAudit = wireModelAudit(requestedModel, legWireModel);
const wireMismatch = wireAudit?.match === "mismatch" && verdict === "PASS";
const wireHeadline = wireMismatch
	? `wire-model mismatch: requested ${wireAudit?.requested} served ${wireAudit?.served} — PASS not trusted`
	: "";
const effective =
	verdict === "PASS" && wireMismatch
		? "FAIL"
		: proof?.status === "error"
			? "ERROR"
			: proof?.status === "no-coverage"
				? "FAIL"
				: verdict;
const headline = [wireHeadline, proofHeadline, reviewerHeadline]
	.filter(Boolean)
	.join(" | ");
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
		requested_model: requestedModel ?? null,
		wire_model: legWireModel ?? null,
		wire_match: wireAudit?.match ?? null,
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

// One bound work.review event; the board still reads its top-level verdict.
const { blocking, resolved } = reviewFindingIds(findings ?? "");
publishReviewReceipt(db, project, item, {
	version: 1,
	commit: boundContext.commit,
	base: boundContext.base,
	instructions: boundContext.instructions,
	reviewer: reviewerSid,
	verdict: effective,
	blocking,
	resolved,
	evidence: `${headline}\n${proofNote}\n${(findings ?? "").slice(0, 3000)}`,
	requested_model: requestedModel,
	wire_model: legWireModel,
});
db.query("UPDATE sessions SET state = 'DONE', hb = ? WHERE sid = ?").run(
	Date.now(),
	reviewerSid,
);
if (requestKey && requestToken)
	finishReviewRequest(
		db,
		requestKey,
		requestToken,
		effective === "ERROR",
		headline,
	);
console.log(
	`review-lane: ${item} reviewed by ${executor} — ${effective}: ${headline.slice(0, 120)}`,
);
process.exit(effective === "ERROR" ? 2 : 0);
