// hooks/lib/gates/scrub.ts — W236: the scrub scanner. Scrubbing across lanes was
// directive-driven (brief text + review); this mechanizes it: every ADDED
// line in a staged or push-range diff runs the rule set —
//   (a) absolute /Users/<user> home paths,
//   (b) the LOCAL denylist of real hosts/IPs/MACs (~/.claude/local-llm/
//       scrub-denylist, mode 600, machine-local, never committed; loader is
//       fail-inert — the credscope posture),
//   (c) key material (sk-/ghp_/AKIA/PEM/slack),
//   (d) IKEA-internal markers (generic built-ins only — real hostnames live // scrub:allow
//       in the local denylist; IKEA intel lives in coord facts, never repos).
// A line carrying the explicit marker `scrub:allow` is exempt. Matches are
// redacted before display; findings carry file:line + rule.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const SCRUB_ALLOW = "scrub:allow";

export interface ScrubRule {
	name: string;
	hint: string;
	re: RegExp;
}

export interface ScrubFinding {
	file: string;
	line: number;
	rule: string;
	match: string; // redacted
}

const rule = (name: string, hint: string, re: RegExp): ScrubRule => ({
	name,
	hint,
	re,
});

// ---- builtin rules: the four directive classes ----
export const BUILTIN_RULES: ScrubRule[] = [
	rule(
		"home-path",
		"absolute /Users/<user> path — scrub or relativize",
		/\/Users\/[a-z0-9][a-z0-9._-]*/gi,
	),
	rule(
		"aws-key",
		"AWS access key id — rotate, then scrub",
		/\bAKIA[0-9A-Z]{16}\b/g,
	),
	rule(
		"sk-key",
		"sk-… API key — rotate, then scrub",
		/\bsk-[A-Za-z0-9_-]{20,}\b/g,
	),
	rule(
		"github-token",
		"github token (ghp_/gho_/ghu_/ghs_/ghr_) — rotate, then scrub",
		/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	),
	rule(
		"private-key",
		"PEM private key block — never commit; rotate if real",
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
	),
	rule(
		"slack-token",
		"slack token (xox[baprs]-…) — rotate, then scrub",
		/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	),
	rule(
		"ikea-internal", // scrub:allow
		"IKEA-internal marker — real hosts belong in the local denylist; internal intel lives in coord facts only", // scrub:allow
		/\bikea[-_ .]?(internal|intranet|confidential)|\bikea\.(internal|intranet|net)\b/gi,
	),
	rule(
		"mac-address",
		"MAC address — real NIC hardware addresses belong in the local denylist; scrub or mark scrub:allow",
		/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi,
	),
	rule(
		"rfc1918",
		"RFC1918 private IPv4 (10/8, 172.16/12, 192.168/16) — real LAN addrs belong in the local denylist; scrub or mark scrub:allow",
		/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[01])(?:\.\d{1,3}){2})\b/g,
	),
];

// regex-source escape helper (plain char loop, no replacement patterns)
const escapeRe = (s: string): string => {
	let out = "";
	for (const c of s) {
		if ("\\^$.+?()[]{}|/*".includes(c)) out += "\\";
		out += c;
	}
	return out;
};

// one denylist line: /pattern/i form compiles as a regex (bad pattern falls
// back to literal); anything else matches literally, case-insensitively.
const literalOrRegex = (line: string): RegExp => {
	const re = /^\/(.+)\/([a-z]*)$/.exec(line);
	if (!re) return new RegExp(escapeRe(line), "gi");
	try {
		// global flag is mandatory: exec() must advance or scanLine spins forever
		return new RegExp(re[1], re[2]?.includes("g") ? re[2] : `g${re[2] ?? ""}`);
	} catch {
		return new RegExp(escapeRe(line), "gi");
	}
};

// denylistPath: SUSPENDERS_SCRUB_DENYLIST overrides (the value "0" disables
// the local denylist); default ~/.claude/local-llm/scrub-denylist.
export const denylistPath = (): string =>
	process.env.SUSPENDERS_SCRUB_DENYLIST === "0"
		? ""
		: (process.env.SUSPENDERS_SCRUB_DENYLIST ??
			`${homedir()}/.claude/local-llm/scrub-denylist`);

// fail-inert loader (the credscope posture): absent/unreadable denylist →
// no extra rules; one bad regex line is skipped, never fatal.
export function loadScrubDenylist(): ScrubRule[] {
	const p = denylistPath();
	if (!p) return [];
	let text: string;
	try {
		text = readFileSync(p, "utf8");
	} catch {
		return []; // absent → nothing declared → inert
	}
	const out: ScrubRule[] = [];
	for (const [i, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		out.push({
			name: `denylist:${i + 1}`,
			hint: "local denylist entry",
			re: literalOrRegex(line),
		});
	}
	return out;
}

export const scrubRules = (): ScrubRule[] => [
	...BUILTIN_RULES,
	...loadScrubDenylist(),
];

// a finding names the leak class; it never re-prints the secret itself.
// ≤9-char matches print whole; longer truncate at 8 with an ellipsis.
export const redact = (s: string): string =>
	s.length <= 9 ? s : `${s.slice(0, 8)}…`;

// scan ONE line; marker lines are exempt. Every hit is reported.
export function scanLine(
	line: string,
	rules: ScrubRule[],
): { rule: string; match: string }[] {
	if (line.includes(SCRUB_ALLOW)) return [];
	const out: { rule: string; match: string }[] = [];
	for (const r of rules) {
		r.re.lastIndex = 0;
		for (let m = r.re.exec(line); m !== null; m = r.re.exec(line)) {
			out.push({ rule: r.name, match: redact(m[0]) });
			if (r.re.lastIndex === m.index) r.re.lastIndex++; // zero-width guard
		}
	}
	return out;
}

export interface AddedLine {
	file: string;
	line: number;
	text: string;
}

// parse git diff -U0 output into ADDED lines with new-file line numbers.
// Hunk-aware (W708): +++/--- headers only exist PRE-hunk — inside a hunk a
// raw `+++ …` line IS added content whose text starts `++ ` and must scan.
// \ No-newline markers are never content; context lines advance the
// counter, - lines do not.
export function addedDiffLines(diff: string): AddedLine[] {
	const out: AddedLine[] = [];
	let file = "";
	let n = 0;
	let inHunk = false;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			file = /^diff --git a\/(.+) b\/(.+)$/.exec(raw)?.[2] ?? raw.slice(11);
			n = 0;
			inHunk = false;
			continue;
		}
		if (raw.startsWith("@@")) {
			inHunk = true;
			n = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)?.[1] ?? 0);
			continue;
		}
		if (!inHunk) continue; // index/rename/mode/+++/--- metadata
		if (raw.startsWith("\\")) continue;
		if (raw.startsWith("+")) {
			out.push({ file, line: n, text: raw.slice(1) });
			n++;
		} else if (!raw.startsWith("-") && n > 0) {
			n++;
		}
	}
	return out;
}

// whole-buffer scan for binary/NUL-laced content: git diffs emit no hunks
// for binary files, so the gate hands blobs over whole. latin1 keeps every
// byte addressable and the rule set is ASCII-patterned — nothing is lost.
// 1-based line numbers over the \n-split buffer.
export const scrubBuffer = (
	buf: Uint8Array,
	rules: ScrubRule[],
	file = "",
): ScrubFinding[] =>
	scrubText(Buffer.from(buf).toString("latin1"), rules, file);

// scan the ADDED diff lines → findings (file:line from the hunk headers)
export function scrubAddedLines(
	lines: AddedLine[],
	rules: ScrubRule[],
): ScrubFinding[] {
	const out: ScrubFinding[] = [];
	for (const l of lines) {
		for (const h of scanLine(l.text, rules)) {
			out.push({ file: l.file, line: l.line, rule: h.rule, match: h.match });
		}
	}
	return out;
}

// whole-text scan (CLI --files mode): 1-based line numbers.
export function scrubText(
	text: string,
	rules: ScrubRule[],
	file = "",
): ScrubFinding[] {
	const out: ScrubFinding[] = [];
	for (const [i, line] of text.split("\n").entries()) {
		for (const h of scanLine(line, rules)) {
			out.push({ file, line: i + 1, rule: h.rule, match: h.match });
		}
	}
	return out;
}

// W1226 transport redaction: replace every rule match with a `[scrubbed:<rule>]`
// marker and return the scrubbed text. Unlike scanLine there is NO `scrub:allow`
// exemption — the allow marker is a commit-gate escape hatch, never a transport
// one: content crossing to a remote hub must not opt itself out of redaction.
export function redactMatches(text: string, rules: ScrubRule[]): string {
	let out = text;
	for (const r of rules) {
		r.re.lastIndex = 0;
		out = out.replace(r.re, `[scrubbed:${r.name}]`);
	}
	return out;
}

// ≤20 findings one per line, overflow counted — a deny names the leaks
// without flooding context.
export const findingsText = (fs: ScrubFinding[], cap = 20): string =>
	[
		...fs
			.slice(0, cap)
			.map((f) => `  ${f.file}:${f.line} [${f.rule}] ${f.match}`),
		...(fs.length > cap ? [`  … ${fs.length - cap} more`] : []),
	].join("\n");
