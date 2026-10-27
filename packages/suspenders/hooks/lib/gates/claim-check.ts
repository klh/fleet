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
// W1731 client-adapter dispatch: run events come only from the evidence
// reader the executor registry carries for the resolved client (launch
// identity > detected > default — the completion caller resolves it);
// claims are read through every registered reader, so no identity hides
// one. A client without a reader yields zero runs: its claim fails closed.
//
// Fail-open: an unreadable/absent transcript yields no transcript claims
// (capsule text still counts), untimestamped events are dropped, and stat
// failures skip a path. Completion callers cannot disable this evidence check.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	adapterForExact,
	EVIDENCE_NORMALIZERS,
} from "../executors/registry.ts";
import {
	assemble,
	type ClaimEvent,
	isClaim,
	normalizeTranscript,
	runCounts,
	type TranscriptEvents,
} from "./claim-evidence.ts";

/** transcript scan window — bounded tail, never the unbounded file. */
export const CLAIM_CHECK_SCAN_BYTES = 8 * 1024 * 1024;
/** mtime grace after the last passing run (post-test formatting lands here). */
export const CLAIM_CHECK_GRACE_MS = 120_000;

// The claim/run vocabulary is the shared evidence surface (claim-evidence.ts);
// re-exported so existing importers of this gate keep one entry point.
export { isClaim, isPassingRun, runCounts } from "./claim-evidence.ts";
export type { ClaimEvent, TranscriptEvents } from "./claim-evidence.ts";

/** Extract claim events (assistant prose, through every registered reader)
 *  and run events (W917 origin gate) through `client`'s registry evidence
 *  reader only — W1731 design.client-adapter-dispatch: each transcript
 *  format is its adapter's reader, never a branch here. An unregistered
 *  client, or one with no reader, yields zero runs. Untimestamped lines drop. */
export function transcriptEventsFromText(
	text: string,
	client: string,
): TranscriptEvents {
	return normalizeTranscript(
		text,
		EVIDENCE_NORMALIZERS,
		adapterForExact(client)?.evidence,
	);
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
	/(?:^|[/\\])(?:tests?|e2e|spec|__tests__)[/\\]|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/i;
const TEST_CALL_NAME = new RegExp(
	assemble(
		"\\b(",
		"describe|it|test",
		")(?:\\.(?:fixme|skip|only))?\\s*\\(\\s*([\"'`])([^\"'`]{1,160}?)\\2",
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
	/** W1731: the resolved client (registry id) whose evidence reader yields
	 *  run events — the caller's launch > detected > default resolution. */
	client: string;
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
		? transcriptEventsFromText(text, o.client)
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
			why: !adapterForExact(o.client)?.evidence
				? `no transcript evidence adapter for client ${o.client} — its runs cannot be read, so the claim fails closed`
				: !counts
					? runs.length
						? "every test run in the transcript is after the claim"
						: `no test run found in the transcript (read as ${o.client})`
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
