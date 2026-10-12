// hooks/gates/anchor.ts — PreToolUse(Edit) anchor-existence gate (W110).
// The #1 harness tool-error class (W109 journal dig: 1,932 Edit errors/7d,
// anchor-class 67%): the model emits an old_string that is not in the file —
// stale read, whitespace drift, regex-vs-literal confusion — and pays a full
// error round trip ("string not found") plus a re-read to recover. This gate
// reads the target ONCE (O(file), no subprocess) and denies the miss BEFORE
// the harness can, with the nearest-match context attached so ONE retry
// carries the corrected anchor. Ordered by fix strength:
//   exact → ambiguous → whitespace-normalized → regex-literal confusion →
//   fuzzy bigram window → generic (no close match).
// W251: every miss renders a numbered 3-line context around the nearest
// match and a paste-ready auto-rg probe (`rg -n -F '<key>' <path>`) — for
// the no-close-match class the probe doubles as an absence check (empty
// output = the anchor line is wholly gone; hard stale-read signal).
// Fail-open: unreadable targets, huge files (>ANCHOR_MAX_BYTES), and empty
// anchors never block — the harness's own error is precise and cheap there.
import { deny, type HookInput } from "../lib/hookio.ts";
import { readFileSync, statSync } from "node:fs";

const ANCHOR_MAX_BYTES = 8 * 1024 * 1024; // above: fail open, harness owns it
const FUZZY_OPS_CAP = 8_000_000; // text.length × anchorLines char-op budget
const MAX_WINDOW_LINES = 512; // anchor windows beyond this skip the scan

export type AnchorHit = { line: number; text: string; key?: string };

export type AnchorHint =
	| { kind: "ok"; count: number }
	| ({ kind: "ambiguous" | "whitespace" | "regex" | "fuzzy" } & AnchorHit)
	| { kind: "none" };

const normLine = (l: string): string => l.replace(/\s+/g, " ").trim();

function countOccurrences(text: string, anchor: string): number {
	return anchor === "" ? 0 : text.split(anchor).length - 1;
}

/** 1-based line number + first-line text (capped) for an offset in the text. */
function lineAt(text: string, idx: number): AnchorHit {
	const line = text.slice(0, idx).split("\n").length;
	const text1 = text.slice(idx).split("\n")[0] ?? "";
	return { line, text: text1.slice(0, 300) };
}

/** Numbered 3-line context around a 0-based match index (clamped to file),
 * each line capped at ~200 chars — W251's denial-window contract. */
function context3(fLines: string[], i: number): string {
	const out: string[] = [];
	for (let n = i - 1; n <= i + 1; n++) {
		if (n < 0 || n >= fLines.length) continue;
		const l = fLines[n];
		out.push(`${n + 1}: ${l.length > 200 ? `${l.slice(0, 200)}…` : l}`);
	}
	return out.join("\n");
}

/** Paste-ready fixed-string probe key from the matched region: the matched
 * line trimmed (neighbors only if it is blank) — guaranteed to hit rg -n -F. */
function keyOf(fLines: string[], i: number): string {
	for (let n = i; n <= Math.min(fLines.length - 1, i + 1); n++) {
		const t = fLines[n].trim();
		if (t !== "") return t.slice(0, 80);
	}
	for (let n = Math.max(0, i - 1); n < i; n++) {
		const t = fLines[n].trim();
		if (t !== "") return t.slice(0, 80);
	}
	return "";
}

/** POSIX single-quoted shell literal. */
function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The W251 auto-rg denial line: paste to locate the true anchor text. */
export function rgProbe(path: string, key: string): string | null {
	if (key.trim() === "") return null;
	return `rg -n -F ${shq(key)} ${shq(path)}`;
}

/** Literal miss that exists once whitespace/indentation is normalized —
 * the stale-read / indentation-drift class (covers CRLF too: \r is \s). */
function whitespaceHit(text: string, anchor: string): AnchorHit | null {
	const aLines = anchor.split("\n");
	const fLines = text.split("\n");
	const L = aLines.length;
	if (L === 0 || L > MAX_WINDOW_LINES || fLines.length < L) return null;
	const aNorm = aLines.map(normLine);
	const fNorm = fLines.map(normLine);
	for (let i = 0; i + L <= fLines.length; i++) {
		let hit = true;
		for (let j = 0; j < L; j++) {
			if (fNorm[i + j] !== aNorm[j]) {
				hit = false;
				break;
			}
		}
		if (hit)
			return { line: i + 1, text: context3(fLines, i), key: keyOf(fLines, i) };
	}
	return null;
}

/** Regex-vs-literal confusion: the anchor carries metacharacters and MATCHES
 * the file as a regex, though the literal is absent. Guarded: length cap +
 * nested-quantifier rejection (ReDoS) + first 1MB slice. */
function regexHit(text: string, anchor: string): AnchorHit | null {
	if (anchor.length > 512) return null;
	if (!/[$()*+.?[\\\]^{|}]/.test(anchor)) return null;
	if (/\([^()]*[+*][^()]*\)[+*?{]/.test(anchor)) return null; // (x+)+ family
	let re: RegExp;
	try {
		re = new RegExp(anchor);
	} catch {
		return null; // invalid regex → not a usable hint
	}
	const m = re.exec(text.slice(0, 1_000_000));
	if (!m) return null;
	const fLines = text.split("\n");
	const line = text.slice(0, m.index).split("\n").length;
	return {
		line,
		text: context3(fLines, line - 1),
		key: keyOf(fLines, line - 1),
	};
}

/** Sørensen–Dice on whitespace-normalized line bigrams, mean over the
 * anchor's lines aligned to a sliding window. Best window ≥ 0.3 wins. */
function fuzzyHit(
	text: string,
	anchor: string,
): ({ score: number } & AnchorHit) | null {
	const aLines = anchor.split("\n");
	const fLines = text.split("\n");
	const L = aLines.length;
	if (L === 0 || L > MAX_WINDOW_LINES || fLines.length < L) return null;
	if (text.length * L > FUZZY_OPS_CAP) return null; // perf budget
	const aNorm = aLines.map(normLine);
	const fNorm = fLines.map(normLine);
	const aMaps = aNorm.map(bigrams);
	const aTotals = aMaps.map(totalBigrams);
	const fMaps = fNorm.map(bigrams);
	const fTotals = fMaps.map(totalBigrams);
	let bestI = -1;
	let bestScore = 0;
	for (let i = 0; i + L <= fLines.length; i++) {
		let sum = 0;
		for (let j = 0; j < L; j++) {
			sum += dice(aMaps[j], aTotals[j], fMaps[i + j], fTotals[i + j]);
		}
		const mean = sum / L;
		if (mean > bestScore) {
			bestScore = mean;
			bestI = i;
		}
	}
	if (bestI < 0 || bestScore < 0.3) return null;
	return {
		score: bestScore,
		line: bestI + 1,
		text: context3(fLines, bestI),
		key: keyOf(fLines, bestI),
	};
}

function bigrams(s: string): Map<string, number> {
	const m = bigramMap;
	m.clear();
	for (let i = 0; i < s.length - 1; i++) {
		const g = s.slice(i, i + 2);
		m.set(g, (m.get(g) ?? 0) + 1);
	}
	return new Map(m);
}

function totalBigrams(m: Map<string, number>): number {
	let n = 0;
	for (const c of m.values()) n += c;
	return n;
}

function dice(
	a: Map<string, number>,
	aTotal: number,
	b: Map<string, number>,
	bTotal: number,
): number {
	if (aTotal === 0 || bTotal === 0) return aTotal === bTotal ? 1 : 0;
	let inter = 0;
	for (const [g, c] of a) {
		const bc = b.get(g);
		if (bc) inter += Math.min(c, bc);
	}
	return (2 * inter) / (aTotal + bTotal);
}

/** Classify an Edit anchor against the current file text. */
export function anchorHint(
	text: string,
	anchor: string,
	replaceAll: boolean,
): AnchorHint {
	if (anchor === "") return { kind: "ok", count: 0 }; // not an anchor question
	const count = countOccurrences(text, anchor);
	if (count > 0) {
		if (count === 1 || replaceAll) return { kind: "ok", count };
		return {
			kind: "ambiguous",
			count,
			...lineAt(text, text.indexOf(anchor)),
			key: anchor.split("\n")[0].trim().slice(0, 80),
		};
	}
	const ws = whitespaceHit(text, anchor);
	if (ws) return { kind: "whitespace", ...ws };
	const rx = regexHit(text, anchor);
	if (rx) return { kind: "regex", ...rx };
	const fz = fuzzyHit(text, anchor);
	if (fz) return { kind: "fuzzy", ...fz };
	return { kind: "none" };
}

/** The deny message — null when the edit may proceed. `anchor` (when the
 * caller has it) powers the no-close-match absence probe (W251). */
export function anchorDenyReason(
	hint: AnchorHint,
	path: string,
	anchor = "",
): string | null {
	if (hint.kind === "ok") return null;
	if (hint.kind === "ambiguous") {
		const p = rgProbe(path, hint.key ?? "");
		return `anchor-gate: old_string matches ${hint.count} places in ${path}; without replace_all the Edit dies with "Found ${hint.count} matches". First match at line ${hint.line}: ${hint.text}. Extend old_string to be unique or set replace_all: true.${p ? ` Locate all sites: ${p}` : ""}`;
	}
	if (hint.kind === "whitespace") {
		const p = rgProbe(path, hint.key ?? "");
		return `anchor-gate: old_string not found VERBATIM in ${path}, but it exists with different whitespace/indentation near line ${hint.line}:\n${hint.text}${p ? `\nAuto-locate: ${p}` : ""}\nCopy the exact text from that region and retry.`;
	}
	if (hint.kind === "regex") {
		const p = rgProbe(path, hint.key ?? "");
		return `anchor-gate: old_string not found literally in ${path}. It contains regex syntax and WOULD match at line ${hint.line}:\n${hint.text}${p ? `\nAuto-locate: ${p}` : ""}\nEdit matches literal characters, not patterns — emit the exact file text as old_string.`;
	}
	if (hint.kind === "fuzzy") {
		const p = rgProbe(path, hint.key ?? "");
		return `anchor-gate: old_string not found in ${path}. Closest match (${Math.round(hint.score * 100)}% similar) at line ${hint.line}:\n${hint.text}${p ? `\nAuto-locate: ${p}` : ""}\nRe-read that region and retry with the exact text.`;
	}
	const probe = rgProbe(path, longestLine(anchor));
	const probeLine = probe
		? ` Absence probe: ${probe} — no output means the line is wholly gone.`
		: "";
	return `anchor-gate: no close match in ${path} (file likely changed since your last read).${probeLine} Re-read the target region, then retry with the exact text.`;
}

/** Longest trimmed line of the anchor — the absence-probe key (W251). */
function longestLine(anchor: string): string {
	return anchor
		.split("\n")
		.map((l) => l.trim())
		.reduce((a, b) => (b.length > a.length ? b : a), "");
}

const bigramMap = new Map<string, number>();

/** The gate: fires on Edit only (MultiEdit and Write pass untouched). */
export function anchorGate(hook: HookInput): void {
	if (hook.tool_name !== "Edit") return;
	const ti = (hook.tool_input ?? {}) as {
		file_path?: string;
		old_string?: string;
		new_string?: string;
		replace_all?: boolean;
	};
	const F = ti.file_path ?? "";
	const old = ti.old_string ?? "";
	if (!F || old === "") return; // empty anchor is the harness's own error class
	if (old === (ti.new_string ?? "")) return; // no-op edit: harness owns it
	try {
		if (statSync(F).size > ANCHOR_MAX_BYTES) return; // fail open on monsters
	} catch {
		return; // missing/unreadable: the harness error is precise and cheap
	}
	let text: string;
	try {
		text = readFileSync(F, "utf8");
	} catch {
		return; // TOCTOU gone mid-gate: fail open
	}
	const hint = anchorHint(text, old, ti.replace_all === true);
	if (hint.kind === "ok") return;
	deny(anchorDenyReason(hint, F, old) ?? "anchor-gate: anchor rejected");
}
