// review-lane.ts — W182 second-opinion runner. One-shot, detached, READ-ONLY
// (never claims the item): assembles the item's diff + thread as review
// context, asks the picked executor, parses the verdict line, and lands the
// findings: coord NOTE(s) on the item thread, a work.review verdict event,
// and fact review.<item>.<executor>. Works on DONE items — reviewing landed
// work is the point. Spawned by the board's POST /api/second-opinion.
// usage:
//   bun review-lane.ts --item <Wn> --project <p> --executor <name> \
//     (--buckle <model> | --bin <path>)
// exits 0 on a landed verdict, 2 on a failed leg (verdict=error recorded).
import { openStore, projectRootOf } from "../lib/govdb.ts";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";
import {
	reviewContext,
	publishReviewReceipt,
	reviewFindingIds,
} from "../lib/review-receipt.ts";
import {
	finishReviewRequest,
	reviewRequestKey,
} from "../lib/review-scheduler.ts";
import {
	TEST_FILE,
	missingImportsExplained,
	type Proof,
} from "../lib/coverage-proof.ts";
import {
	adminKey,
	BUCKLE_FRONT,
	mintLaneKey,
	revokeLaneKey,
} from "../lib/lane-auth.ts";

// ---- args (W820: verb-kit owns parsing — W651 law) -------------------------
// W820: verb-kit owns parsing (W651 law) — reqFlags --item/--project; the
// kit usage line prints + exit 1 on violation; --help renders per-verb help.
const spec = defineVerb({
	name: "review",
	usage:
		"usage: bun review-lane.ts --item <Wn> --project <p> --executor <name> (--buckle <model> | --bin <path>)",
	flags: [
		"--item",
		"--project",
		"--executor",
		"--bin",
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
		"usage: bun review-lane.ts --item <Wn> --project <p> --executor <name> (--buckle <model> | --bin <path>)",
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
		"review-lane: runner failed before a bound receipt; scheduled retry retained",
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
const boundContext = reviewContext(repo, `suspenders/${item}`);
if (requestKey && requestKey !== reviewRequestKey(project, item, boundContext))
	throw new Error("review context changed before scheduled runner started");
const diff = gitDiff(boundContext.base, boundContext.commit);
const reviewerSid = `review-${crypto.randomUUID()}`;
db.query(
	"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, 'reviewer', ?, ?, 'RUNNING')",
).run(reviewerSid, project, Date.now(), Date.now());
const prompt = [
	`You are a read-only second-opinion reviewer for Work Graph item ${item} in ${repo}.`,
	`Verify the work against the mission; you are auditing, NOT re-doing it. Do not edit anything.`,
	`REVIEWED COMMIT ${boundContext.commit}; INTEGRATION BASE ${boundContext.base}`,
	boundContext.text,
	``,
	// W1243.1.1 (FAIL62885): the old sentence implied the reviewer would see
	// proof output and the model refused PASS citing its absence. The ordering
	// is binding and must be unambiguous: the proof is harness-run AFTER the
	// provisional PASS; absent pre-verdict proof is not a finding.
	`PROOF ORDERING (Sinai rule, binding): the coverage proof is mechanical and runs in this harness, AFTER your verdict. You may emit a provisional PASS first; the harness then reverts the branch diff in a scratch checkout and requires the branch's new tests to fail there — tests that pass without the change downgrade the final verdict to FAIL.`,
	`No proof command or proof output appears in this prompt, by design. The absence of pre-verdict proof output is NOT a finding — do not open a blocker for missing coverage proof; fail-closed enforcement of the proof is the harness's job, not yours.`,
	`MISSION (work show):`,
	`${String(w.title)}${w.description ? ` — ${String(w.description)}` : ""}`,
	`state: ${String(w.state)}; owner: ${String(w.owner_sid ?? "none")}`,
	``,
	`ITEM THREAD (newest first, last 20):`,
	...(thread.length ? thread : ["(no events)"]),
	``,
	`EXACT BRANCH DIFF (${boundContext.base}...${boundContext.commit}):`,
	diff || "(no branch — review the thread/claims only)",
	``,
	`Report findings as terse bullets; every finding carries a stable ID — B<round>-<slug> (blocker) or N<round>-<slug> (note) — round = the round that FIRST reported it; IDs are never renumbered.`,
	`ID discipline (W1263): B-prefix = merge-blocking defect, N-prefix = advisory. NEVER label advisory content with a B-prefix — every B-ID you emit blocks the merge until a reviewer explicitly resolves it, and advisory B-IDs accumulate a blocking union across review rounds that starves the merge ladder. When in doubt, use N.`,
	`Review silently: do not announce next steps or ask to continue — your whole reply is findings bullets plus the verdict line.`,
	`Explicitly resolved prior findings use a separate line RESOLVED: B<round>-<slug> followed by evidence. Unresolved blocker IDs prevent merge even with a PASS final line.`,
	`Prior blocking IDs (W1263): when the ITEM THREAD shows earlier B-IDs for this exact commit, your reply must carry one line PER prior ID — either re-open it (state it as a finding bullet) or close it (RESOLVED: B<id> <one-line evidence>). A clean PASS with prior IDs silently absent is not a resolution and will be rejected by the receipt contract.`,
	`Evidence-kind caps severity: a file:line-only claim caps at blocker(high); a runtime-behavior claim without a trigger path caps at note(low).`,
	`End your reply with ONE machine-parseable final line:`,
	`VERDICT: PASS | VERDICT: FAIL - <reason>`,
].join("\n");

// ---- executor legs ----------------------------------------------------------
// W1119 decision.single-buckle-inference: the ONLY model leg is the gated
// Buckle client (scoped key minted per review, revoked after). --bin spawns
// an agent CLI — an agent runtime, not an inference call in this file. The
// retired --belt (belt route-to) and --llm-url (direct tier socket) legs
// carry no fallback: a review without Buckle refuses, fail-closed.
type Leg = { kind: "buckle"; model: string } | { kind: "bin"; bin: string };
const leg: Leg | null = (() => {
	const buckle = parsedArgs.parsed.flag("--buckle");
	if (buckle) return { kind: "buckle", model: buckle };
	const bin = parsedArgs.parsed.flag("--bin");
	if (bin) return { kind: "bin", bin };
	return null;
})();

// ---- run the leg ------------------------------------------------------------
const LEG_TIMEOUT_MS = 15 * 60_000;
// W1263: the SERVED wire model of the last OpenAI-wire leg attempt — receipts
// never recorded which upstream actually answered, so the review-leg route
// was untraceable from the receipt alone. Stamp it into the review fact.
let legWireModel: string | undefined;
async function requestLlm(
	url: string,
	model: string,
	key?: string,
): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(key ? { authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: prompt }],
			// W1236: glm-5.3-flash reasoning burned the whole 1500 budget before
			// any final text — HTTP 200 with content:"" — on every merge-ladder
			// receipt 2026-10-23. 8000 covers thinking headroom + the write-up.
			max_tokens: 8000,
			temperature: 0.2,
		}),
		signal: AbortSignal.timeout(LEG_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Review LLM HTTP ${response.status}`);
	const body = (await response.json()) as {
		model?: string;
		choices?: {
			finish_reason?: string;
			message?: {
				content?: string | null;
				reasoning_content?: string | null;
				reasoning?: string | null;
			};
		}[];
		usage?: { completion_tokens?: number };
	};
	// W1236: an HTTP 200 with empty content is a leg FAILURE — finish_reason
	// "length" means the thinking budget ate the completion. Returning "" here
	// is the opaque "leg failed" receipt (verdict ERROR, no diagnostics).
	// W1263: reasoning legs (GLM family) fill reasoning_content and can stop
	// with content:"" while usage.completion_tokens>0 — the review text rides
	// the reasoning field. Recovering it is diagnosis, not fabrication: the
	// verdict parse and the Sinai coverage proof still gate the verdict.
	const choice = body.choices?.[0];
	const msg = choice?.message;
	if (typeof body.model === "string" && body.model) legWireModel = body.model;
	const content = msg?.content ?? "";
	const reasoning = msg?.reasoning_content ?? msg?.reasoning ?? "";
	if (content.trim()) return content;
	if (reasoning.trim()) return reasoning;
	// W1263: BOTH fields empty = upstream empty (not parser loss). The throw
	// carries the SERVED wire model + full payload shape, so the ERROR receipt
	// self-describes the exact review-leg route for the operator.
	const wire = typeof body.model === "string" ? body.model : "unknown";
	throw new Error(
		`review leg returned empty content (model=${wire} finish_reason=${
			choice?.finish_reason ?? "unknown"
		}${
			body.usage?.completion_tokens === undefined
				? ""
				: `, completion_tokens=${body.usage.completion_tokens}`
		}, content_len=0, reasoning_len=0)`,
	);
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
		// W1119: retired — the belt route-to subprocess was an ungoverned
		// direct-tier path; the resolver emits --buckle <model> instead.
		throw new Error("belt leg retired (W1119 single-buckle-inference)");
	}
	if (leg?.kind === "llm") {
		// W1119: retired — no direct completion socket; the resolver emits
		// --buckle <model> instead.
		throw new Error("llm-url leg retired (W1119 single-buckle-inference)");
	}
	throw new Error("no executor leg (--buckle | --bin)");
}

// ---- coverage proof (W634, Sinai rule) --------------------------------------
// Before an approval stands, the change is DISABLED in a scratch checkout and
// the branch's new tests are run there: tests that pass without the change
// are out of scope or wrong, so a PASS with no failing new test is downgraded
// to FAIL. The evidence annotates the verdict.
// W1262: Proof/TEST_FILE and the missing-module classification live in
// hooks/lib/coverage-proof.ts (unit face for the classifier).

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
			if (!missingImportsExplained(output, addedProd, testFiles))
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
const effective =
	proof?.status === "error"
		? "ERROR"
		: proof?.status === "no-coverage"
			? "FAIL"
			: verdict;
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
		wire_model: legWireModel ?? null,
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
