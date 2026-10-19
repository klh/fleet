// bench/pilot-measure.ts — W845 fleet pilot measurement (retrospective arm).
// Joins the two ledgers — work graph (board /api/tasks) + buckle spoke
// ledger (router_usage × api_keys) — plus git acceptance counts, to record
// per fleet-done item: accepted changes, rework signals, wall time, tokens.
// Charges ($), seat-credit balances, human time and hub energy are NOT
// locally instrumented; bench/pilot-measurement.md records the gaps and the
// prospective paired-arm protocol. Run: bun packages/belt/bench/pilot-measure.ts

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface TaskRow {
	project: string;
	id: string;
	title: string;
	state: string;
	parent_id: string | null;
	tail: { ts: string | null; text: string } | null;
	spend: {
		fresh: number;
		cached: number;
		out: number;
		requests: number;
		wall_ms: number;
		agent_ms: number;
		model_groups: Record<string, { in: number; out: number; cacheR: number; cacheC: number; requests: number }>;
	} | null;
}

export interface LedgerRow {
	key_name: string;
	model_group: string;
	i: number;
	o: number;
	cr: number;
	cc: number;
	r: number;
}

export interface GroupUse {
	in: number;
	out: number;
	cacheR: number;
	requests: number;
}

export interface ItemMetrics {
	id: string;
	title: string;
	state: string;
	parent_id: string | null;
	completed_at: string | null;
	workload: string;
	tokens_in: number;
	tokens_out: number;
	tokens_cached: number;
	requests: number;
	wall_min: number | null;
	agent_min: number | null;
	source: "graph-spend" | "ledger-join" | "none";
	groups: Record<string, GroupUse>;
}

export interface Summary {
	window: { since: string; until: string };
	project: string;
	items: {
		done: number;
		seen_total: number;
		with_tokens: number;
		wall_covered: number;
		failed_total: number;
		rework_children: number;
		by_workload: Record<string, number>;
	};
	acceptance: {
		merge_commits: number;
		fleet_branch_merges: number;
		insertions: number;
		deletions: number;
	};
	tokens: { by_group: Record<string, GroupUse> };
	totals: {
		tokens_in: number;
		tokens_out: number;
		requests: number;
		wall_min: number;
		agent_min: number;
		wall_min_p50: number | null;
		wall_min_p90: number | null;
		agent_min_p50: number | null;
		agent_min_p90: number | null;
	};
	not_instrumented: string[];
	uncertainty: string[];
}

/** autow845-p98b… / codex-w528-probe → "W845"/"W528"; unattributed keys → null. */
export function sidToItem(name: string): string | null {
	const m = /^(?:autow|codex-w)(\d{1,})/i.exec(name);
	return m ? `W${m[1]}` : null;
}

const WORKLOAD_RULES: [RegExp, string][] = [
	[/\btest|spec\b/i, "test"],
	[/\bfix|regression|re-?land|restore|recover/i, "fix"],
	[/\binstall|launchd|deploy|compose|hub\b/i, "install"],
	[/\bui\b|board|dashboard|component|lit\b/i, "ui"],
	[/\bbench|measure|metric|arena|pilot\b/i, "bench"],
	[/\bgate|hook|sweep|dispatch|work\b/i, "agent-plane"],
	[/\bdocs|readme|guide\b/i, "docs"],
];

/** Declared heuristic workload tag from the title — mix reporting, not truth. */
export function classifyTitle(title: string): string {
	for (const [re, tag] of WORKLOAD_RULES) if (re.test(title)) return tag;
	return "other";
}

function bump(groups: Record<string, GroupUse>, g: string, use: GroupUse): void {
	const cur = groups[g] ?? { in: 0, out: 0, cacheR: 0, requests: 0 };
	cur.in += use.in;
	cur.out += use.out;
	cur.cacheR += use.cacheR;
	cur.requests += use.requests;
	groups[g] = cur;
}

/** Merge one task's spend and/or one ledger join bucket into per-item metrics. */
export function accrete(item: ItemMetrics, spend: TaskRow["spend"], ledger?: LedgerRow): ItemMetrics {
	if (spend && Object.keys(spend.model_groups ?? {}).length > 0) {
		for (const [g, v] of Object.entries(spend.model_groups)) {
			item.tokens_in += v.in;
			item.tokens_out += v.out;
			item.tokens_cached += v.cacheR + v.cacheC;
			item.requests += v.requests;
			bump(item.groups, g, { in: v.in, out: v.out, cacheR: v.cacheR + v.cacheC, requests: v.requests });
		}
		if (spend.wall_ms > 0) {
			item.wall_min = Math.round(((item.wall_min ?? 0) + spend.wall_ms / 60_000) * 10) / 10;
			item.agent_min = Math.round(((item.agent_min ?? 0) + spend.agent_ms / 60_000) * 10) / 10;
		}
		item.source = "graph-spend";
	}
	if (ledger) {
		item.tokens_in += ledger.i;
		item.tokens_out += ledger.o;
		item.tokens_cached += ledger.cr + ledger.cc;
		item.requests += ledger.r;
		bump(item.groups, ledger.model_group, { in: ledger.i, out: ledger.o, cacheR: ledger.cr + ledger.cc, requests: ledger.r });
		if (item.source === "none") item.source = "ledger-join";
	}
	return item;
}

/** Window filter: DONE items count when their completion tail falls inside. */
export function inWindow(ts: string | null, sinceMs: number, untilMs: number): boolean {
	if (!ts) return false;
	const t = Date.parse(ts);
	return Number.isFinite(t) && t >= sinceMs && t <= untilMs;
}

function blankItem(t: TaskRow): ItemMetrics {
	return {
		id: t.id,
		title: t.title,
		state: t.state,
		parent_id: t.parent_id,
		completed_at: t.tail?.ts ?? null,
		workload: classifyTitle(t.title),
		tokens_in: 0,
		tokens_out: 0,
		tokens_cached: 0,
		requests: 0,
		wall_min: null,
		agent_min: null,
		source: "none",
		groups: {},
	};
}

/** Nearest-rank percentile over a numeric sample; null on empty input. */
export function pct(sample: number[], p: number): number | null {
	if (sample.length === 0) return null;
	const sorted = [...sample].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function buildSummary(
	tasks: TaskRow[],
	ledger: LedgerRow[],
	window: { since: string; until: string },
	project: string,
	acceptance: Summary["acceptance"],
): { items: ItemMetrics[]; summary: Summary } {
	const sinceMs = Date.parse(window.since);
	const untilMs = Date.parse(window.until);
	const byItem = new Map<string, LedgerRow[]>();
	for (const row of ledger) {
		const id = sidToItem(row.key_name);
		if (!id) continue;
		const arr = byItem.get(id) ?? [];
		arr.push(row);
		byItem.set(id, arr);
	}

	const items: ItemMetrics[] = [];
	for (const t of tasks) {
		if (t.state !== "DONE" || !inWindow(t.tail?.ts ?? null, sinceMs, untilMs)) continue;
		let item = accrete(blankItem(t), t.spend, undefined);
		for (const r of byItem.get(t.id) ?? []) item = accrete(item, undefined, r);
		items.push(item);
	}

	const byGroup: Record<string, GroupUse> = {};
	for (const it of items)
		for (const [g, v] of Object.entries(it.groups))
			bump(byGroup, g, { in: v.in, out: v.out, cacheR: v.cacheR, requests: v.requests });

	const doneIds = new Set(items.map((i) => i.id));
	const reworkChildren = tasks.filter(
		(t) => t.parent_id !== null && doneIds.has(t.parent_id) && /fix|regression|re-?land|follow-?up|restore/i.test(t.title),
	);

	const summary: Summary = {
		window,
		project,
		items: {
			done: items.length,
			seen_total: tasks.length,
			with_tokens: items.filter((i) => i.source !== "none").length,
			wall_covered: items.filter((i) => i.wall_min !== null).length,
			failed_total: tasks.filter((t) => t.state === "FAILED").length,
			rework_children: reworkChildren.length,
			by_workload: items.reduce<Record<string, number>>((a, i) => ((a[i.workload] = (a[i.workload] ?? 0) + 1), a), {}),
		},
		acceptance,
		tokens: { by_group: byGroup },
		totals: {
			tokens_in: items.reduce((s, i) => s + i.tokens_in, 0),
			tokens_out: items.reduce((s, i) => s + i.tokens_out, 0),
			requests: items.reduce((s, i) => s + i.requests, 0),
			wall_min: Math.round(items.reduce((s, i) => s + (i.wall_min ?? 0), 0)),
			agent_min: Math.round(items.reduce((s, i) => s + (i.agent_min ?? 0), 0)),
			wall_min_p50: pct(items.map((i) => i.wall_min).filter((v) => v !== null) as number[], 50),
			wall_min_p90: pct(items.map((i) => i.wall_min).filter((v) => v !== null) as number[], 90),
			agent_min_p50: pct(items.map((i) => i.agent_min).filter((v) => v !== null) as number[], 50),
			agent_min_p90: pct(items.map((i) => i.agent_min).filter((v) => v !== null) as number[], 90),
		},
		not_instrumented: [
			"charges_usd — provider pricing + retry/streaming reconciliation owned by W843",
			"seat_credits — Copilot/seat balances are provider-side; only seat-carried tokens are local",
			"human_time — no per-item operator-time surface (NEED_DECISION history not queryable via CLI/board)",
			"hub_energy_ops — no meter on the Mac spoke or hubs; ops cost = power + launchd cycles, unrecorded",
		],
		uncertainty: [
			"wall/agent time covers only buckle-gated lanes (spend.wall_ms > 0); earlier items have tokens only",
			"failed_total and rework_children are REWORK PROXIES — real defect tracking is not instrumented",
			"workload mix is a title-keyword heuristic, not a scope audit",
			"single-arm retrospective: no recorded manual (without-Fleet) arm exists; no equivalence claim possible",
		],
	};
	return { items, summary };
}

// --- IO tails (thin; logic above is pure) ---

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help") return { help: "1" };
		if (a.startsWith("--")) args[a.slice(2)] = argv[++i] ?? "";
	}
	return args;
}

async function fetchTasks(board: string): Promise<TaskRow[]> {
	const res = await fetch(`${board}/api/tasks`, { signal: AbortSignal.timeout(8000) });
	if (!res.ok) throw new Error(`board ${board} -> ${res.status}`);
	const body = (await res.json()) as { tasks: TaskRow[] };
	return body.tasks ?? [];
}

function fetchLedger(dbPath: string, since: string, until: string): LedgerRow[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query(
				`SELECT ak.name AS key_name, ru.model_group, SUM(ru.in_tok) i, SUM(ru.out_tok) o,
				        SUM(ru.cache_r) cr, SUM(ru.cache_c) cc, SUM(ru.requests) r
				 FROM router_usage ru JOIN api_keys ak ON ru.key = ak.key_id
				 WHERE ru.hour_bucket >= ? AND ru.hour_bucket <= ? AND ak.name IS NOT NULL
				 GROUP BY ak.name, ru.model_group`,
			)
			.all(since.slice(0, 13) + ":00", until.slice(0, 13) + ":00") as LedgerRow[];
	} finally {
		db.close();
	}
}

function gitAcceptance(repo: string, since: string, until: string): Summary["acceptance"] {
	const range = ["--since", since, "--until", until];
	const merges = spawnSync("git", ["-C", repo, "log", "--merges", ...range, "--format=%s"], { encoding: "utf8" });
	const mergeSubjects = (merges.stdout ?? "").split("\n").filter(Boolean);
	const numstat = spawnSync("git", ["-C", repo, "log", "--no-merges", ...range, "--numstat", "--format=%x00"], {
		encoding: "utf8",
	});
	let insertions = 0;
	let deletions = 0;
	for (const line of (numstat.stdout ?? "").split("\n")) {
		const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
		if (m) {
			insertions += m[1] === "-" ? 0 : Number(m[1]);
			deletions += m[2] === "-" ? 0 : Number(m[2]);
		}
	}
	return {
		merge_commits: mergeSubjects.length,
		fleet_branch_merges: mergeSubjects.filter((s) => /[Ww]\d{2,}/.test(s)).length,
		insertions,
		deletions,
	};
}

const HELP = `pilot-measure — W845 fleet pilot measurement (retrospective arm)

Usage: bun packages/belt/bench/pilot-measure.ts [--since ISO] [--until ISO]
       [--out DIR] [--board URL] [--ledger PATH] [--project PATH] [--help]

Defaults: since=2026-10-06T00:00:00Z (ledger start), until=now,
          out=.pilot-measure, board=http://127.0.0.1:7799,
          ledger=~/.claude/local-llm/buckle.db, project=this repo's common dir.
Writes pilot-items.jsonl + pilot-summary.json into --out and prints a table.`;

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
		process.exit(0);
	}
	const since = args.since ?? "2026-10-06T00:00:00Z";
	const until = args.until ?? new Date().toISOString();
	const outDir = resolve(args.out ?? ".pilot-measure");
	const board = args.board ?? "http://127.0.0.1:7799";
	const ledgerPath = (args.ledger ?? "~/.claude/local-llm/buckle.db").replace(/^~/, process.env.HOME ?? "");
	const commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
	const project = args.project ?? resolve(commonDir);

	const tasks = await fetchTasks(board);
	const ledger = fetchLedger(ledgerPath, since, until);
	const acceptance = gitAcceptance(project, since, until);
	const { items, summary } = buildSummary(tasks, ledger, { since, until }, project, acceptance);

	mkdirSync(outDir, { recursive: true });
	await Bun.write(`${outDir}/pilot-items.jsonl`, `${items.map((i) => JSON.stringify(i)).join("\n")}\n`);
	await Bun.write(`${outDir}/pilot-summary.json`, `${JSON.stringify(summary, null, "\t")}\n`);

	console.log(`window ${since} .. ${until}`);
	console.log(`items done=${summary.items.done} tokens-covered=${summary.items.with_tokens} wall-covered=${summary.items.wall_covered}`);
	console.log(`acceptance fleet-merges=${summary.acceptance.fleet_branch_merges}/${summary.acceptance.merge_commits} +${summary.acceptance.insertions} -${summary.acceptance.deletions}`);
	console.log(`totals in=${summary.totals.tokens_in} out=${summary.totals.tokens_out} req=${summary.totals.requests} wall=${summary.totals.wall_min}m agent=${summary.totals.agent_min}m p50=${summary.totals.wall_min_p50}m p90=${summary.totals.wall_min_p90}m`);
	for (const [g, v] of Object.entries(summary.tokens.by_group)) console.log(`  ${g}: in=${v.in} out=${v.out} cacheR=${v.cacheR} req=${v.requests}`);
	console.log(`workload: ${JSON.stringify(summary.items.by_workload)}`);
	console.log(`not instrumented: ${summary.not_instrumented.length} surfaces (see pilot-summary.json)`);
}
