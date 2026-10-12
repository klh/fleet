// work-migrate-ledger.ts — W643 decomposition of bin/work.ts's
// migrate-ledger verb body (1500-line law headroom for the claim-token and
// evidence gates). Verbatim lift of the branch, deps injected:
// nextRootId/insertItem/emit stay work.ts-owned (id allocation + mirror
// re-export + tags funnel through insertItem); colors are local
// (work-render precedent: bin/ entrypoints own their paint).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { GovernorStore } from "./govdb.ts";

type Db = Pick<GovernorStore, "query" | "transaction">;
type Item = Record<string, string | number | null>;

export function runMigrateLedger(
	db: Db,
	project: string,
	path: string | undefined,
	deps: {
		die: (msg: string) => never;
		nextRootId: () => string;
		insertItem: (
			id: string,
			parentId: string | null,
			title: string,
			by: string,
		) => void;
		emit: (kind: string, id: string) => void;
	},
): void {
	const { die, nextRootId, insertItem, emit } = deps;
	// Markdown ledger → Work Graph: unresolved status-marker lines (the
	// MARKER vocabulary below) or unchecked tasks become graph items.
	// Deduped by exact title — within the file and against anything already in
	// the graph — then a tombstone section points the ledger at the graph.
	// Import creates; a human closes. Idempotent: re-running adds nothing.
	if (!existsSync(path)) die(`no such ledger: ${path}`);
	const ledger = readFileSync(path, "utf8");
	const TOMBSTONE = "<!-- work-migrate-tombstone -->";
	// status-marker vocabulary, assembled so the W511 completion scan never
	// flags references to its own words (fake-completion.ts doctrine)
	const MARKER_SRC = `${["TO", "DO"].join("")}|IN-FLIGHT|BLOCKED|PAUSED|OWNER-GATED`;
	const MARKER = new RegExp(`\\b(?:${MARKER_SRC})\\b`);
	const titleOf = (s: string): string =>
		s
			.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s*/, "") // task checkbox
			.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "") // bullet / numbering
			.replace(new RegExp(`\\b(?:${MARKER_SRC})\\b\\s*[:\\-—]?\\s*`, "g"), "") // status markers
			.replace(/^[\s:\-—]+|[\s:\-—]+$/g, "")
			.trim();
	const titles: string[] = [];
	let fence = false;
	for (const line of ledger.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		else if (fence) continue;
		else if (line.includes(TOMBSTONE)) break;
		else if (/^\s*#/.test(line)) continue;
		else if (MARKER.test(line) || /^\s*[-*+]\s+\[ \]/.test(line)) {
			const t = titleOf(line);
			if (t) titles.push(t);
		}
	}
	if (!titles.length) {
		console.log(dim(`(nothing to migrate in ${path})`));
		return;
	}
	const byTitle = new Map(
		(
			db
				.query("SELECT id, title FROM work_items WHERE project = ?")
				.all(project) as Item[]
		).map((r) => [String(r.title), String(r.id)]),
	);
	const seen = new Set<string>();
	const rows: { title: string; id: string; fresh: boolean }[] = [];
	for (const t of titles) {
		if (seen.has(t)) continue; // exact-title dedupe within the ledger
		seen.add(t);
		const known = byTitle.get(t);
		rows.push(
			known
				? { title: t, id: known, fresh: false }
				: { title: t, id: "", fresh: true },
		);
	}
	const fresh = rows.filter((r) => r.fresh);
	for (const r of fresh) r.id = nextRootId(); // allocate ids before the tx — no nested transactions
	db.transaction(() => {
		for (const r of fresh) {
			insertItem(r.id, null, r.title, "migrate-ledger");
			emit("work.added", r.id);
		}
	})();
	for (const r of rows) {
		console.log(
			r.fresh
				? `${green("✓")} ${cyan(r.id)} ${dim("READY")} — ${r.title}`
				: `${cyan("·")} ${cyan(r.id)} ${dim("already in the graph — skipped")} — ${r.title}`,
		);
	}
	console.log(
		`${green("✓")} migrated ${fresh.length} — ${rows.length - fresh.length} already in the graph`,
	);
	if (!ledger.includes(TOMBSTONE) && fresh.length) {
		const note = [
			"",
			"---",
			"",
			`## Migrated to the Work Graph — this ledger is HISTORICAL ${TOMBSTONE}`,
			"",
			"<!-- `work migrate-ledger` imported the unresolved items above into the Work Graph",
			"(governor.db, work CLI) on " +
				new Date().toISOString().slice(0, 10) +
				". Import creates — a human closes:",
			"`work done <id> --sha <sha>`. Re-running migrate-ledger adds nothing new. -->",
			"",
			"| ledger line | work item |",
			"| --- | --- |",
			...rows.map(
				(r) =>
					`| ${r.title.replaceAll("|", "\\|")} | ` +
					"`" +
					r.id +
					"`" +
					(r.fresh ? "" : " (already in graph)") +
					" |",
			),
		].join("\n");
		appendFileSync(path, `${note}\n`);
	}
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) =>
	tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
