import { stripVTControlCharacters } from "node:util";

// hooks/lib/executors/fake-completion.ts — W511: fake-completion integrity scan for the
// claim-done gate. Deterministic scan of the closing diff's ADDED lines:
// gated test calls (describe/it/test with a skip/only/todo suffix call),
// legacy aliases, stub notes, and placeholder-error throws. The gate refuses
// closure while markers remain; distinct from W502's stop-gate continuation.
//
// The scan must never flag its own source, so every pattern is assembled from
// split string parts — no marker text appears contiguously in this file, and
// no comment spells a marker out.

export interface FakeCompletionHit {
	path: string;
	line: number;
	marker: string;
	text: string;
}

const assemble = (...parts: string[]): string => parts.join("");

const MARKERS: ReadonlyArray<{ marker: string; re: RegExp }> = [
	{
		marker: "skip-gate",
		re: new RegExp(
			assemble(
				"\\b(",
				"describe|it|test",
				")\\.",
				"(skip|only|todo",
				")\\s*\\(",
			),
		),
	},
	{
		marker: "x-gate",
		re: new RegExp(assemble("\\bx(", "describe|it|test", ")\\s*\\(")),
	},
	{
		marker: "stub-note",
		re: new RegExp(`\\b(${assemble("TO", "DO")}|${assemble("FIX", "ME")})\\b`),
	},
	{
		marker: "placeholder-throw",
		re: new RegExp(assemble("not ", "implemented|un", "implemented"), "i"),
	},
];

// Capture syntax is a narrow artifact heuristic, never provenance authentication.
function isReceiptLog(path: string): boolean {
	const parts = path.split("/");
	return (
		path.endsWith(".log") &&
		!path.includes("\\") &&
		!/^(?:\/|[A-Za-z]:)/.test(path) &&
		parts.every((part) => part !== "" && part !== "." && part !== "..") &&
		parts
			.slice(0, -1)
			.some((part) => /^(?:receipts|[A-Za-z0-9._-]+-receipts)$/.test(part))
	);
}
function isTestHeading(text: string): boolean {
	const line = stripVTControlCharacters(text).trim();
	const playwright =
		/^Running ([1-9]\d*) (test|tests) using ([1-9]\d*) (worker|workers)$/.exec(
			line,
		);
	if (playwright)
		return (
			playwright[2] === (playwright[1] === "1" ? "test" : "tests") &&
			playwright[4] === (playwright[3] === "1" ? "worker" : "workers")
		);
	return /^bun test v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?(?: \([a-f0-9]{8,40}\))?$/.test(
		line,
	);
}
function isCapturedDiagnostic(text: string): boolean {
	const line = stripVTControlCharacters(text);
	if (/^\s*(?:>\s*)?[1-9]\d*\s*\|[ \t]+/.test(line)) return true;
	return (
		/^\s*(?:(?:Type|Range|Syntax|Reference|Eval|URI|Aggregate)?Error|error):[ \t]+\S/.test(
			line,
		) && !/\bthrow\b/.test(line)
	);
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? /;
const PROSE_PATH = /\.(?:md|mdx|rst|txt|adoc)$/i;

/** Scan the ADDED lines of a unified diff (-U0) for fake-completion markers. */
export function scanCompletionDiff(diff: string): FakeCompletionHit[] {
	const hits: FakeCompletionHit[] = [];
	let path = "";
	let line = 0;
	let receiptLog = false;
	let transcript = false;
	let prefixLine = 1;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ ")) {
			const target = raw.slice(4).split("\t")[0] ?? "";
			path =
				target === "/dev/null"
					? ""
					: target.replace(/^"b\//, "").replace(/^b\//, "").replace(/"$/, "");
			receiptLog = isReceiptLog(path);
			transcript = false;
			prefixLine = 1;
			continue;
		}
		const hunk = HUNK.exec(raw);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (raw.startsWith("+") && path) {
			const text = raw.slice(1);
			// Qualify only a fully observed added prefix, never a comment wrapper
			// or a header reached after unknown/context-only source content.
			if (receiptLog && !transcript && prefixLine) {
				if (line !== prefixLine) prefixLine = 0;
				else if (stripVTControlCharacters(text).trim()) {
					transcript = isTestHeading(text);
					prefixLine = 0;
				} else prefixLine += 1;
			}
			for (const m of MARKERS) {
				if (
					m.marker === "placeholder-throw" &&
					transcript &&
					isCapturedDiagnostic(text)
				)
					continue;
				// Prose can honestly describe future proposals. Source keeps its
				// broader scan so a multiline error constructor cannot evade it.
				if (
					m.marker === "placeholder-throw" &&
					PROSE_PATH.test(path) &&
					!/\bthrow\s+/.test(text)
				)
					continue;
				if (m.re.test(text)) {
					hits.push({
						path,
						line,
						marker: m.marker,
						text: text.trim().slice(0, 160),
					});
					break;
				}
			}
			line += 1;
			continue;
		}
		if (raw.startsWith("-") || raw.startsWith("\\")) continue;
		line += 1;
	}
	return hits;
}
