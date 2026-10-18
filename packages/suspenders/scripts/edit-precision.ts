// scripts/edit-precision.ts — W744 benchmark: edit_precision on the W-lane
// history = gate denials per 100 edits, read straight from the fleet's
// Claude-Code transcripts ($HOME/.claude/projects/<slug>/*.jsonl). Denials
// count marker strings on error tool_result lines (reads/source echoes are
// not errors, so source contamination is excluded); edits count Edit/Write/
// NotebookEdit tool_use events. Corrupted-emission events have no machine
// log — extend --patterns when a marker gains a surface.
//
// Usage: bun scripts/edit-precision.ts [--dir <transcripts-root>]
//        [--slug <dir-name substring, default klh-fleet>]
//        [--window <days>] [--json] [--patterns <regex,a,b>]
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

const DIR = flag("dir") ?? join(process.env.HOME ?? ".", ".claude", "projects");
const SLUG = flag("slug") ?? "klh-fleet";
const WINDOW_DAYS = Number(flag("window") ?? 0) || 0;
const JSON_OUT = argv.includes("--json");

/** default denial vocabulary: the lane gates that refuse a mutation. */
const DEFAULT_PATTERNS = [
	"mutation-size:",
	"patch-first (W744)",
	"changed on disk since your last governed edit",
	"governor denies parallel edits",
];
const PATTERNS_FLAG = flag("patterns");
const patterns: RegExp[] = (
	PATTERNS_FLAG ? PATTERNS_FLAG.split(",").filter(Boolean) : DEFAULT_PATTERNS
).map((p) => new RegExp(p));
const isAssistantToolUse = (line: string): boolean =>
	line.includes('"type":"assistant"') && line.includes('"tool_use"');
const isErrToolResult = (line: string): boolean =>
	line.includes('"tool_result"') && line.includes('"is_error":true');
const editRe = /"name":"(?:Edit|Write|NotebookEdit)"/g;

const run = async (): Promise<void> => {
	if (!existsSync(DIR)) {
		console.error(`no transcripts dir: ${DIR}`);
		process.exit(1);
	}
	const dirs = readdirSync(DIR)
		.filter((d) => d.includes(SLUG) && statSync(join(DIR, d)).isDirectory())
		.sort();
	if (!dirs.length) {
		console.error(`no project dirs matching slug ${SLUG} in ${DIR}`);
		process.exit(1);
	}
	const cutoff = WINDOW_DAYS ? Date.now() - WINDOW_DAYS * 86_400_000 : 0;
	let edits = 0;
	let denials = 0;
	const rows: { dir: string; files: number; edits: number; denials: number }[] =
		[];
	for (const d of dirs) {
		const files = readdirSync(join(DIR, d))
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(DIR, d, f));
		let dEdits = 0;
		let dDenials = 0;
		for (const f of files) {
			if (cutoff && statSync(f).mtimeMs < cutoff) continue;
			const rl = createInterface({
				input: createReadStream(f, { encoding: "utf8" }),
				crlfDelay: Infinity,
			});
			for await (const line of rl) {
				if (isAssistantToolUse(line)) dEdits += line.match(editRe)?.length ?? 0;
				else if (isErrToolResult(line))
					for (const p of patterns) if (p.test(line)) dDenials += 1;
			}
			rl.close();
		}
		rows.push({
			dir: d,
			files: files.length,
			edits: dEdits,
			denials: dDenials,
		});
		edits += dEdits;
		denials += dDenials;
	}
	const per100 = edits ? ((denials / edits) * 100).toFixed(2) : "n/a";
	if (JSON_OUT) {
		console.log(
			JSON.stringify(
				{
					dir: DIR,
					slug: SLUG,
					window_days: WINDOW_DAYS,
					edits,
					denials,
					per_100: per100,
					rows,
				},
				null,
				2,
			),
		);
		return;
	}
	console.log(
		`edit_precision (W744) — slug "${SLUG}"${WINDOW_DAYS ? `, window ${WINDOW_DAYS}d` : ""}`,
	);
	for (const r of rows)
		console.log(
			`  ${r.dir}  files=${r.files} edits=${r.edits} denials=${r.denials}`,
		);
	console.log(
		`TOTAL edits=${edits} denials=${denials} denials/100-edits=${per100}`,
	);
};

await run();
