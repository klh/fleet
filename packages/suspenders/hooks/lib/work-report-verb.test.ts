// W1131 §10/§11 tests — the verb + the modes: die paths, format-by-MEDIUM,
// tree/delta/statusline shapes, --all/--mine scoping, stdin scope parse.
// Hermetic: fixture db (work_items+events), pinned clock/TTY/live rows.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deltaStatePath,
	deltaTransitions,
	renderDeltaLine,
	renderStatusline,
	renderTree,
	watchViewOf,
} from "./work-report-modes.ts";
import {
	buildReportContract,
	type ReportRow,
	reportRows,
} from "./work-report.ts";
import { runReportVerb, statuslineScopeOf } from "./work-report-verb.ts";

const T0 = 1_700_000_000_000;

const fixtureDb = (): Database => {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, title TEXT, updated_at INTEGER, owner_sid TEXT)",
	);
	d.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
	);
	return d;
};

const add = (
	d: Database,
	id: string,
	state: string,
	age: number,
	owner: string | null = null,
	proj = "p",
): void => {
	d.prepare(
		"INSERT INTO work_items (project, id, state, title, updated_at, owner_sid) VALUES (?, ?, ?, ?, ?, ?)",
	).run(proj, id, state, `t-${id}`, T0 - age, owner);
};

const rowsOf = (d: Database): ReportRow[] =>
	reportRows(d, "p", { now: T0, ledger: null }).rows;

const contractOf = (d: Database): ReturnType<typeof buildReportContract> =>
	buildReportContract(rowsOf(d), { project: "p", now: T0 });

/** Runs the verb against the fixture db, capturing console.log (restored
 *  before asserts); a die path lands in `died`, never kills the test. */
const run = async (
	d: Database,
	rest: string[],
	flag: (n: string) => string | null = () => null,
	over: Partial<Parameters<typeof runReportVerb>[0]> = {},
): Promise<{ logs: string[]; died: string | null }> => {
	// verb-kit semantics: --format is a FLAG (it consumes a value) — translate
	// a rest pair into the flag fn exactly like the real parse does
	const fi = rest.indexOf("--format");
	const fv = fi >= 0 ? (rest[fi + 1] ?? null) : null;
	const flag2 = (n: string): string | null =>
		n === "--format" && fi >= 0 ? fv : flag(n);
	const rest2 =
		fi >= 0 ? rest.filter((_, i) => i !== fi && i !== fi + 1) : rest;
	const logs: string[] = [];
	const orig = console.log;
	const origWrite = process.stdout.write;
	console.log = (...x: unknown[]): void => {
		logs.push(x.join(" "));
	};
	// statusline writes stdout directly — capture both faces
	process.stdout.write = ((s: unknown): boolean => {
		logs.push(typeof s === "string" ? s : "");
		return true;
	}) as typeof origWrite;
	let died: string | null = null;
	try {
		await runReportVerb({
			db: d,
			project: "p",
			pos: [],
			flag: flag2,
			rest: rest2,
			die: (m: string) => {
				throw new Error(m);
			},
			now: T0,
			isTty: false,
			stdinTty: true,
			live: [],
			...over,
		});
	} catch (e) {
		died = e instanceof Error ? e.message : String(e);
	}
	console.log = orig;
	process.stdout.write = origWrite;
	return { logs, died };
};

describe("W1131 §10/§2 — verb die paths", () => {
	test("modes are mutually exclusive; bad --format dies", async () => {
		const a = await run(fixtureDb(), ["--tree", "--delta"]);
		expect(a.died).toBe("report: --tree --delta are mutually exclusive");
		const b = await run(fixtureDb(), [], (n) =>
			n === "--format" ? "xml" : null,
		);
		expect(b.died).toBe("report: bad --format — try tty | md | plain | json");
	});

	test("--mine/--all and --ids/--all exclusivity dies", async () => {
		const a = await run(fixtureDb(), ["--mine", "--all"]);
		expect(a.died).toBe("report: --mine and --all are exclusive");
		const b = await run(fixtureDb(), ["--all"], (n) =>
			n === "--ids" ? "W1,W2" : null,
		);
		expect(b.died).toBe("report: --ids is project-scoped — drop --all");
	});

	test("--mine without any sid dies", async () => {
		const { died } = await run(fixtureDb(), ["--mine"]);
		expect(died).toBe("report: --mine needs --as <sid>");
	});

	test("bad --done-window dies", async () => {
		const { died } = await run(fixtureDb(), [], (n) =>
			n === "--done-window" ? "3x" : null,
		);
		expect(died).toBe(
			"report: bad --done-window — try 45m | 12h | 2d (s/m/h/d, ≤30d)",
		);
	});
});

describe("W1131 §1 — the json contract", () => {
	test("schema v1: OTel usage keys; unreported renders null", async () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 3_600_000, "s1");
		add(d, "W2", "READY", 60_000, null);
		d.prepare(
			"INSERT INTO events (ts, kind, project, payload) VALUES (?, ?, ?, ?)",
		).run(T0 - 1_000, "NEED_DECISION", "p", '{"item":"W1"}');
		const { logs } = await run(
			d,
			[],
			(n) => (n === "--format" ? "json" : null),
			{
				ledger: null,
				live: [],
			},
		);
		const c = JSON.parse(logs.join("\n")) as ReturnType<
			typeof buildReportContract
		>;
		expect(c.schema_version).toBe(1);
		expect(c.scope).toBe("project");
		expect(c.needs_you).toEqual({ count: 1, ids: ["W1"] });
		const w1 = c.items.find((i) => i.id === "W1");
		expect(w1?.needs_you_reason).toBe("decision");
		expect(w1?.glyph).toBe("⊘");
		const w2 = c.items.find((i) => i.id === "W2");
		expect(Object.keys(w2?.usage ?? {}).sort()).toEqual([
			"gen_ai.usage.cache_creation.input_tokens",
			"gen_ai.usage.cache_read.input_tokens",
			"gen_ai.usage.input_tokens",
			"gen_ai.usage.output_tokens",
		]);
		expect(w2?.usage["gen_ai.usage.output_tokens"]).toBeNull();
		expect(w1?.links.task.endsWith("#task=W1&proj=p")).toBe(true);
	});
});

describe("W1131 §5/§9 — unknown ≠ zero + url encoding", () => {
	test("row level: unreported → null; a measured zero stays 0", () => {
		const d = fixtureDb();
		add(d, "S1", "CLAIMED", 60_000, "s1");
		const r = rowsOf(d)[0];
		const unreported: ReportRow = {
			...r,
			spendReported: false,
			fresh: 0,
			cached: 0,
			out: 0,
			requests: null,
			cacheRead: null,
			cacheCreation: null,
		};
		const reported: ReportRow = {
			...r,
			spendReported: true,
			fresh: 1_000,
			cached: 0,
			out: 50,
			requests: 3,
			cacheRead: 0,
			cacheCreation: 0,
		};
		const cu = buildReportContract([unreported], { project: "p", now: T0 });
		const cr = buildReportContract([reported], { project: "p", now: T0 });
		expect(cu.items[0]?.usage["gen_ai.usage.input_tokens"]).toBeNull();
		expect(cu.items[0]?.cache_share).toBeNull();
		expect(cr.items[0]?.usage["gen_ai.usage.input_tokens"]).toBe(1_000);
		expect(cr.items[0]?.cache_share).toBe(0);
		expect(cr.totals.cache_read_tokens).toBe(0);
	});

	test("§9 deep-links encode the project identity", () => {
		const d = fixtureDb();
		d.prepare(
			"INSERT INTO work_items (project, id, state, title, updated_at, owner_sid) VALUES (?, ?, ?, ?, ?, ?)",
		).run("/tmp/a b&c", "W1", "CLAIMED", "t-W1", T0 - 60_000, "s1");
		const row = reportRows(d, "/tmp/a b&c", { now: T0, ledger: null }).rows[0];
		const task = buildReportContract([row], { project: "x", now: T0 }).items[0]
			?.links.task;
		expect(task?.endsWith("#task=W1&proj=%2Ftmp%2Fa%20b%26c")).toBe(true);
	});
});

describe("W1131 §11 — scoping", () => {
	const lv = (
		sid: string,
		hub: string,
	): {
		sid: string;
		lastTs: number;
		lastOutTs: number;
		hub: string;
		model: null;
		requests: number;
	} => ({
		sid,
		lastTs: T0 - 60_000,
		lastOutTs: T0 - 60_000,
		hub,
		model: null,
		requests: 1,
	});
	test("--all sweeps projects; footer counts live lanes outside scope", async () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		add(d, "W9", "CLAIMED", 60_000, "s2", "q");
		const { logs } = await run(
			d,
			["--all"],
			(n) => (n === "--format" ? "json" : null),
			{
				ledger: null,
				live: [lv("s2", "mac"), lv("sX", "nas")],
			},
		);
		const c = JSON.parse(logs.join("\n")) as {
			scope: string;
			items: Array<{ id: string }>;
			footer: { lanes_other_projects: number | null };
		};
		expect(c.scope).toBe("all");
		expect(c.items.map((i) => i.id).sort()).toEqual(["W1", "W9"]);
		// sX is live but owns nothing in scope → the footer counts it
		expect(c.footer.lanes_other_projects).toBe(1);
	});

	test("--mine --as s1 keeps only owned rows", async () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		add(d, "W2", "CLAIMED", 60_000, "s2");
		const { logs } = await run(
			d,
			["--mine"],
			(n) => (n === "--as" ? "s1" : n === "--format" ? "json" : null),
			{ ledger: null, live: [] },
		);
		const c = JSON.parse(logs.join("\n")) as {
			scope: string;
			items: Array<{ id: string }>;
		};
		expect(c.scope).toBe("mine");
		expect(c.items.map((i) => i.id)).toEqual(["W1"]);
	});
});

describe("W1131 §10 — mode renderers", () => {
	test("statuslineScopeOf: git_worktree > cwd > garbage fallback", () => {
		expect(
			statuslineScopeOf(
				'{"session_id":"s9","cwd":"/a","workspace":{"git_worktree":"/wt"}}',
				"fb",
			),
		).toEqual({ project: "/wt", sessionId: "s9" });
		expect(statuslineScopeOf('{"cwd":"/a"}', "fb")).toEqual({
			project: "/a",
			sessionId: null,
		});
		expect(statuslineScopeOf("not json", "fb")).toEqual({
			project: "fb",
			sessionId: null,
		});
	});

	test("statusline: needs-you first, one line, stall grace", () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		d.prepare(
			"INSERT INTO events (ts, kind, project, payload) VALUES (?, ?, ?, ?)",
		).run(T0 - 1_000, "NEED_DECISION", "p", '{"item":"W1"}');
		const line = renderStatusline(contractOf(d));
		expect(line.startsWith("⚠ 1 ·")).toBe(true);
		expect(line).toContain("◐ 0");
		expect(line.split("\n").length).toBe(1);
	});

	test("tree: chat links, model@hub, footer sums other repos", () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		const rows = reportRows(d, "p", {
			now: T0,
			ledger: null,
			live: [
				{
					sid: "s1",
					lastTs: T0 - 30_000,
					lastOutTs: T0 - 30_000,
					hub: "mac",
					model: "glm-5",
					requests: 2,
				},
			],
		}).rows.map((r) => ({ ...r, model: "glm-5" }));
		const c = buildReportContract(rows, {
			project: "p",
			now: T0,
			boardBase: "http://b.local",
			lanesOtherProjects: 2,
		});
		const t = renderTree(c, { boardUrl: "http://b.local" });
		expect(t.startsWith("⏺ fleet ·")).toBe(true);
		expect(t).toContain("[W1](http://b.local/#task=W1&proj=p)");
		expect(t).toContain("glm-5@mac");
		expect(t).toContain("+2 in other repos");
		expect(t).toContain("[board](http://b.local)");
	});

	test("deltaTransitions: quiet baseline, hub move, gone", () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		const c = contractOf(d);
		expect(deltaTransitions(null, c)).toEqual([]);
		const prevHub = {
			schema_version: 1,
			items: [{ id: "W1", section: "working", hub: "nas" }],
		};
		expect(deltaTransitions(prevHub, c)).toEqual([
			{ id: "W1", from: "working", to: "working", hub: null },
		]);
		const prevGone = {
			schema_version: 1,
			items: [{ id: "W7", section: "waiting", hub: null }],
		};
		expect(deltaTransitions(prevGone, c)).toEqual([
			{ id: "W1", from: "new", to: "working", hub: null },
			{ id: "W7", from: "waiting", to: "gone", hub: null },
		]);
	});

	test("renderDeltaLine: 6-cap + more-count; empty → empty string", () => {
		const many: Parameters<typeof renderDeltaLine>[0] = Array.from(
			{ length: 7 },
			(_, x) => ({ id: `W${x}`, from: "waiting", to: "working", hub: null }),
		);
		const line = renderDeltaLine(many);
		expect(line.split(" · ").length).toBe(7);
		expect(line.endsWith("+1 more")).toBe(true);
		expect(renderDeltaLine([])).toBe("");
	});

	test("watchViewOf: wide table ≥100 cols, tree under", () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		const c = contractOf(d);
		expect(watchViewOf(c, 120)).toContain("EFFORT");
		expect(watchViewOf(c, 80).startsWith("⏺ fleet ·")).toBe(true);
	});
});

describe("W1131 §10 — verb delta state", () => {
	const dir = join(tmpdir(), `w1131-delta-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	process.env.SUSPENDERS_REPORT_STATE_DIR = dir;
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.SUSPENDERS_REPORT_STATE_DIR;
	});

	test("first emit quiet; a move prints one line; no change stays quiet", async () => {
		const d = fixtureDb();
		add(d, "W1", "READY", 60_000, null);
		const q1 = await run(d, ["--delta"], undefined, { ledger: null, live: [] });
		expect(q1.logs).toEqual([]);
		d.prepare(
			"UPDATE work_items SET state='CLAIMED', owner_sid='s1' WHERE id='W1'",
		).run();
		const t1 = await run(d, ["--delta"], undefined, { ledger: null, live: [] });
		expect(t1.logs.join(" ")).toContain("W1 waiting→working");
		const q2 = await run(d, ["--delta"], undefined, { ledger: null, live: [] });
		expect(q2.logs).toEqual([]);
		// the persisted state landed under the pinned state dir, keyed by scope
		expect(deltaStatePath("p").startsWith(dir)).toBe(true);
	});

	test("statusline auto-scopes to the piped workspace (§10, no flags)", async () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1"); // fallback scope p → 1 working
		add(d, "W2", "CLAIMED", 60_000, "s2", "/wt/x");
		add(d, "W3", "CLAIMED", 60_000, "s3", "/wt/x");
		const raw = JSON.stringify({
			session_id: "s9",
			workspace: { git_worktree: "/wt/x" },
		});
		const { logs } = await run(d, ["--statusline"], undefined, {
			stdinTty: false,
			stdinRaw: raw,
			ledger: null,
			live: [],
		});
		expect(logs.join("")).toContain("◐ 2");
		// control: no piped JSON (stdin TTY) keeps the CLI's own scope
		const ctrl = await run(d, ["--statusline"], undefined, {
			stdinTty: true,
			ledger: null,
			live: [],
		});
		expect(ctrl.logs.join("")).toContain("◐ 1");
	});
});

describe("W1131 §2/§6 — formats + colour matrix + narrow/wide", () => {
	const pins = { ledger: null, live: [] } as const;
	const escIn = (logs: string[]): boolean => logs.join("\n").includes("\x1b[");

	test("md: list + links, no escapes; plain: TSV, no wide columns", async () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		const md = (await run(d, ["--format", "md"], undefined, pins)).logs.join(
			"\n",
		);
		expect(md).toContain("**working (1)**");
		expect(md).toContain("[W1](http");
		expect(escIn([md])).toBe(false);
		const tsv = (
			await run(d, ["--format", "plain"], undefined, pins)
		).logs.join("\n");
		expect(tsv.split("\n")[0]?.split("\t")).toEqual([
			"ITEM",
			"ST",
			"TASK",
			"TOKENS",
			"CACHE",
			"OUT/MIN",
			"AGE",
			"LAST",
			"MODEL",
		]);
	});

	test("colour matrix: tty colour; NO_COLOR/TERM=dumb kill; FORCE_COLOR forces on a pipe", async () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		const keep = [
			process.env.NO_COLOR,
			process.env.TERM,
			process.env.FORCE_COLOR,
		];
		const drop = (): void => {
			delete process.env.NO_COLOR;
			delete process.env.TERM;
			delete process.env.FORCE_COLOR;
		};
		const restore = (k: string, v: string | undefined): void => {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		try {
			drop();
			const on = await run(d, ["--format", "tty"], undefined, {
				...pins,
				isTty: true,
			});
			expect(escIn(on.logs)).toBe(true);
			process.env.NO_COLOR = "1";
			const nc = await run(d, ["--format", "tty"], undefined, {
				...pins,
				isTty: true,
			});
			expect(escIn(nc.logs)).toBe(false);
			delete process.env.NO_COLOR;
			process.env.TERM = "dumb";
			const dumb = await run(d, ["--format", "tty"], undefined, {
				...pins,
				isTty: true,
			});
			expect(escIn(dumb.logs)).toBe(false);
			delete process.env.TERM;
			process.env.FORCE_COLOR = "1";
			const forced = await run(d, ["--format", "tty"], undefined, {
				...pins,
				isTty: false,
			});
			expect(escIn(forced.logs)).toBe(true);
			// --no-color loses to FORCE_COLOR (env forces)
			const ncFlag = await run(
				d,
				["--format", "tty", "--no-color"],
				undefined,
				{
					...pins,
					isTty: true,
				},
			);
			expect(escIn(ncFlag.logs)).toBe(true);
		} finally {
			restore("NO_COLOR", keep[0]);
			restore("TERM", keep[1]);
			restore("FORCE_COLOR", keep[2]);
		}
	});

	test("§6 narrow hides empty columns (footer names them); --wide shows all", async () => {
		const d = fixtureDb();
		add(d, "W1", "CLAIMED", 60_000, "s1");
		const narrow = (
			await run(d, ["--format", "tty"], undefined, { ...pins, isTty: true })
		).logs.join("\n");
		const body = narrow.split("\n").slice(0, -1).join("\n");
		expect(body).not.toContain("EFFORT");
		expect(body).not.toContain("REQ");
		expect(narrow).toContain("hidden:");
		const wide = (
			await run(d, ["--format", "tty", "--wide"], undefined, {
				...pins,
				isTty: true,
			})
		).logs.join("\n");
		expect(wide).toContain("EFFORT");
		expect(wide).toContain("REQ");
	});
});
