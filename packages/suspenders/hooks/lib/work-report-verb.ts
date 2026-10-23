// hooks/lib/work-report-verb.ts — W1131 §10/§11: the `work report` verb
// body, its own lib (work.ts sits at the 1500-line cap). §2 formats chosen
// by MEDIUM, §10 modes, §11 scoping — every view renders FROM the §1
// versioned contract (work-report.ts), never from the graph.

import type { Database } from "bun:sqlite";
import {
	buildReportContract,
	parseReportWindow,
	type ReportContract,
	type ReportRow,
	reportRows,
	reportTableLinkOpts,
} from "./work-report.ts";
import {
	colorEnabled,
	type ReportFormat,
	renderReport,
} from "./work-report-render.ts";
import {
	deltaStatePath,
	deltaTransitions,
	readDeltaState,
	renderDeltaLine,
	renderStatusline,
	renderTree,
	watchViewOf,
	writeDeltaState,
} from "./work-report-modes.ts";
import { type LaneLive, laneLiveRows } from "./work-report-live.ts";
import { resolveBuckleDb } from "./lane-spend.ts";
import { idList } from "./verb-kit.ts";
import { resolveStoreHttpBase } from "./govdb-store.ts";

// §10 mode switches — mutually exclusive; §2 formats (--format value).
const MODES = ["--tree", "--delta", "--statusline", "--watch"];
const FORMATS = ["tty", "md", "plain", "json"];

/** Bounded stdin read for the §10 statusline auto-scope: Claude Code pipes
 *  its statusLine JSON on stdin; a TTY stdin (no JSON) rides the deadline.
 *  The timer is unref'd + cleared — a raced deadline never holds the loop. */
export const readStdinBounded = (ms = 150, max = 8192): Promise<string> =>
	new Promise((res) => {
		const chunks: Buffer[] = [];
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			process.stdin.removeListener("data", onData);
			process.stdin.removeListener("end", onEnd);
			res(Buffer.concat(chunks).toString("utf8", 0, max));
		};
		const onData = (c: Buffer): void => {
			chunks.push(c);
			let n = 0;
			for (const x of chunks) n += x.length;
			if (n >= max) finish();
		};
		const onEnd = (): void => finish();
		timer = setTimeout(finish, ms);
		timer.unref?.();
		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
	});

/** §10 statusline stdin JSON → scope: workspace.git_worktree (a worktree IS
 *  the project identity) else cwd; session_id feeds --mine without --as.
 *  Garbage JSON degrades to the fallback scope — a statusline never dies. */
export const statuslineScopeOf = (
	raw: string,
	fallback: string,
): { project: string; sessionId: string | null } => {
	try {
		const j = JSON.parse(raw) as {
			session_id?: string;
			cwd?: string;
			workspace?: { git_worktree?: string };
		};
		const p = j.workspace?.git_worktree ?? j.cwd;
		return {
			project: typeof p === "string" && p ? p : fallback,
			sessionId: typeof j.session_id === "string" ? j.session_id : null,
		};
	} catch {
		return { project: fallback, sessionId: null };
	}
};

/** The verb's face: exactly what work.ts's dispatch hands over, plus the
 *  hermetic pins tests use (clock, TTY-ness, stdin, live rows, watch leg). */
export interface ReportVerbArgs {
	db: Database;
	project: string;
	pos: string[];
	flag: (n: string) => string | null;
	rest: string[];
	die: (m: string) => never;
	/** the calling session's sid (§11 --mine fallback when no --as) */
	sessionSid?: string | null;
	/** pins: wall clock, stdout TTY, stdin TTY + a raw statusline payload */
	now?: number;
	isTty?: boolean;
	stdinTty?: boolean;
	stdinRaw?: string | null;
	/** pin: live lane facts (else laneLiveRows over the real ledger) */
	live?: LaneLive[];
	/** pin: the spend ledger path (tests pin null = attribution off; unset
	 *  keeps the production face — itemAttribution resolves the real one) */
	ledger?: string | null;
	/** pin: the --watch loop swapped for a test double */
	watch?: (first: ReportContract, build: () => ReportContract) => Promise<void>;
}

/** The `work report` verb (§2/§10/§11): flags → scope → rows → contract →
 *  view. One die path per misuse; every output renders FROM the contract. */
export const runReportVerb = async (a: ReportVerbArgs): Promise<void> => {
	const { db, project, die } = a;
	const { pos, flag, rest } = a;
	const now = a.now ?? Date.now();
	const bad = (cond: boolean, msg: string): void => {
		if (cond) die(msg);
	};
	// §10: the four modes are mutually exclusive; §2 --format validates loud
	const picked = MODES.filter((m) => rest.includes(m));
	bad(picked.length > 1, `report: ${picked.join(" ")} are mutually exclusive`);
	const fmtRaw = flag("--format");
	bad(
		fmtRaw !== null && !FORMATS.includes(fmtRaw),
		"report: bad --format — try tty | md | plain | json",
	);
	const mine = rest.includes("--mine");
	const all = rest.includes("--all");
	bad(mine && all, "report: --mine and --all are exclusive");
	const ids = idList([...pos, ...(flag("--ids") ?? "").split(",")]);
	bad(
		Boolean(ids.length) && all,
		"report: --ids is project-scoped — drop --all",
	);
	const winRaw = flag("--done-window");
	const doneWindowMs = winRaw ? parseReportWindow(winRaw) : null;
	bad(
		winRaw !== null && doneWindowMs === null,
		"report: bad --done-window — try 45m | 12h | 2d (s/m/h/d, ≤30d)",
	);
	// §10 --statusline: Claude Code pipes its statusLine JSON on stdin —
	// auto-scope to that workspace (project) and session (--mine sid).
	let scopeProject = project;
	let stdinSession: string | null = null;
	const stdinTty = a.stdinTty ?? Boolean(process.stdin.isTTY);
	if (rest.includes("--statusline") && !stdinTty) {
		const raw =
			a.stdinRaw !== undefined ? (a.stdinRaw ?? "") : await readStdinBounded();
		const sc = statuslineScopeOf(raw, project);
		scopeProject = sc.project;
		stdinSession = sc.sessionId;
	}
	const mineSid = mine
		? (flag("--as") ?? stdinSession ?? a.sessionSid ?? null)
		: null;
	bad(mine && !mineSid, "report: --mine needs --as <sid>");
	// §8 live join: the ledger's own 48h lookback (the done window's ceiling)
	const live =
		a.live ??
		(resolveBuckleDb()
			? laneLiveRows(
					resolveBuckleDb() as string,
					new Date(now - 48 * 3_600_000).toISOString(),
				)
			: []);
	// §11 --all sweeps every project the graph holds; --ids stay project-scoped
	const projects = all
		? (
				db.query("SELECT DISTINCT project FROM work_items").all() as {
					project: string | null;
				}[]
			)
				.map((r) => r.project)
				.filter((p): p is string => Boolean(p))
		: [scopeProject];
	const rows: ReportRow[] = [];
	let missing: string[] = [];
	for (const p of projects) {
		const one = reportRows(db, p, {
			ids,
			doneWindowMs: doneWindowMs ?? undefined,
			now,
			live,
			mineSid,
			...(a.ledger !== undefined ? { ledger: a.ledger } : {}),
		});
		if (one.missing.length > 0) missing = one.missing;
		rows.push(...one.rows);
	}
	bad(missing.length > 0, `no such work item in this project: ${missing[0]}`);
	const outTty = a.isTty ?? Boolean(process.stdout.isTTY);
	const boardBase = reportTableLinkOpts(outTty).baseUrl;
	// §7 lanes in other projects: live sids none of this scope's rows claim
	const ownerSids = new Set(
		rows.map((r) => r.ownerSid).filter((s): s is string => Boolean(s)),
	);
	const lanesOther = new Set(
		live.filter((l) => !ownerSids.has(l.sid)).map((l) => l.sid),
	).size;
	const build = (): ReportContract =>
		buildReportContract(rows, {
			project: scopeProject,
			scope: all ? "all" : mine ? "mine" : "project",
			now,
			boardBase,
			lanesOtherProjects: lanesOther > 0 ? lanesOther : null,
		});
	const contract = build();
	// §10 mode outputs — every branch renders FROM the same contract
	if (rest.includes("--tree")) {
		console.log(renderTree(contract, { boardUrl: boardBase }));
		return;
	}
	if (rest.includes("--statusline")) {
		process.stdout.write(`${renderStatusline(contract)}\n`);
		return;
	}
	if (rest.includes("--delta")) {
		const path = deltaStatePath(all ? "all" : scopeProject);
		const line = renderDeltaLine(
			deltaTransitions(readDeltaState(path), contract),
		);
		if (line) console.log(line);
		writeDeltaState(path, contract);
		return;
	}
	if (rest.includes("--watch")) {
		if (a.watch) await a.watch(contract, build);
		else await watchLoop(contract, build, die);
		return;
	}
	// §2: the format is chosen by MEDIUM — tty on a terminal, md piped;
	// §2 colour matrix; §9 OSC 8 links on a real TTY
	const text = renderReport(contract, {
		format: (fmtRaw as ReportFormat) ?? (outTty ? "tty" : "md"),
		color: colorEnabled({ tty: outTty, noColor: rest.includes("--no-color") }),
		links: outTty && !process.env.SUSPENDERS_NO_HYPERLINK,
		wide: rest.includes("--wide"),
	});
	console.log(text);
};

/** §10 --watch: the coord WS push (W303) drives redraw-in-place — never a
 *  poll loop. A byte-identical view redraws nothing; connection close is a
 *  quiet exit 0. No HTTP store face (in-process binding) dies loud. */
const watchLoop = async (
	first: ReportContract,
	build: () => ReportContract,
	die: (m: string) => never,
): Promise<void> => {
	const bound = resolveStoreHttpBase();
	if (!bound)
		die("report: --watch needs the store HTTP face (GOVERNOR_STORE_URL)");
	const wsBase = bound.base.replace(/^http/, "ws");
	const params = new URLSearchParams();
	if (bound.token) params.set("token", bound.token);
	let lastView = "";
	let lastLines = 0;
	const draw = (c: ReportContract): void => {
		const view = watchViewOf(c, process.stdout.columns || 80);
		if (view === lastView) return;
		if (lastLines > 0) process.stdout.write(`\x1b[${lastLines}A\x1b[J`);
		lastView = view;
		lastLines = view.split("\n").length;
		process.stdout.write(`${view}\n`);
	};
	draw(first);
	const ws = new WebSocket(`${wsBase}/subscribe?${params}`);
	ws.addEventListener("message", () => draw(build()));
	ws.addEventListener("close", () => process.exit(0));
	await new Promise<void>(() => {});
};
