// hooks/lib/report-html.ts — W1199 lane report artifacts. A lane closing with
// review-shaped output (audits, reviews, investigations — never code items)
// may attach a single-file HTML report. Agents write DATA — a strict markdown
// subset — and this generator fills a fixed printable shell; nobody emits
// free-form HTML. The artifact is a VIEW (machine-local .fleet/reports/,
// regenerable from its markdown) — the markdown ledger stays authoritative
// (centralized-ledger law). Generated static file, not a component: the Lit
// DOM-ownership law is untouched.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectRootOf } from "./govdb-project.ts";

export type ReportRecord = { sha256: string; ts: number };

// The graph records the artifact (provenance: content sha + when). Files live
// outside any worktree so lane cleanup and branch churn never strand a link.
export function reportArtifactDir(project: string): string {
	return join(projectRootOf(project), ".fleet", "reports");
}

export function reportArtifactPath(project: string, id: string): string {
	return join(reportArtifactDir(project), `${id}.html`);
}

// Newest work.report event per item — one bounded event scan (reports are
// rare), keyed `project\0id` for the /api/tasks feed; pass null for all
// projects. The record lives in the graph, so the feed never touches the fs.
export function reportRecordMap(
	db: { query: (sql: string) => { all: (...p: unknown[]) => unknown[] } },
	project: string | null,
): Map<string, ReportRecord> {
	const rows = db
		.query(
			`SELECT project, work, payload FROM events
			WHERE kind = 'work.report' ORDER BY id DESC LIMIT 500`,
		)
		.all() as { project: string; work: string; payload: string | null }[];
	const out = new Map<string, ReportRecord>();
	for (const r of rows) {
		const key = `${r.project}\u0000${r.work}`;
		if (project && r.project !== project) continue;
		if (out.has(key)) continue; // newest wins (id DESC scan)
		const ev = JSON.parse(r.payload ?? "{}") as {
			sha256?: string;
			bornAt?: number;
		};
		if (typeof ev.sha256 !== "string") continue;
		out.set(key, { sha256: ev.sha256, ts: Number(ev.bornAt) || 0 });
	}
	return out;
}

// Single-item lookup for the drawer feed.
export function reportRecordFor(
	db: { query: (sql: string) => { get: (...p: unknown[]) => unknown } },
	project: string,
	id: string,
): ReportRecord | null {
	const row = db
		.query(
			"SELECT payload FROM events WHERE kind = 'work.report' AND project = ? AND work = ? ORDER BY id DESC LIMIT 1",
		)
		.get(project, id) as { payload: string | null } | null;
	if (!row?.payload) return null;
	const ev = JSON.parse(row.payload) as { sha256?: string };
	return typeof ev.sha256 === "string" ? { sha256: ev.sha256, ts: 0 } : null;
}

// ---------------------------------------------------------------------------
// markdown subset → HTML. One strict grammar, every data-derived character
// escaped; structural markup comes only from this generator.
// ---------------------------------------------------------------------------

const SEVERITY = new Set([
	"CRITICAL",
	"HIGH",
	"MEDIUM",
	"LOW",
	"INFO",
	"PASS",
	"FAIL",
]);

export function esc(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

// inline: badges, `code`, **bold**, *em*, [text](http…). Runs on ESCAPED
// text, so the url can carry no quotes; only http(s) or same-page anchors.
function inline(s: string): string {
	let out = s.replace(/\[([A-Z]+)\]/g, (m, word: string) =>
		SEVERITY.has(word)
			? `<span class="sev sev-${word.toLowerCase()}">${word}</span>`
			: m,
	);
	out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	out = out.replace(
		/\[([^\]]+)\]\((https?:\/\/[^)\s]+|#[^)\s]*)\)/g,
		'<a href="$1" rel="noopener">$1</a>',
	);
	return out;
}

type Block =
	| { kind: "heading"; level: number; text: string }
	| { kind: "para"; text: string }
	| { kind: "list"; ordered: boolean; items: string[] }
	| { kind: "table"; head: string[]; rows: string[][] }
	| { kind: "code"; lang: string; lines: string[] };

function parseBlocks(md: string): Block[] {
	const lines = md.replaceAll("\r\n", "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		const fence = line.match(/^```(\w*)/);
		if (fence) {
			const lang = fence[1] ?? "";
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				body.push(lines[i]);
				i++;
			}
			i++; // closing fence (or EOF — unterminated blocks still render)
			blocks.push({ kind: "code", lang: lang.toLowerCase(), lines: body });
			continue;
		}
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			blocks.push({
				kind: "heading",
				level: heading[1].length,
				text: heading[2],
			});
			i++;
			continue;
		}
		if (/^\|.*\|/.test(line)) {
			const rows: string[][] = [];
			while (i < lines.length && /^\|/.test(lines[i].trim())) {
				rows.push(
					lines[i]
						.trim()
						.replace(/^\|/, "")
						.replace(/\|$/, "")
						.split("|")
						.map((c) => c.trim()),
				);
				i++;
			}
			// the `---` separator row (if present) is the header, not data
			const sep = rows.findIndex((r) => r.every((c) => /^:?-{2,}:?$/.test(c)));
			const head = sep > 0 ? rows[sep - 1] : null;
			const data = rows.filter(
				(_r, n) => sep < 0 || (n !== sep && n !== sep - 1),
			);
			blocks.push({ kind: "table", head: head ?? [], rows: data });
			continue;
		}
		if (/^[-*]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^[-*]\s+/, ""));
				i++;
			}
			blocks.push({ kind: "list", ordered: false, items });
			continue;
		}
		if (/^\d+\.\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\d+\.\s+/, ""));
				i++;
			}
			blocks.push({ kind: "list", ordered: true, items });
			continue;
		}
		// paragraph: consecutive non-blank, non-structural lines
		const para: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() &&
			!/^(#{1,4}\s|```|[-*]\s|\d+\.\s|\|)/.test(lines[i])
		) {
			para.push(lines[i].trim());
			i++;
		}
		blocks.push({ kind: "para", text: para.join(" ") });
	}
	return blocks;
}

function renderCode(block: Extract<Block, { kind: "code" }>): string {
	if (block.lang === "diff") {
		const rows = block.lines
			.map((l) => {
				const cls = l.startsWith("+")
					? "add"
					: l.startsWith("-")
						? "del"
						: l.startsWith("@@")
							? "hunk"
							: "";
				return `<tr class="d${cls}"><td>${
					cls ? esc(l.slice(0, 1)) : ""
				}</td><td>${esc(cls ? l.slice(1) : l)}</td></tr>`;
			})
			.join("");
		return `<table class="diff">${rows}</table>`;
	}
	return `<pre><code>${esc(block.lines.join("\n"))}</code></pre>`;
}

function renderBlocks(blocks: Block[]): {
	body: string;
	toc: { id: string; text: string }[];
} {
	const parts: string[] = [];
	const toc: { id: string; text: string }[] = [];
	let section = 0;
	for (const b of blocks) {
		if (b.kind === "heading") {
			if (b.level === 2) {
				section++;
				const id = `s${section}`;
				toc.push({ id, text: b.text });
				parts.push(`<h2 id="${id}">${inline(esc(b.text))}</h2>`);
			} else {
				parts.push(`<h${b.level}>${inline(esc(b.text))}</h${b.level}>`);
			}
			continue;
		}
		if (b.kind === "para") {
			parts.push(`<p>${inline(esc(b.text))}</p>`);
			continue;
		}
		if (b.kind === "list") {
			const tag = b.ordered ? "ol" : "ul";
			const items = b.items.map((it) => `<li>${inline(esc(it))}</li>`).join("");
			parts.push(`<${tag}>${items}</${tag}>`);
			continue;
		}
		if (b.kind === "table") {
			const head = b.head.length
				? `<thead><tr>${b.head
						.map((c) => `<th>${inline(esc(c))}</th>`)
						.join("")}</tr></thead>`
				: "";
			const rows = b.rows
				.map(
					(r) =>
						`<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join("")}</tr>`,
				)
				.join("");
			parts.push(`<table class="data">${head}<tbody>${rows}</tbody></table>`);
			continue;
		}
		parts.push(renderCode(b));
	}
	return { body: parts.join("\n"), toc };
}

const CSS = `
:root{--paper:#fdfdfb;--ink:#1c1e21;--dim:#5c636b;--line:#e3e1da;--accent:#0b62c4;
--crit:#b3261e;--high:#c4531a;--med:#8a6d00;--low:#2e6b4f;--info:#5c636b;--add:#e8f5e9;--del:#fdecea}
*{box-sizing:border-box}
body{margin:0 auto;max-width:56rem;padding:2rem 1.25rem 4rem;background:var(--paper);color:var(--ink);
font:16px/1.6 -apple-system,'Segoe UI',Roboto,sans-serif}
a{color:var(--accent)}
code,pre{font:0.875em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f3ee;
border-radius:4px;padding:0.1em 0.35em}
pre{padding:0.75rem 1rem;overflow-x:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:0.9rem}
th,td{border:1px solid var(--line);padding:0.4rem 0.6rem;text-align:left;vertical-align:top}
th{background:#f4f3ee}
tr:nth-child(even) td{background:#faf9f5}
.sev{display:inline-block;font-size:0.72rem;font-weight:700;letter-spacing:0.04em;
padding:0.05rem 0.45rem;border-radius:3px;color:#fff;background:var(--info)}
.sev-critical{background:var(--crit)}.sev-high{background:var(--high)}
.sev-medium{background:var(--med)}.sev-low{background:var(--low)}
.sev-pass{background:var(--low)}.sev-fail{background:var(--crit)}
table.diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.8rem}
table.diff td{padding:0.05rem 0.5rem}
tr.dadd td{background:var(--add)}tr.ddel td{background:var(--del)}
tr.dhunk td{color:var(--dim);font-style:italic}
header{border-bottom:2px solid var(--ink);padding-bottom:1rem;margin-bottom:1.5rem}
.kitem{font:0.8rem ui-monospace,monospace;background:var(--ink);color:var(--paper);
padding:0.15rem 0.5rem;border-radius:4px}
.meta{color:var(--dim);font-size:0.85rem;margin-top:0.5rem}
nav.toc{border:1px solid var(--line);border-radius:6px;padding:0.75rem 1.25rem;margin:0 0 2rem}
nav.toc b{font-size:0.8rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--dim)}
nav.toc ol{margin:0.35rem 0 0;padding-left:1.25rem}
footer{margin-top:3rem;border-top:1px solid var(--line);color:var(--dim);font-size:0.82rem}
@media print{nav.toc{display:none}body{max-width:none;padding:0}}
`;

export type ReportMeta = {
	project: string;
	item: string;
	title: string;
	sha?: string | null;
	generatedAt: string;
	source?: string | null;
};

export function renderReportHtml(meta: ReportMeta, markdown: string): string {
	const { body, toc } = renderBlocks(parseBlocks(markdown));
	const tocHtml = toc.length
		? `<nav class="toc"><b>Contents</b><ol>${toc
				.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`)
				.join("")}</ol></nav>`
		: "";
	const shaBit = meta.sha
		? ` · close <code>${esc(meta.sha.slice(0, 12))}</code>`
		: "";
	const srcBit = meta.source
		? ` · source <code>${esc(meta.source)}</code>`
		: "";
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.item)} — ${esc(meta.title)}</title>
<style>${CSS}</style></head>
<body>
<header><span class="kitem">${esc(meta.item)}</span>
<h1>${esc(meta.title)}</h1>
<p class="meta">Generated ${esc(meta.generatedAt)}${shaBit}${srcBit}</p>
</header>
${tocHtml}
<main>
${body}
</main>
<footer>HTML is a generated view of this item's markdown record — the work-graph ledger stays authoritative.</footer>
</body></html>`;
}

// Render + persist the artifact for one closed item. The markdown string is
// the record (the lane keeps it wherever it keeps records); the .html is the
// regenerable view under <repo>/.fleet/reports/.
export function writeReportArtifact(args: {
	project: string;
	item: string;
	title: string;
	markdown: string;
	sha?: string | null;
	source?: string | null;
}): { path: string; bytes: number; sha256: string } {
	const html = renderReportHtml(
		{
			project: args.project,
			item: args.item,
			title: args.title,
			sha: args.sha ?? null,
			generatedAt: new Date().toISOString(),
			source: args.source ?? null,
		},
		args.markdown,
	);
	mkdirSync(reportArtifactDir(args.project), { recursive: true });
	writeFileSync(reportArtifactPath(args.project, args.item), html);
	return {
		path: reportArtifactPath(args.project, args.item),
		bytes: Buffer.byteLength(html),
		sha256: createHash("sha256").update(html).digest("hex"),
	};
}

// Render + persist + stamp: the ONE report entry both faces share —
// `work done --report <md>` at close time and `work report <id> --file <md>`
// for a closed item (regeneration without re-closing). Inserts the same
// work.report event the done-path stamps (the trigger shreds project/work
// columns from the payload, same as every emitter).
export async function emitReportFromMd(args: {
	db: { query: (sql: string) => { run: (...p: unknown[]) => unknown } };
	project: string;
	item: string;
	title: string;
	mdPath: string;
	sha?: string | null;
}): Promise<{ path: string; bytes: number; sha256: string }> {
	const markdown = await Bun.file(args.mdPath).text();
	const artifact = writeReportArtifact({
		project: args.project,
		item: args.item,
		title: args.title,
		markdown: markdown,
		sha: args.sha ?? null,
		source: args.mdPath,
	});
	args.db
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) SELECT ?, 'work', 'work.report', scope, ?, NULL FROM work_items WHERE project = ? AND id = ?",
		)
		.run(
			Date.now(),
			JSON.stringify({
				work: args.item,
				project: args.project,
				sha256: artifact.sha256,
				bytes: artifact.bytes,
				note: "HTML view of the markdown record",
			}),
			args.project,
			args.item,
		);
	return artifact;
}

// Pure board-serving face (routes-reports.ts wraps it with the live db): the
// artifact path is DERIVED (never taken from the event payload) — a report
// route can only ever serve the item's own .fleet/reports/<id>.html. Returns
// null for unknown items, missing artifacts, or malformed ids (the caller 404s).
export function serveReport(
	gov: Parameters<typeof reportRecordFor>[0],
	project: string,
	id: string,
): Response | null {
	if (!project || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
	const rec = reportRecordFor(gov, project, id);
	if (!rec) return null;
	const path = reportArtifactPath(projectRootOf(project), id);
	if (!existsSync(path)) return null;
	try {
		const headers: Record<string, string> = {
			"content-type": "text/html; charset=utf-8",
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
		};
		return new Response(readFileSync(path, "utf8"), { headers: headers });
	} catch {
		return null;
	}
}
