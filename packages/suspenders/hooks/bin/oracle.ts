// oracle.ts — the fleet's named review/escalation oracle (the Amp M2 lift,
// W516): a stateless TOOL with a fixed prompt contract on a pinned strong
// route, replacing ad-hoc "please review" phrasing in lanes. Amp's oracle:
// a tool the main agent invokes deliberately for code review, bug-hunting
// and hard analysis, stateless (no memory between calls), on a separate
// stronger model. Docs: docs/research-ampcode.md §M2.
//
// Pinned strong route: belt /api/route role "reasoning" (the swarm's reason
// tier, chosen by belt's own metrics) — never the calling lane's flash
// route. SUSPENDERS_ORACLE_URL/MODEL override belt for a hub without one
// (config-over-code). Every call logs an llm.call telemetry event
// (source "oracle") so the routing log shows oracle usage.
//
// usage:
//   bun hooks/bin/oracle.ts review [--staged | --last <n> | <git-range>] [--max-chars n]
//   bun hooks/bin/oracle.ts ask "<hard analysis question>" [--context "<extra>"]
//
// Stateless by contract: one POST per invocation, no facts written, output
// to stdout only. The caller decides what to do with the answer.
import { spawnSync } from "node:child_process";
import { resolveBelt } from "../lib/belt-locate.ts";
import { openGovernorDb } from "../lib/govdb.ts";

const MAX_DIFF_CHARS = Number(
	process.env.SUSPENDERS_ORACLE_MAX_CHARS ?? 60_000,
);
const TIMEOUT_MS = 300_000;

type Msg = { role: "system" | "user"; content: string };

// the fixed prompt contract — the whole point of the lift: lanes stop
// phrasing review asks ad hoc and invoke a named tool whose contract is
// stable, terse and findings-shaped.
const REVIEW_SYS = `You are the oracle: a stateless code-review escalation for a coding-agent fleet. Contract: review the diff below for BUGS — correctness defects, broken invariants, state/race issues, security problems, API misuse. Report each finding exactly as:
N. <file>:<line> — <one-line what>
   why: <why it is wrong, one sentence>
Only defects arguable from the diff itself. No style nits, no praise, no summary of what the diff does. Last line: FINDINGS: <n>. Zero findings: print CLEAN and FINDINGS: 0.`;

const ASK_SYS = `You are the oracle: a stateless analysis escalation for a coding-agent fleet. Answer the question decisively and tersely, grounded ONLY in the provided context and your own knowledge of the named code. State uncertainty explicitly. No filler, no restating the question.`;

function die(m: string): never {
	console.error(`oracle: ${m}`);
	process.exit(2);
}

const git = (args: string[]): string => {
	const p = spawnSync("git", args, { encoding: "utf8" });
	if (p.status !== 0 || p.stdout === undefined)
		die(
			`git ${args.join(" ")} failed: ${(p.stderr ?? "").trim().slice(0, 200)}`,
		);
	return p.stdout ?? "";
};

function collectDiff(rest: string[]): string {
	const staged = rest.includes("--staged");
	const lastIdx = rest.indexOf("--last");
	const ctxIdx = rest.indexOf("--context");
	const specIdx = rest.findIndex(
		(a, i) =>
			!a.startsWith("--") &&
			i !== lastIdx + 1 &&
			i !== ctxIdx + 1 &&
			!["review", "ask"].includes(a),
	);
	const args = staged
		? ["diff", "--cached"]
		: lastIdx >= 0
			? ["diff", `HEAD~${rest[lastIdx + 1] ?? 1}`]
			: specIdx >= 0
				? ["diff", rest[specIdx]]
				: ["diff", "HEAD"];
	const diff = git(args);
	if (!diff.trim())
		die(`no diff for ${args.slice(1).join(" ")} — nothing to review`);
	if (diff.length > MAX_DIFF_CHARS)
		return `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated at ${MAX_DIFF_CHARS} chars — narrower --path or range for the rest)`;
	return diff;
}

/** One oracle round-trip. Belt /api/route first (the pinned strong route);
 *  SUSPENDERS_ORACLE_URL is the direct fallback for hub-less machines. */
async function consultOracle(
	msgs: Msg[],
): Promise<{ text: string; model: string; host: string; ms: number }> {
	const loc = await resolveBelt();
	if (loc) {
		try {
			const t0 = Date.now();
			const r = await fetch(`${loc.url}/api/route`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(loc.token ? { authorization: `Bearer ${loc.token}` } : {}),
				},
				body: JSON.stringify({
					role: "reasoning", // pinned strong route — never the lane's own tier
					execute: true,
					temperature: 0.2,
					max_tokens: 1500,
					messages: msgs,
				}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (r.ok) {
				const j = (await r.json()) as {
					reply?: string;
					target?: { model?: string; machine?: string };
					ms?: number;
				};
				if (j.reply)
					return {
						text: j.reply,
						model: j.target?.model ?? "belt",
						host: `belt(${j.target?.machine ?? "?"})`,
						ms: j.ms ?? Date.now() - t0,
					};
			}
		} catch {
			// belt unreachable/down — fall through to the direct route
		}
	}
	const url = process.env.SUSPENDERS_ORACLE_URL;
	if (!url)
		die(
			"no oracle route: belt unreachable and SUSPENDERS_ORACLE_URL unset — a strong route is the contract, never a flash fallback",
		);
	const t0 = Date.now();
	// SUSPENDERS_ORACLE_URL is the FULL chat-completions endpoint (same
	// semantics as advise.ts's SUSPENDERS_LLM_URL)
	try {
		const r = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(process.env.SUSPENDERS_ORACLE_KEY
					? { authorization: `Bearer ${process.env.SUSPENDERS_ORACLE_KEY}` }
					: {}),
			},
			body: JSON.stringify({
				model: process.env.SUSPENDERS_ORACLE_MODEL ?? "local",
				messages: msgs,
				temperature: 0.2,
				max_tokens: 1500,
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!r.ok)
			die(`oracle route ${r.status}: ${(await r.text()).slice(0, 200)}`);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const text = j.choices?.[0]?.message?.content ?? "";
		if (!text) die("oracle returned an empty answer");
		return {
			text,
			model: process.env.SUSPENDERS_ORACLE_MODEL ?? "local",
			host: new URL(url).host,
			ms: Date.now() - t0,
		};
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("oracle ")) die(e.message);
		die(
			`oracle fallback route failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

function logTelemetry(
	forWhat: string,
	out: { model: string; host: string; ms: number },
): void {
	try {
		openGovernorDb()
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'oracle', 'llm.call', NULL, ?, NULL)",
			)
			.run(
				Date.now(),
				JSON.stringify({
					for: forWhat,
					model: out.model,
					host: out.host,
					pt: 0,
					ct: 0,
					tt: 0,
					ms: out.ms,
				}),
			);
	} catch {
		// telemetry must never break the oracle answer
	}
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "review" && cmd !== "ask")
	die(
		'usage: oracle.ts review [--staged|--last <n>|<range>] | ask "<question>" [--context "<extra>"]',
	);

let msgs: Msg[];
if (cmd === "review") {
	const diff = collectDiff(rest);
	const ctxIdx = rest.indexOf("--context");
	const extra = ctxIdx >= 0 ? String(rest[ctxIdx + 1] ?? "") : "";
	msgs = [
		{ role: "system", content: REVIEW_SYS },
		{
			role: "user",
			content: `REVIEW THIS DIFF${extra ? ` — focus: ${extra}` : ""}:\n${diff}`,
		},
	];
} else {
	const q = rest.find((a) => !a.startsWith("--"));
	if (!q) die('usage: oracle.ts ask "<question>" [--context "<extra>"]');
	const ctxIdx = rest.indexOf("--context");
	const extra = ctxIdx >= 0 ? String(rest[ctxIdx + 1] ?? "") : "";
	msgs = [
		{ role: "system", content: ASK_SYS },
		{
			role: "user",
			content: `QUESTION: ${q}${extra ? `\n\nCONTEXT:\n${extra}` : ""}`,
		},
	];
}

const out = await consultOracle(msgs);
logTelemetry(cmd, out);
console.log(out.text);
console.log(`\n[oracle] ${out.model} @ ${out.host} · ${out.ms}ms`);
