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
import { escalate, resolveEscalationLeg } from "../../../belt/bin/escalate.ts";
import type { AnthropicBody } from "../../../belt/bin/router-core.ts";

const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
	const i = argv.indexOf(name);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
};

type Verb = "review" | "bugs" | "analyze";
const VERBS: Verb[] = ["review", "bugs", "analyze"];
const verb: Verb | null = VERBS.includes(argv[0] as Verb)
	? (argv[0] as Verb)
	: null;

// positionals = non-flag args minus flag-value pairs (analyze topic words)
const VALUE_FLAGS = new Set([
	"--in",
	"--repo",
	"--base",
	"--max-tokens",
	"--timeout-secs",
]);
const topic: string[] = [];
for (let i = 1; i < argv.length; i++) {
	const a = argv[i];
	if (a === undefined) break;
	if (VALUE_FLAGS.has(a)) {
		i++;
		continue;
	}
	if (a.startsWith("--")) continue;
	topic.push(a);
}

// the FIXED contract — three frames, never free-form; the final lines are
// machine-parseable (review's VERDICT matches review-lane.ts's parse)
const FRAMES: Record<Verb, string> = {
	review: [
		"You are a read-only reviewer (oracle fixed contract). Review this diff.",
		"Audit, never re-do. Findings as terse bullets — severity(high|medium|low): file:line — issue. No style nits.",
		"End your reply with ONE machine-parseable final line:",
		"VERDICT: PASS | VERDICT: FAIL - <reason>",
	].join("\n"),
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

// ---- the pinned route (default) --------------------------------------------
const ROUTE_URL =
	process.env.ORACLE_ROUTE_URL ?? "http://127.0.0.1:8903/v1/chat/completions";
const ROUTE_KEY = process.env.ORACLE_ROUTE_KEY;
const ROUTE_MODEL = process.env.ORACLE_ROUTE_MODEL;

// no model configured → ask the endpoint what it serves (first entry); works
// for the MLX server, llama.cpp, vLLM, or any OpenAI-compatible shim
const legModel = async (): Promise<string> => {
	if (ROUTE_MODEL) return ROUTE_MODEL;
	try {
		const r = await fetch(
			ROUTE_URL.replace(/\/chat\/completions$/, "/models"),
			{
				headers: ROUTE_KEY ? { authorization: `Bearer ${ROUTE_KEY}` } : {},
				signal: AbortSignal.timeout(5000),
			},
		);
		const j = (await r.json()) as { data?: { id: string }[] };
		return j.data?.[0]?.id ?? "local";
	} catch {
		return "local";
	}
};

type LegResult = { text: string; model: string; ms: number };

const pinnedLeg = async (
	prompt: string,
	maxTokens: number,
	timeoutMs: number,
): Promise<LegResult> => {
	const model = await legModel();
	const t0 = Date.now();
	const r = await fetch(ROUTE_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(ROUTE_KEY ? { authorization: `Bearer ${ROUTE_KEY}` } : {}),
		},
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "system",
					content:
						"You are oracle — a stateless escalation surface. One request, one answer.",
				},
				{ role: "user", content: prompt },
			],
			max_tokens: maxTokens,
			temperature: 0.2,
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!r.ok)
		throw new Error(`route ${r.status}: ${(await r.text()).slice(0, 200)}`);
	const j = (await r.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	const text = (j.choices?.[0]?.message?.content ?? "").trim();
	if (text === "") throw new Error("route answered with no content");
	return { text, model, ms: Date.now() - t0 };
};

// ---- the cloud escalation leg (--cloud) — the :4000 router's own leg -------
const cloudLeg = async (
	prompt: string,
	maxTokens: number,
): Promise<LegResult> => {
	const leg = await resolveEscalationLeg(process.env);
	if (!leg)
		throw new Error(
			"no cloud leg configured — set BELT_ESCALATE_URL/KEY (or legacy settings.json creds)",
		);
	const body: AnthropicBody = { messages: [{ role: "user", content: prompt }] };
	const t0 = Date.now();
	const r = await escalate(body, { maxTokens, wantFast: false });
	const text = r.text.trim();
	if (text === "")
		throw new Error(
			`cloud leg ${leg.mode} returned no text (status ${r.status ?? "?"})${
				r.retryAfterMs ? ` — retry-after ${r.retryAfterMs}ms` : ""
			}`,
		);
	return { text, model: r.model, ms: Date.now() - t0 };
};

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

function usage(): never {
	console.error(
		[
			"usage: oracle <verb> [flags] [topic words]",
			"  review  review this diff — findings + final line VERDICT: PASS | VERDICT: FAIL - <reason>",
			"  bugs    find bugs — one line each + final line BUGS: none | BUGS: <n> found",
			"  analyze analyze this — WHAT/HOW/RISKS/OPEN QUESTIONS; bare topic words become FOCUS",
			"input:  --in FILE | piped stdin | (review/bugs) --repo DIR working-tree diff (default cwd)",
			"flags:  --cloud (stronger cloud route, glm-5.3) · --max-tokens N (default 1500) · --timeout-secs N (default 300)",
			"env:    ORACLE_ROUTE_URL | ORACLE_ROUTE_KEY | ORACLE_ROUTE_MODEL (pinned leg, default :8903 local-reason)",
			"stateless: one request, one answer; no threads, no history, no auto-routing.",
		].join("\n"),
	);
	process.exit(1);
}

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
