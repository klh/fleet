// hooks/coord/fleet-metrics.ts — W2569: cmdMetrics carved out of fleet.ts
// at the 1200-line stop rule. The W3 control-plane metrics fold: per-role runs,
// per-item wall/agent time, token/cost attribution, dwell, friction, self-serve
// — both faces render FROM the metrics JSON contract.
import { homedir } from "node:os";
import { z } from "zod";
import {
	type BriefWeight,
	buckleLaneTokens,
	type LaneTokens,
	measureBriefWeight,
} from "../../scripts/lib/brief-weight.ts";
import { msSet } from "../lib/govdb/machine-state.ts";
import {
	type ItemSpend,
	itemSpend,
	laneSpendRows,
	resolveBuckleDb,
} from "../lib/lanes/lane-spend.ts";
import { claimWindows } from "../lib/work/work-timing.ts";
import { verbContract, wantsJson } from "./json-out.ts";
import {
	amber,
	arg,
	cyan,
	type Database,
	db,
	die,
	dim,
	projectIdentity,
	realpathSync,
	red,
	resolve,
	tokenUsage,
	workTiming,
} from "./shared.ts";

// W2569: the metrics machine contract — the whole W3 fold, unparsed.
const metricsContract = verbContract({
	project: z.string(),
	days: z.number().int(),
	runs: z.array(z.object({ role: z.string(), n: z.number().int() })),
	items: z.object({
		done: z.number().int(),
		open: z.number().int(),
		medianWallMs: z.number(),
		medianAgentMs: z.number(),
	}),
	rows: z.array(
		z.object({
			work: z.string(),
			wallMs: z.number(),
			agentMs: z.number(),
			tokens: z.number().nullable(),
			spendTok: z.number().nullable(),
			claims: z.number().int(),
			state: z.enum(["open", "done", "failed"]),
		}),
	),
	dwell: z.record(
		z.string(),
		z.object({ ms: z.number(), n: z.number().int(), ongoing: z.number() }),
	),
	friction: z.object({
		conflicts: z.number().int(),
		rework: z.number().int(),
		failed: z.number().int(),
	}),
	selfServe: z.object({ kb: z.number().int(), lesson: z.number().int() }),
});

export async function cmdMetrics(rest: string[]): Promise<void> {
	// W3 — control-plane metrics: did the fleet actually move fast? Runs per
	// role, per-item wall vs agent time (W15 derivation in govdb.ts), lane
	// dwell in WAIT_RATE / WAIT_DED / PAUSED, conflicts, repairs. Terse table
	// + a facts snapshot fact (metrics.snapshot.<date>) for trend diffing.
	const known = new Set(["--days", "--json"]);
	const json = wantsJson(rest);
	const projArgs: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (known.has(rest[i])) {
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) die(`unknown option: ${rest[i]}`);
		projArgs.push(rest[i]);
	}
	const now = Date.now();
	const days = Number(arg("--days") ?? 7);
	const cut = now - days * 86_400_000;
	let project = projectIdentity();
	if (projArgs[0]) {
		const g = Bun.spawnSync(
			["git", "-C", projArgs[0], "rev-parse", "--git-common-dir"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const dir =
			g.exitCode === 0 ? new TextDecoder().decode(g.stdout).trim() : "";
		project = dir
			? realpathSync(resolve(projArgs[0], dir))
			: realpathSync(projArgs[0]);
	}
	const name =
		project
			.split("/")
			.pop()
			?.replace(/\.git$/, "") ||
		project.split("/").slice(-2, -1).pop() ||
		project;
	const runs = db
		.query(
			"SELECT role, COUNT(*) AS n FROM sessions WHERE project = ? AND started_at >= ? GROUP BY role ORDER BY n DESC",
		)
		.all(project, cut) as { role: string; n: number }[];
	if (!json) console.log(`METRICS ${name} (last ${days}d)`);
	if (!json)
		console.log(
			`  runs: ${runs.reduce((a, r) => a + r.n, 0)}${runs.length ? ` (${runs.map((r) => `${r.n} ${r.role}`).join(", ")})` : ""}`,
		);
	// per-item wall/agent time — the W15 derivation, straight off the bus
	const timing = workTiming(db as Database, project, now).filter(
		(t) => t.lastEvent >= cut || (!t.done && !t.failed),
	);
	const doneItems = timing.filter((t) => t.done && t.firstClaim > 0); // lane work: claimed → done (auto-rollups excluded)
	const openN = timing.filter((t) => !t.done && !t.failed).length;
	const med = (xs: number[]): number =>
		xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
	const fmt = (ms: number): string => {
		if (!ms) return "—";
		const m = Math.round(ms / 60_000);
		return m >= 60
			? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
			: `${m}m`;
	};
	if (!json)
		console.log(
			`  items: ${doneItems.length} done, ${openN} open — median done item: wall ${fmt(med(doneItems.map((t) => t.wallMs)))}, agent ${fmt(med(doneItems.map((t) => t.agentMs)))}`,
		);
	// W24 — usage per task: windowed transcript tokens per item. Approximation —
	// attribution is by claim-window overlap in time, not causality (a session
	// working several items serially shares its transcript across windows).
	const tokens = tokenUsage(db as Database, project, now);
	// W635 — cost per DONE item: buckle-ledger lane spend joined to claim
	// windows (lib/lane-spend.ts). Window attribution like W24 tokens; a
	// missing/unreadable ledger yields null — no cost section, never blocks.
	const ledger = resolveBuckleDb();
	let costs: Map<string, ItemSpend> | null = null;
	if (ledger) {
		try {
			costs = itemSpend(
				laneSpendRows(ledger, `${new Date(cut).toISOString().slice(0, 13)}:00`),
				claimWindows(db as Database, project, now).windows,
			);
		} catch {
			costs = null; // unreadable ledger — fail soft
		}
	}
	const shown = [...timing].sort((a, b) => b.wallMs - a.wallMs).slice(0, 8);
	const fmtTok = (n: number): string =>
		n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${Math.round(n / 1e3)}k`
				: `${n}`;
	const totalTok = (c: ItemSpend): number => c.in + c.out + c.cacheR + c.cacheC;
	let sumIn = 0;
	let sumOut = 0;
	let tokN = 0;
	const jsonRows: z.infer<typeof metricsContract>["rows"] = [];
	for (const t of shown) {
		const k = tokens.get(t.work);
		if (k) {
			tokN++;
			sumIn += k.in + k.cacheR + k.cacheC;
			sumOut += k.out;
		}
		const tok = k ? fmtTok(k.in + k.out + k.cacheR + k.cacheC) : "-";
		const c = costs?.get(t.work);
		const spend =
			c && c.in + c.out + c.cacheR + c.cacheC > 0
				? fmtTok(c.in + c.out + c.cacheR + c.cacheC)
				: "-";
		jsonRows.push({
			work: t.work,
			wallMs: t.wallMs,
			agentMs: t.agentMs,
			tokens: k ? k.in + k.out + k.cacheR + k.cacheC : null,
			spendTok:
				c && c.in + c.out + c.cacheR + c.cacheC > 0 ? totalTok(c) : null,
			claims: t.claims,
			state: t.failed ? "failed" : t.done ? "done" : "open",
		});
		if (!json)
			console.log(
				`    ${cyan(t.work.padEnd(8))} wall ${fmt(t.wallMs).padStart(6)}  agent ${fmt(t.agentMs).padStart(6)}  tok ${tok.padStart(6)}  spend ${spend.padStart(6)}  ${t.claims} claim${t.claims === 1 ? "" : "s"}${t.failed ? red(" FAILED") : t.done ? "" : amber(" open")}`,
			);
	}
	if (shown.length)
		if (!json)
			console.log(
				`  tokens (approx, window-attributed): in ${tokN ? fmtTok(sumIn) : "-"} · out ${tokN ? fmtTok(sumOut) : "-"} across ${shown.length} shown items`,
			);
	// W635 cost summary: median spend per DONE item + per-class (model_group)
	// split — the dispatch-mix decision metric. Tokens, not $: pricing stays
	// in machine config (config-over-code).
	let costStats: {
		costed: number;
		median: number;
		groups: [string, number][];
	} | null = null;
	if (costs) {
		const doneCosts = doneItems
			.map((t) => costs?.get(t.work))
			.filter((c): c is ItemSpend => c != null);
		const costed = doneCosts.filter((c) => totalTok(c) > 0);
		if (costed.length) {
			const byGroup = new Map<string, number>();
			for (const c of costed)
				for (const [g, v] of c.groups)
					byGroup.set(
						g,
						(byGroup.get(g) ?? 0) + v.in + v.out + v.cacheR + v.cacheC,
					);
			costStats = {
				costed: costed.length,
				median: med(costed.map(totalTok)),
				groups: [...byGroup.entries()].sort((a, b) => b[1] - a[1]),
			};
			if (!json)
				console.log(
					`  cost/item (buckle ledger, window-attributed): ${costStats.costed}/${doneItems.length} done items costed — median ${fmtTok(costStats.median)} tok/item`,
				);
			if (costStats.groups.length)
				if (!json)
					console.log(
						`    ${costStats.groups
							.slice(0, 5)
							.map(([g, tok]) => `${g} ${fmtTok(tok)}`)
							.join(" · ")}`,
					);
		}
	}
	// W633 brief weight: the per-dispatch instruction injection (brief
	// boilerplate + AGENTS.md chain + machine harness) and the REAL per-lane
	// in_tok from the buckle ledger — the weight audit, reportable per run.
	const bw = await briefWeight(days);
	// tty-only from here: the JSON face returns before the snapshot line
	if (bw && !json) console.log(bw.line);
	if (bw?.laneTok?.length)
		if (!json)
			console.log(
				`  buckle in_tok/req 30d: ${bw.laneTok
					.slice(0, 3)
					.map(
						(l) =>
							`${l.lane.replace(/-p98b.*$/, "")} ${fmtTok(Math.round(l.inTok / Math.max(1, l.reqs)))}`,
					)
					.join(" · ")} (${bw.laneTok.length} lanes)`,
			);
	// dwell: PAUSED windows are evented (paused → resume_ready); WAIT_RATE /
	// WAIT_DED leave no event trail, so ongoing dwell = now − lane.<sid>.state
	// fact ts (the only state history facts keep is their own last ts).
	const dwell: Record<string, { ms: number; n: number; ongoing: number }> = {};
	const pausedBy: Record<string, number> = {};
	for (const e of db
		.query(
			"SELECT ts, source, kind, target FROM events WHERE kind IN ('pause_requested','paused','resume_ready') AND ts >= ? ORDER BY ts, id",
		)
		.all(cut) as {
		ts: number;
		source: string;
		kind: string;
		target: string | null;
	}[]) {
		if (e.kind === "paused") pausedBy[e.source] = e.ts;
		else if (
			e.kind === "resume_ready" &&
			e.target &&
			pausedBy[e.target] != null
		) {
			if (!dwell.PAUSED) dwell.PAUSED = { ms: 0, n: 0, ongoing: 0 };
			const b = dwell.PAUSED;
			b.ms += Math.max(0, e.ts - pausedBy[e.target]);
			b.n++;
			delete pausedBy[e.target];
		}
	}
	for (const f of db
		.query(
			"SELECT value, ts FROM facts WHERE key LIKE 'lane.%.state' AND value IN ('WAIT_RATE','WAIT_DED','PAUSED')",
		)
		.all() as { value: string; ts: number }[]) {
		if (!dwell[f.value]) dwell[f.value] = { ms: 0, n: 0, ongoing: 0 };
		const b = dwell[f.value];
		b.ongoing += Math.max(0, now - f.ts);
	}
	const dwellLine = Object.entries(dwell)
		.filter(([, b]) => b.ms || b.ongoing)
		.map(
			([k, b]) =>
				`${k}${b.ms ? ` ${fmt(b.ms)}${b.n ? ` (${b.n} win)` : ""}` : ""}${b.ongoing ? ` +${fmt(b.ongoing)} ongoing` : ""}`,
		)
		.join(" · ");
	if (dwellLine && !json) console.log(`  dwell: ${dwellLine}`);
	// friction: conflicts, rework (items claimed >1× — repairs/reclaims), fails
	const conflicts = (
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'conflict' AND ts >= ? AND project = ?",
			)
			.get(cut, project) as { n: number }
	).n;
	const failedQ =
		"SELECT COUNT(*) AS n FROM events WHERE kind = 'work.failed' AND ts >= ? AND project = ?";
	const failed = (db.query(failedQ).get(cut, project) as { n: number }).n;
	const rework = timing.filter((t) => t.claims > 1).length;
	if (!json)
		console.log(
			`  friction: ${conflicts} conflict event${conflicts === 1 ? "" : "s"}, ${rework} re-claimed item${rework === 1 ? "" : "s"}, ${failed} failed`,
		);
	// self-serve: consults the plane resolved without spending a human's context
	const selfServe = db
		.query(
			"SELECT state, COUNT(*) AS n FROM consults WHERE project = ? AND answered_at >= ? AND state IN ('KB','LESSON') GROUP BY state",
		)
		.all(project, cut) as {
		state: string;
		n: number;
	}[];
	const kbN = selfServe.find((s) => s.state === "KB")?.n ?? 0;
	const lessonN = selfServe.find((s) => s.state === "LESSON")?.n ?? 0;
	if (!json)
		console.log(
			`  self-serve: ${kbN} kb + ${lessonN} lesson answer${lessonN === 1 ? "" : "s"} (no expert round-trip)`,
		);
	// snapshot fact for trend diffing across waves
	const snap = {
		ts: now,
		days,
		project,
		runs: runs.reduce((a, r) => a + r.n, 0),
		byRole: Object.fromEntries(runs.map((r) => [r.role, r.n])),
		done: doneItems.length,
		open: openN,
		medianWallMs: med(doneItems.map((t) => t.wallMs)),
		medianAgentMs: med(doneItems.map((t) => t.agentMs)),
		dwell,
		conflicts,
		rework,
		failed,
		costItems: costStats?.costed,
		medianItemSpendTok: costStats?.median,
		costByGroup: costStats ? Object.fromEntries(costStats.groups) : undefined,
		brief_weight: bw && {
			brief: bw.w.brief,
			brief_chars: bw.w.briefChars,
			root_agents: bw.w.rootAgents,
			pkg_max: bw.w.pkgAgents[0] ?? null,
			harness: bw.w.harness,
			per_lane_static_tok: bw.w.perLaneStaticTok,
			buckle_lanes_30d: bw.laneTok.length,
		},
	};
	const snapKey = `metrics.snapshot.${new Date(now).toISOString().slice(0, 10)}`;
	msSet(db, snapKey, JSON.stringify(snap), "coord", now);
	if (wantsJson(rest)) {
		// W2569: the machine face — same fold, one envelope (runs/rows/dwell/
		// friction/self-serve unparsed; the snapshot fact stays the trend record)
		metricsContract.emit({
			schema_version: 1,
			verb: "metrics",
			project,
			days,
			runs,
			items: {
				done: doneItems.length,
				open: openN,
				medianWallMs: med(doneItems.map((t) => t.wallMs)),
				medianAgentMs: med(doneItems.map((t) => t.agentMs)),
			},
			rows: jsonRows,
			dwell,
			friction: { conflicts, rework, failed },
			selfServe: { kb: kbN, lesson: lessonN },
		});
		return;
	}
	if (!json) console.log(`  ${dim(`snapshot → ${snapKey}`)}`);
}

/** W633: the brief+protocol weight line + per-lane real in_tok from the
 *  buckle ledger (BUCKLE_DB or the spoke default path). Null when the
 *  composer cannot load (non-fleet runs) — the section is omitted, never
 *  faked. */
async function briefWeight(
	days: number,
): Promise<{ w: BriefWeight; line: string; laneTok: LaneTokens[] } | null> {
	const fleetTree = resolve(import.meta.dir, "..", "..", "..", "..");
	const w = await measureBriefWeight(fleetTree);
	if (!w) return null;
	const pkg = w.pkgAgents[0];
	const parts = [
		`brief ${w.brief}`,
		w.rootAgents ? `agents-root ${w.rootAgents}` : null,
		pkg
			? `pkg-max ${pkg.tok} (${pkg.file.replace("packages/", "").replace("/AGENTS.md", "")})`
			: null,
		w.harness ? `harness ${w.harness}` : null,
	];
	const line = `  brief weight (W633, approx tok): ${parts.filter(Boolean).join(" · ")} ⇒ ${w.perLaneStaticTok}/lane`;
	const laneTok = buckleLaneTokens(buckleDbPath(), days);
	return { w, line, laneTok };
}

const buckleDbPath = (): string =>
	process.env.BUCKLE_DB || `${homedir()}/.claude/local-llm/buckle.db`;
