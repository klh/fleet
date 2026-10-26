// oracle.ts — W647: the named review/escalation tool. One stateless surface
// with a fixed prompt contract — review this diff / find bugs / analyze this —
// replacing ad-hoc "-review" phrasing in lane prompts. The default leg is
// PINNED to the :8903 reason tier (direct OpenAI-wire POST — never
// router-classified, never belt-role-dispatched); --cloud fires the stronger
// cloud route through the :4000 router's own escalation leg
// (belt/bin/escalate.ts — buckle-gate when BELT_ESCALATE_* is set, legacy
// settings.json creds otherwise), model glm-5.3. NO automatic stuck-detection
// routing: the tool never fires on its own — a lane or human invokes it,
// explicitly, every time.
// usage:
//   oracle review  [--in FILE | --repo DIR [--base REF]] [--cloud] [--max-tokens N]
//   oracle bugs    [--in FILE | --repo DIR [--base REF]] [--cloud] [--max-tokens N]
//   oracle analyze [--in FILE] [--cloud] [--max-tokens N] [topic words...]
// input: --in FILE, else piped stdin, else (review/bugs) the working-tree diff
// of --repo DIR (default cwd; staged + unstaged; --base REF diffs vs REF).
// stdout = the answer; stderr = one route line — parents parse stdout.
// env (config-over-code; defaults name the pinned fleet routes):
//   ORACLE_ROUTE_URL   default http://127.0.0.1:8903/v1/chat/completions
//   ORACLE_ROUTE_KEY   optional bearer for the pinned leg
//   ORACLE_ROUTE_MODEL optional model id (else GET /models probe, else "local")
// exit: 0 answer · 1 usage/input · 2 leg failure

import { REVIEW_FRAME } from "../lib/hub/oracle-frame.ts";
import type { PanelRow } from "../lib/hub/oracle-legs.ts";
import {
	buildPanelRows,
	cloudLeg,
	consensusOf,
	PANEL_FRAME,
	pinnedLeg,
} from "../lib/hub/oracle-legs.ts";
import type { VerbSpec } from "../lib/verb-kit.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

const argv = process.argv.slice(2);

type Verb = "review" | "bugs" | "analyze" | "panel";
const VERBS: Verb[] = ["review", "bugs", "analyze", "panel"];
const verb: Verb | null = VERBS.includes(argv[0] as Verb)
	? (argv[0] as Verb)
	: null;

// W820: parse rides verb-kit (W651) — kit owns flag consumption + the
// Bun-strips-`--` reality; lax keeps legacy unknown-flag tolerance. The
// embedded door keeps oracle's exit contract (0 answer · 1 usage · 2 leg).
const VALUE_FLAGS = [
	"--in",
	"--repo",
	"--base",
	"--max-tokens",
	"--timeout-secs",
];
const specFor = (v: Verb): VerbSpec =>
	defineVerb({
		name: v,
		usage: "usage: oracle <verb> [flags] [topic words] — try `oracle --help`",
		flags: VALUE_FLAGS,
		switches: ["--cloud", "--audit"],
		lax: true,
	});
const rest = verb ? argv.slice(1) : [];
if (rest.includes("--help") || rest.includes("-h")) {
	console.log(usageText());
	process.exit(0);
}
const outcome = verb ? parseVerb(specFor(verb), rest) : null;
if (outcome && !outcome.ok) usage();
const arg = (name: string): string | null =>
	outcome?.ok ? (outcome.parsed.flag(name) ?? null) : null;
const topic: string[] = outcome?.ok ? outcome.parsed.pos : [];

// the FIXED contract — three frames, never free-form; the final lines are
// machine-parseable (review's VERDICT matches review-lane.ts's parse).
// review rides the shared lib (W832 stable finding IDs — one source of
// truth with the arena arm-A pin).
const FRAMES: Record<Verb, string> = {
	review: REVIEW_FRAME,
	bugs: [
		"You are a read-only bug hunt (oracle fixed contract). Find bugs.",
		"Each bug one terse line — file:line — bug — severity(high|medium|low). Style nits are not bugs.",
		"End your reply with ONE machine-parseable final line:",
		"BUGS: none | BUGS: <n> found",
	].join("\n"),
	analyze: [
		"You are a read-only analyst (oracle fixed contract). Analyze this.",
		"Structured and terse — WHAT: one line · HOW: bullets · RISKS: bullets · OPEN QUESTIONS: bullets.",
	].join("\n"),
	panel: PANEL_FRAME,
};

const INPUT_CAP = 60_000;

function promptFor(what: Verb, input: string): string {
	const parts = [FRAMES[what]];
	if (what === "analyze" && topic.length > 0)
		parts.push(`FOCUS: ${topic.join(" ")}`);
	if (input.trim() !== "")
		parts.push(`${what === "review" ? "DIFF" : "INPUT"}:\n${input}`);
	return parts.join("\n\n");
}

// ---- input: --in | stdin (non-TTY) | working-tree diff ----------------------
const readStdin = async (): Promise<string> => {
	if (process.stdin.isTTY) return "";
	const chunks: string[] = [];
	for await (const chunk of process.stdin) chunks.push(String(chunk));
	return chunks.join("");
};

function gitDiffIn(repo: string, base: string | null): string {
	const run = (args: string[]): string => {
		const p = Bun.spawnSync(["/usr/bin/git", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		return p.stdout.toString();
	};
	if (run(["rev-parse", "--git-dir"]).trim() === "")
		throw new Error(`not a git repo: ${repo}`);
	if (base) return run(["diff", base]).slice(0, INPUT_CAP);
	return (run(["diff", "--cached"]) + run(["diff"])).slice(0, INPUT_CAP);
}

async function collectInput(): Promise<string> {
	const inFile = arg("--in");
	if (inFile) return Bun.file(inFile).text();
	const piped = await readStdin();
	if (piped !== "") return piped;
	if (verb === "analyze") return "";
	const repo = arg("--repo") ?? process.cwd();
	return gitDiffIn(repo, arg("--base"));
}

function usageText(): string {
	return [
		"usage: oracle <verb> [flags] [topic words]",
		"  review  review this diff — findings + final line VERDICT: PASS | VERDICT: FAIL - <reason>",
		"  bugs    find bugs — one line each + final line BUGS: none | BUGS: <n> found",
		"  analyze analyze this — WHAT/HOW/RISKS/OPEN QUESTIONS; bare topic words become FOCUS",
		"  panel   decision advisory — fans the fork to BOTH legs, marks AGREE/DISAGREE on the VERDICT lines; --audit meters route_audit",
		"input:  --in FILE | piped stdin | (review/bugs) --repo DIR working-tree diff (default cwd)",
		"flags:  --cloud (stronger cloud route, glm-5.3) · --max-tokens N (default 1500) · --timeout-secs N (default 300)",
		"env:    ORACLE_ROUTE_URL | ORACLE_ROUTE_KEY | ORACLE_ROUTE_MODEL (pinned leg, default :8903 local-reason)",
		"stateless: one request, one answer; no threads, no history, no auto-routing.",
	].join("\n");
}

function usage(): never {
	console.error(usageText());
	process.exit(1);
}

// best-effort route_audit metering — --audit opts in; the panel answers
// regardless of store health (stateless contract preserved).
const auditPanel = async (rows: PanelRow[]): Promise<void> => {
	if (!argv.includes("--audit")) return;
	try {
		const { openStore } = await import("../lib/govdb/govdb.ts");
		const store = openStore();
		for (const r of rows) {
			store
				.query(
					"INSERT INTO route_audit(rid, ts, actor, dialect, hint, resolved_target, decision, latency_class, error_code) VALUES (?,?,?,?,?,?,?,?,?)",
				)
				.run(
					crypto.randomUUID(),
					Date.now(),
					"oracle-panel",
					r.name === "cloud" ? "anthropic" : "openai",
					"panel",
					r.model,
					r.ok ? (r.verdict ?? "no-verdict") : "leg-failed",
					String(r.ms),
					r.error ?? null,
				);
		}
		store.close();
	} catch {
		// metering never breaks the answer
	}
};

// ---- main -------------------------------------------------------------------
if (verb === null) usage();
const cloud = argv.includes("--cloud");
const maxTokens = Number(arg("--max-tokens")) || 1500;
const timeoutMs = (Number(arg("--timeout-secs")) || 300) * 1000;

let input = "";
try {
	input = await collectInput();
} catch (e) {
	console.error(`oracle: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}
if (input.trim() === "" && !(verb === "analyze" && topic.length > 0)) {
	console.error(
		`oracle: no input for ${verb} — pipe a payload, pass --in FILE, or run inside a git repo`,
	);
	process.exit(1);
}

// W742.1: fan the fork question to both legs in parallel; mark agreement
// on the machine-parseable VERDICT lines; --audit meters route_audit.
if (verb === "panel") {
	const prompt = promptFor("panel", input);
	const settled = await Promise.allSettled([
		pinnedLeg(prompt, maxTokens, timeoutMs),
		cloudLeg(prompt, maxTokens),
	]);
	const rows = buildPanelRows(settled);
	const consensus = consensusOf(rows);
	for (const r of rows) {
		console.log(
			`— ${r.name} (${r.model}) ${r.ok ? `${r.ms}ms` : "FAILED"} — ${
				r.ok
					? r.verdict
						? r.verdict.toUpperCase()
						: "NO VERDICT"
					: "UNAVAILABLE"
			}${r.ok ? "" : `: ${r.error ?? ""}`}`,
		);
		if (r.text)
			console.log(r.text.length > 600 ? `${r.text.slice(0, 600)}\n…` : r.text);
	}
	console.log(`panel: ${consensus}`);
	await auditPanel(rows);
	process.exit(rows.some((r) => r.ok) ? 0 : 2);
}

try {
	const leg = cloud
		? await cloudLeg(promptFor(verb, input), maxTokens)
		: await pinnedLeg(promptFor(verb, input), maxTokens, timeoutMs);
	process.stdout.write(`${leg.text}\n`);
	console.error(
		`oracle: ${verb} route=${cloud ? "cloud" : "local-reason"} model=${leg.model} ms=${leg.ms}`,
	);
} catch (e) {
	console.error(`oracle: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(2);
}
