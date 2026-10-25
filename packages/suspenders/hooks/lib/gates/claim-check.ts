// hooks/lib/gates/claim-check.ts — W833: the done-gate claim-check probe. Lanes
// assert test outcomes in prose ("all tests green") and in the final
// capsule; this probe makes those claims evidence-bearing: a passing test
// run must exist in the lane transcript BEFORE the claim, no test-affecting
// file may have changed after the last passing run (mtime as the
// cost-bounded proxy for the hash check — no suite rerun), and the closing
// diff must not delete tests, add focused/expected-failure gates, or loosen
// assertions. Added skip/only/todo gates ride the W511 fake-completion scan
// in the same gate and are not repeated here. Detection vocabulary is
// assembled from split string parts so the W511 scan never flags this
// file's own source.
//
// W917 origin gate: run events come ONLY from results of test invocations
// the session's own assistant initiated (tool_use id pairing + the paired
// command must BE a test run). Counts relayed from other sessions — WS
// inbox dumps and task notifications — pair to nothing this session
// called, so they never satisfy a claim.
//
// Fail-open: an unreadable/absent transcript yields no transcript claims
// (capsule text still counts), untimestamped events are dropped, and stat
// failures skip a path. Completion callers cannot disable this evidence check.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** transcript scan window — bounded tail, never the unbounded file. */
export const CLAIM_CHECK_SCAN_BYTES = 8 * 1024 * 1024;
/** mtime grace after the last passing run (post-test formatting lands here). */
export const CLAIM_CHECK_GRACE_MS = 120_000;

const assemble = (...parts: string[]): string => parts.join("");

// claim vocabulary — assistant prose only; briefs and user turns never claim
const CLAIM_RES: RegExp[] = [
	/\b(?:all\s+)?tests?\s+(?:pass|passed|passing|green)\b/i,
	/\btests?\s+are\s+(?:passing|green)\b/i,
	/\bsuite\s+(?:is\s+)?(?:green|passing)\b/i,
];
const NEG_PRE =
	/\b(?:no|not|never|without|cannot|didn't|doesn't|won't|can't)\b[^.]*$/i;
const RUN_PASS = /(\d+)\s+pass(?:ed)?\b/i;
const RUN_FAIL = /(\d+)\s+fail(?:ed|ure)?\b/i;
// W917 origin gate: a run event is the output of a test invocation the
// session's own assistant initiated — the paired tool_use command must BE
// a test run. Relayed counts from other sessions (WS-inbox dumps, task
// notifications) ride no such call, so they never count. Assembled from
// parts so this file's own source never trips the W511 scan.
const TEST_CMD_RE = new RegExp(
	assemble(
		"\\b(?:bun|npm|yarn|pnpm)\\s+(?:run\\s+)?(?:--?[a-z-]+\\s+)*",
		"test\\b|\\bvitest\\b|\\bjest\\b|\\bnode\\s+--test\\b|\\bcargo\\s+",
		"test\\b|\\bgo\\s+test\\b|\\bpytest\\b",
	),
	"i",
);
const CODEX_TEST_START =
	/^(?:bun|npm|yarn|pnpm)\s+(?:run\s+)?test\b|^(?:vitest|jest|pytest)\b|^node\s+--test\b|^cargo\s+test\b|^go\s+test\b/i;

/** The Codex functions.exec script must directly invoke one test command.
 * A relayed inbox message or a script that merely mentions "bun test" is
 * not execution evidence. Reject shell chaining and computed commands. */
const codexInitiatedTest = (source: string): boolean => {
	const calls = [
		...source.matchAll(
			/tools\.exec_command\(\s*\{\s*cmd\s*:\s*("(?:\\.|[^"\\])*")/g,
		),
	];
	if (calls.length !== 1) return false;
	let command: string;
	try {
		command = JSON.parse(calls[0]?.[1] ?? "") as string;
	} catch {
		return false;
	}
	return CODEX_TEST_START.test(command.trim()) && !/[;&|`]/.test(command);
};

/** a test-pass claim in lane prose (negations in the preceding window void it). */
export const isClaim = (text: string): boolean =>
	CLAIM_RES.some((re) => {
		const m = re.exec(text);
		if (!m) return false;
		const at = m.index ?? 0;
		return !NEG_PRE.test(text.slice(Math.max(0, at - 40), at));
	});

/** pass/fail counts from a test-summary tool output (bun/jest/vitest sums). */
export const runCounts = (
	text: string,
): { pass: number; fail: number } | null => {
	const p = RUN_PASS.exec(text);
	const f = RUN_FAIL.exec(text);
	if (!p && !f) return null;
	return { pass: p ? Number(p[1]) : 0, fail: f ? Number(f[1]) : 0 };
};

export const isPassingRun = (text: string): boolean => {
	const c = runCounts(text);
	return c !== null && c.pass > 0 && c.fail === 0;
};

export interface ClaimEvent {
	ts: number;
	text: string;
}
export interface TranscriptEvents {
	claims: ClaimEvent[];
	runs: ClaimEvent[];
}

type ContentPart = {
	type?: unknown;
	text?: unknown;
	content?: unknown;
	id?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
};

const toolResultText = (c: ContentPart): string => {
	if (typeof c.content === "string") return c.content;
	if (!Array.isArray(c.content)) return "";
	return c.content
		.map((p: unknown) => {
			const part = p as ContentPart;
			return typeof part?.text === "string" ? part.text : "";
		})
		.join("\n");
};

/** Extract claim events (assistant prose only) and run events (only from
 *  results of assistant-initiated test invocations — W917 origin gate) from
 *  transcript JSONL text. Untimestamped lines drop. */
export function transcriptEventsFromText(text: string): TranscriptEvents {
	const out: TranscriptEvents = { claims: [], runs: [] };
	const keep = (ev: ClaimEvent, into: ClaimEvent[]): void => {
		if (ev.ts > 0) into.push(ev);
	};
	// W917 origin gate: tool_use id → did this session's own assistant ask
	// for a test run? Only results of such calls become run events;
	// unpaired or non-test results are foreign noise and drop.
	const initiated = new Map<string, boolean>();
	const codexInitiated = new Map<string, boolean>();
	for (const lineOf of text.split("\n")) {
		if (lineOf.length < 2) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(lineOf) as Record<string, unknown>;
		} catch {
			continue;
		}
		const ts = Date.parse(String(obj.timestamp ?? "")) || 0;
		const payload = obj.payload as Record<string, unknown> | undefined;
		if (obj.type === "response_item" && payload) {
			if (payload.type === "custom_tool_call" && payload.name === "exec") {
				const id = payload.call_id;
				if (typeof id === "string")
					codexInitiated.set(
						id,
						typeof payload.input === "string" &&
							codexInitiatedTest(payload.input),
					);
			} else if (payload.type === "custom_tool_call_output") {
				const id = payload.call_id;
				if (typeof id === "string" && codexInitiated.get(id)) {
					const parts = payload.output;
					if (Array.isArray(parts)) {
						const content = parts
							.map((part: unknown) =>
								part &&
								typeof part === "object" &&
								typeof (part as ContentPart).text === "string"
									? (part as ContentPart).text
									: "",
							)
							.join("\n");
						if (content.includes("Script completed") && runCounts(content))
							keep({ ts, text: content }, out.runs);
					}
				}
			} else if (payload.type === "message" && payload.role === "assistant") {
				const parts = payload.content;
				if (Array.isArray(parts))
					for (const part of parts as ContentPart[])
						if (
							part?.type === "output_text" &&
							typeof part.text === "string" &&
							isClaim(part.text)
						)
							keep({ ts, text: part.text }, out.claims);
			}
			continue;
		}
		const msg = obj.message as
			| { role?: unknown; content?: unknown }
			| undefined;
		const assistant = msg?.role === "assistant" || obj.type === "assistant";
		const content = msg?.content;
		let paired = false;
		// sweep 1 (W917 origin gate): register the assistant's own tool_use
		// ids and whether each command WAS a test invocation.
		if (Array.isArray(content) && assistant)
			for (const c of content as ContentPart[]) {
				if (!c || typeof c !== "object") continue;
				if (c.type !== "tool_use") continue;
				const id = typeof c.id === "string" ? c.id : "";
				const cmd = (c.input as { command?: unknown } | undefined)?.command;
				initiated.set(id, typeof cmd === "string" && TEST_CMD_RE.test(cmd));
			}
		if (Array.isArray(content))
			for (const c of content as ContentPart[]) {
				if (!c || typeof c !== "object") continue;
				if (c.type === "tool_result") {
					const id = typeof c.tool_use_id === "string" ? c.tool_use_id : "";
					if (!id || !initiated.get(id)) continue; // foreign: drop
					paired = true;
					const t = toolResultText(c);
					if (t && runCounts(t)) keep({ ts, text: t }, out.runs);
				} else if (
					assistant &&
					c.type === "text" &&
					typeof c.text === "string" &&
					isClaim(c.text)
				)
					keep({ ts, text: c.text }, out.claims);
			}
		const tur = obj.toolUseResult as unknown;
		const turTexts: string[] = [];
		if (typeof tur === "string") turTexts.push(tur);
		else if (tur && typeof tur === "object")
			for (const k of ["stdout", "stderr"] as const) {
				const v = (tur as Record<string, unknown>)[k];
				if (typeof v === "string") turTexts.push(v);
			}
		if (paired)
			for (const turText of turTexts)
				if (runCounts(turText)) keep({ ts, text: turText }, out.runs);
	}
	return out;
}

/** Bounded tail of a transcript file (last cap bytes, aligned to a line
 *  start). Null on any failure — callers fail open. */
export function transcriptWindow(
	path: string,
	cap = CLAIM_CHECK_SCAN_BYTES,
): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - cap);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, size - start, start);
		let s = buf.toString("utf8");
		if (start > 0) {
			const nl = s.indexOf("\n");
			if (nl >= 0) s = s.slice(nl + 1);
		}
		return s;
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

export interface ClaimCheckHit {
	kind: string;
	path: string;
	line: number;
	text: string;
}

const TEST_FILE =
	/(?:^|[/\\])(?:tests?|e2e|spec|__tests__)[/\\]|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_CALL_NAME = new RegExp(
	assemble(
		"\\b(",
		"describe|it|test",
		")\\s*\\(\\s*([\"'`])([^\"'`]{1,160}?)\\2",
	),
);
const XFAIL_RE = new RegExp(
	assemble(
		"\\.fai",
		"ling\\s*\\(|\\bf(",
		"it|describe",
		")\\s*\\(|\\bxfa",
		"il\\b",
	),
	"i",
);
const STRICT_RE =
	/\.(?:toBe|toBeNull|toBeUndefined|toEqual|toStrictEqual|toMatchObject|toMatchSnapshot|toContain|toHaveLength)\s*\(/;
const LOOSE_RE = /\.(?:toBeTruthy|toBeFalsy|toBeDefined)\s*\(/;
const ASSERTION_CALL_RE = /\b(?:expect|assert)\s*\(/g;
const VACUOUS_ASSERTION_RE =
	/\bexpect\s*\(\s*(?:true|false|null|undefined|\d+|["'`][^"'`]*["'`])\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(/;
const META_PATH =
	/^((?:\.fleet|\.claude|\.agents|node_modules)[/\\]|\.klh-(?:brief|done)\.md$|\.workgraph\.jsonl$)/;
const DOC_PATH = /\.(?:md|markdown|txt)$/i;

/** test-affecting: code a test run could observe; meta dirs and prose docs
 *  never are. */
export const testAffectingPath = (path: string): boolean =>
	!META_PATH.test(path) && !DOC_PATH.test(path);

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? /;
const stripAB = (raw: string): string =>
	raw
		.split("\t")[0]
		?.replace(/^"[ab]\//, "")
		.replace(/^[ab]\//, "")
		.replace(/"$/, "") ?? "";

/** Scan the unified diff (-U0) of the closing window for test-suite erosion:
 *  deleted test calls whose name is not re-added elsewhere in the diff
 *  (moves pass), added focused/expected-failure gates, and test files where
 *  strict assertions were removed while only loose ones were added. */
export function scanClosingDiff(diff: string): ClaimCheckHit[] {
	const hits: ClaimCheckHit[] = [];
	const removedCalls: {
		name: string;
		path: string;
		line: number;
		text: string;
		hunk: number;
	}[] = [];
	const addedNames = new Set<string>();
	const hunks: {
		addedNames: string[];
		removedNames: string[];
		addedAssertions: number;
		removedAssertions: number;
		addedStrict: number;
		removedStrict: number;
		vacuousAddition: boolean;
	}[] = [];
	let currentHunk = -1;
	let path = "";
	let delPath = "";
	let isTest = false;
	let rmLine = 0;
	let addLine = 0;
	let strictRemoved = 0;
	let strictAdded = 0;
	let looseFirst: { line: number; text: string } | null = null;
	const push = (kind: string, p: string, line: number, text: string): void => {
		if (hits.length < 200)
			hits.push({ kind, path: p, line, text: text.trim().slice(0, 160) });
	};
	const flush = (): void => {
		if (isTest && strictRemoved > strictAdded && looseFirst && path)
			push("loosened-assertion", path, looseFirst.line, looseFirst.text);
		isTest = false;
		strictRemoved = 0;
		strictAdded = 0;
		looseFirst = null;
	};
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			flush();
			path = "";
			delPath = "";
			continue;
		}
		if (raw.startsWith("--- ")) {
			delPath = stripAB(raw.slice(4));
			continue;
		}
		if (raw.startsWith("+++ ")) {
			const target = raw.slice(4).split("\t")[0] ?? "";
			path = target === "/dev/null" ? delPath : stripAB(target);
			isTest = !!path && TEST_FILE.test(path) && testAffectingPath(path);
			continue;
		}
		const hunk = HUNK.exec(raw);
		if (hunk) {
			rmLine = Number(hunk[1]);
			addLine = Number(hunk[2]);
			currentHunk =
				hunks.push({
					addedNames: [],
					removedNames: [],
					addedAssertions: 0,
					removedAssertions: 0,
					addedStrict: 0,
					removedStrict: 0,
					vacuousAddition: false,
				}) - 1;
			continue;
		}
		if (raw.startsWith("+")) {
			const t = raw.slice(1);
			if (isTest) {
				const h = hunks[currentHunk];
				const name = TEST_CALL_NAME.exec(t);
				if (name?.[3]) {
					addedNames.add(name[3]);
					h?.addedNames.push(name[3]);
				}
				if (XFAIL_RE.test(t)) push("xfail-gate", path, addLine, t);
				if (h) {
					h.addedAssertions += [...t.matchAll(ASSERTION_CALL_RE)].length;
					if (VACUOUS_ASSERTION_RE.test(t)) h.vacuousAddition = true;
				}
				if (STRICT_RE.test(t)) {
					strictAdded++;
					if (h) h.addedStrict++;
				}
				if (LOOSE_RE.test(t) && !looseFirst)
					looseFirst = { line: addLine, text: t };
			}
			addLine++;
			continue;
		}
		if (raw.startsWith("-")) {
			const t = raw.slice(1);
			if (isTest) {
				const h = hunks[currentHunk];
				const name = TEST_CALL_NAME.exec(t);
				if (name?.[3]) {
					removedCalls.push({
						name: name[3],
						path,
						line: rmLine,
						text: t,
						hunk: currentHunk,
					});
					h?.removedNames.push(name[3]);
				}
				if (h) h.removedAssertions += [...t.matchAll(ASSERTION_CALL_RE)].length;
				if (STRICT_RE.test(t)) {
					strictRemoved++;
					if (h) h.removedStrict++;
				}
			}
			rmLine++;
			continue;
		}
		if (raw.startsWith("\\")) continue;
		rmLine++;
		addLine++;
	}
	flush();
	const replacementsUsed = new Map<number, number>();
	for (const c of removedCalls) {
		if (addedNames.has(c.name)) continue;
		const h = hunks[c.hunk];
		const available =
			h?.addedNames.filter((name) => !h.removedNames.includes(name)).length ??
			0;
		const used = replacementsUsed.get(c.hunk) ?? 0;
		const preservesAssertions =
			!!h &&
			h.addedAssertions >= h.removedAssertions &&
			h.addedStrict >= h.removedStrict &&
			!h.vacuousAddition;
		if (used < available && preservesAssertions) {
			replacementsUsed.set(c.hunk, used + 1);
			continue;
		}
		push("deleted-test", c.path, c.line, c.text);
	}
	return hits;
}

export type ClaimCheckVerdict = { ok: boolean; why?: string };

const statMtime = (p: string): number | null => {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return null;
	}
};

/** The done-gate verdict (W833): a test-pass claim needs a passing own run
 *  by closure. A later run can correct an unsupported interim claim, but a
 *  final capsule claim must follow its evidence. Test-affecting files must
 *  remain unchanged after that run, and the closing
 *  diff free of suite erosion. Fails open on missing/unreadable evidence;
 *  Completion evidence is mandatory, independent of the caller's environment. */
export const claimCheckVerdict = (o: {
	transcriptPath?: string;
	transcriptText?: string;
	capsuleDone?: string;
	capsuleTs?: number;
	/** Only this item's current claim epoch may provide prose or run evidence. */
	claimStartedAt?: number;
	paths: string[];
	diffText: string;
	statRoot?: string;
	now?: number;
	scanBytes?: number;
	graceMs?: number;
}): ClaimCheckVerdict => {
	const diffHits = scanClosingDiff(o.diffText);
	if (diffHits.length)
		return {
			ok: false,
			why:
				`claim-check (W833): closing diff erodes the test suite (${diffHits.length}):\n` +
				diffHits
					.slice(0, 10)
					.map((h) => `  ${h.path}:${h.line} [${h.kind}] ${h.text}`)
					.join("\n") +
				(diffHits.length > 10 ? `\n  … ${diffHits.length - 10} more` : "") +
				"\nRetain the claim and correct the attributed diff or evidence before completing.",
		};
	const text =
		o.transcriptText ??
		(o.transcriptPath ? transcriptWindow(o.transcriptPath, o.scanBytes) : null);
	const events = text
		? transcriptEventsFromText(text)
		: { claims: [], runs: [] };
	const started = o.claimStartedAt ?? 0;
	const claims = events.claims.filter((event) => event.ts >= started);
	const runs = events.runs.filter((event) => event.ts >= started);
	const now = o.now ?? Date.now();
	const capsuleClaimsPass =
		!!o.capsuleDone &&
		(o.capsuleTs ?? now) >= started &&
		isClaim(o.capsuleDone);
	if (capsuleClaimsPass)
		claims.push({ ts: o.capsuleTs ?? now, text: o.capsuleDone });
	if (!claims.length) return { ok: true };
	claims.sort((a, b) => a.ts - b.ts);
	runs.sort((a, b) => a.ts - b.ts);
	const lastClaim = claims.at(-1);
	if (!lastClaim) return { ok: true };
	// The capsule is the final explicit claim. Otherwise work done is the
	// closure boundary, allowing a later own run to correct interim prose.
	const boundary = capsuleClaimsPass ? (o.capsuleTs ?? now) : now;
	const lastRun = runs.filter((run) => run.ts <= boundary).at(-1);
	const counts = lastRun ? runCounts(lastRun.text) : null;
	let miss: { claim: ClaimEvent; why: string } | null = null;
	if (!counts || counts.pass === 0 || counts.fail > 0)
		miss = {
			claim: lastClaim,
			why: !counts
				? runs.length
					? "every test run in the transcript is after the claim"
					: "no test run found in the transcript"
				: counts.fail > 0
					? `last run before the claim failed (${counts.pass} pass / ${counts.fail} fail)`
					: "no passing run before the claim",
		};
	if (!miss) {
		const horizon = lastRun?.ts ?? 0;
		if (horizon > 0) {
			const grace = o.graceMs ?? CLAIM_CHECK_GRACE_MS;
			const root = o.statRoot ?? process.cwd();
			const stale: string[] = [];
			for (const p of o.paths.filter(testAffectingPath)) {
				const m = statMtime(join(root, p));
				if (m !== null && m > horizon + grace)
					stale.push(
						`${p} (modified ${new Date(m).toISOString()}, after run ${new Date(horizon).toISOString()} + ${Math.round(grace / 1000)}s grace)`,
					);
			}
			if (stale.length)
				miss = {
					claim: lastClaim,
					why: `test-affecting files changed after the last passing run:\n  ${stale.join("\n  ")}\n  rerun the suite so the pass predates the changes`,
				};
		}
	}
	if (miss)
		return {
			ok: false,
			why: `claim-check (W833): test-pass claim not backed by evidence — ${miss.why}\n  claim: "${miss.claim.text.replace(/\s+/g, " ").trim().slice(0, 120)}"\nRetain the claim and supply the missing verification evidence.`,
		};
	return { ok: true };
};
