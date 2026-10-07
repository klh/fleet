// hooks/lib/fake-completion.ts — W511: fake-completion integrity scan for the
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
			assemble("\\b(", "describe|it|test", ")\\.", "(skip|only|todo", ")\\s*\\("),
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

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? /;

/** Scan the ADDED lines of a unified diff (-U0) for fake-completion markers. */
export function scanCompletionDiff(diff: string): FakeCompletionHit[] {
	const hits: FakeCompletionHit[] = [];
	let path = "";
	let line = 0;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ ")) {
			const target = raw.slice(4).split("\t")[0] ?? "";
			path =
				target === "/dev/null"
					? ""
					: target.replace(/^"b\//, "").replace(/^b\//, "").replace(/"$/, "");
			continue;
		}
		const hunk = HUNK.exec(raw);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (raw.startsWith("+") && path) {
			const text = raw.slice(1);
			for (const m of MARKERS) {
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
