// w1302-merge-dangling.test.ts — W1302.2 (A6): the post-merge dangling-path
// scan. Contract: a guarded merge that deletes/moves paths must surface every
// live reference the merge stranded — probe 1 (deleted paths still referenced
// by any merged file, imports and config strings alike) and probe 2 (path-like
// literals in the merge's own delta resolving onto nothing). Findings mint
// deduplicated repair items + code.dangling-path events; the merge itself
// never blocks on the scan (fail-open). Plus the A6 post-close repair-handoff
// regression: a branch advancing past an immutable close defers, and the
// repair item closing at the advanced head lands the branch while the
// original completion record stays untouched.
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(120_000);

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	pathLiterals,
	referencesIn,
} from "../hooks/lib/fleet-loop/dangling-classify.ts";
import {
	AGGREGATE_TITLE,
	bankDanglingRefs,
	danglingReferences,
	parseGrepRows,
	refForms,
	resolutionCandidates,
	resolveLiteral,
	unresolvedSpecifiers,
} from "../hooks/lib/fleet-loop/dangling-paths.ts";
import { reviewContext } from "../hooks/lib/gates/review-receipt.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";
import { cacheSlaStatusPath } from "../hooks/lib/usage/cache-sla.ts";

const P = join(import.meta.dir, "..");
const LOOP = join(P, "hooks", "bin", "fleet-loop.ts");
const WORK = join(P, "hooks", "bin", "work.ts");
// bankDanglingRef mints repair items via the work CLI child; point the
// prefix at the repo-local hooks dir so the child resolves bin/work.ts
const HOOKS = join(P, "hooks");
const REVIEWER = "review-w1302-fixture";

const g = (repo: string, args: string[], cwd?: string) =>
	Bun.spawnSync(["git", ...args], {
		cwd: cwd ?? repo,
		stdout: "pipe",
		stderr: "pipe",
	});

const testEnv = (repo: string) => ({
	...process.env,
	HOME: join(repo, ".test-home"),
	GOVERNOR_STORE_URL: "",
	FLEET_UNTRACKED_GRACE_MS: "0",
	SUSPENDERS_PREFIX: HOOKS,
	// fixture loops run the merge ladder only: a lane env's admin key would
	// let maintenance's coord-worker mint on the live gate and wait on a
	// real session past the test timeout
	BUCKLE_ADMIN_KEY: "",
	SUSPENDERS_MAINTENANCE: "0",
});

const run = (repo: string, args: string[]) => {
	const p = Bun.spawnSync(["bun", ...args], {
		cwd: repo,
		env: testEnv(repo),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout.toString()}${p.stderr.toString()}`,
	};
};

const base = async (): Promise<string> => {
	const dir = join(
		tmpdir(),
		`w1302-dangling-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	expect(g(dir, ["init", "-b", "main", "."]).exitCode).toBe(0);
	g(dir, ["config", "user.email", "t@threads.dk"]);
	g(dir, ["config", "user.name", "t"]);
	await Bun.write(Bun.file(join(dir, "f.txt")), "one\n");
	g(dir, ["add", "-A"]);
	expect(g(dir, ["commit", "-m", "base"]).exitCode).toBe(0);
	return dir;
};

// lane-shaped branch for a minted item: worktree + one commit, full head out
const laneBranch = async (repo: string, item: string): Promise<string> => {
	const wt = join(repo, ".worktrees", item);
	expect(
		g(repo, ["worktree", "add", "-b", `suspenders/${item}`, wt]).exitCode,
	).toBe(0);
	await Bun.write(Bun.file(join(wt, "f.txt")), "one\ntwo\n");
	g(repo, ["add", "-A"], wt);
	expect(g(repo, ["commit", "-m", `lane change ${item}`], wt).exitCode).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
	return g(repo, ["rev-parse", "HEAD"], wt).stdout.toString().trim();
};

const mint = (repo: string, title: string): string => {
	const add = run(repo, [WORK, "add", title, "--by", "lane"]);
	if (add.code !== 0) throw new Error(`work add failed: ${add.out}`);
	const m = /\bW\d+\b/.exec(add.out);
	if (!m) throw new Error(`no item id in: ${add.out}`);
	return m[0];
};

const take = (repo: string, item: string) =>
	run(repo, [WORK, "take", item, "--as", "flushlane"]);

// close via the plane itself so result_sha lands exactly as production writes it
const close = (repo: string, item: string, sha: string) => {
	const t = take(repo, item);
	expect(t.code).toBe(0);
	const tok = /claim token: ([0-9a-f]{48})/.exec(t.out)?.[1];
	const done = run(repo, [
		WORK,
		"done",
		item,
		"--as",
		"flushlane",
		"--sha",
		sha,
		"--summary",
		"seed closure paragraph for the W1302.2 dangling-path scan test: the plane itself records the completion evidence, long enough for the summary validator.",
		...(tok ? ["--token", tok] : []),
	]);
	if (done.code !== 0) throw new Error(`work done failed: ${done.out}`);
};

const once = (repo: string) =>
	run(repo, [LOOP, "once", "--repo", repo, "--glob", "suspenders/*"]);

const storeDb = (repo: string) =>
	new Database(
		join(repo, ".test-home", ".cache", "claude-governor", "governor.db"),
	);

const loopLog = (repo: string): string => {
	try {
		return readFileSync(join(repo, ".fleet", "loop.log"), "utf8");
	} catch {
		return "";
	}
};

const eventsCount = (repo: string, kind: string): number => {
	const db = storeDb(repo);
	try {
		return (
			db.query("SELECT COUNT(*) AS c FROM events WHERE kind = ?").get(kind) as {
				c: number;
			}
		).c;
	} finally {
		db.close();
	}
};

// seed a valid PASS receipt for an exact commit: reviewer session row +
// work.review event, instructions bound to the branch's real review context
const seedReceipt = (
	repo: string,
	item: string,
	sha: string,
	branch?: string,
) => {
	const project = projectIdentity(repo);
	const ctx = reviewContext(repo, branch ?? `suspenders/${item}`);
	const db = storeDb(repo);
	try {
		db.query(
			"INSERT OR IGNORE INTO sessions(sid,project,role,started_at,hb,state) VALUES(?,?,?,?,?,'RUNNING')",
		).run(REVIEWER, project, "reviewer", Date.now(), Date.now());
		const receipt = {
			version: 1,
			commit: sha,
			base: ctx.base,
			instructions: ctx.instructions,
			reviewer: REVIEWER,
			verdict: "PASS",
			blocking: [] as string[],
			evidence: "seeded PASS receipt for the W1302.2 scan wiring test",
		};
		db.query(
			"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
		).run(
			Date.now(),
			REVIEWER,
			"work.review",
			item,
			JSON.stringify({
				project,
				work: item,
				verdict: "PASS",
				receipt: JSON.stringify(receipt),
			}),
		);
	} finally {
		db.close();
	}
};

// bind an existing branch to a repair item (registry override, W1279 shape)
const bindBranch = (repo: string, item: string) =>
	writeFileSync(
		join(repo, ".fleet", "lanes.json"),
		JSON.stringify([
			{
				sid: "repairlane",
				item,
				branch: "suspenders/A",
				pid: 999_997,
				worktree: join(repo, ".worktrees", item),
				host: "some-other-host",
				launchedAt: Date.now() - 11 * 60_000,
			},
		]),
	);

describe("W1302.2 post-merge dangling-path scan", () => {
	test("pathLiterals: path-like strings in order (URLs filtered later)", () => {
		const body = [
			`import x from "./lib/a.ts";`,
			`const w = "https://cdn.example/x.css";`,
			`const c = "config.json";`,
			`const n = 42;`,
		].join("\n");
		expect(pathLiterals(body)).toEqual([
			"./lib/a.ts",
			"https://cdn.example/x.css",
			"config.json",
		]);
	});

	test("pathLiterals: template holes and non-strings never extracted", () => {
		expect(pathLiterals(`const u = \`dir/\${name}.ts\`;`)).toEqual([]);
		expect(pathLiterals("const q = 7;")).toEqual([]);
	});

	test("resolveLiteral: relative, @klh, and non-judged forms", () => {
		expect(resolveLiteral("../bin/r.ts", "hooks/lib/gates/s.ts")).toBe(
			"hooks/lib/bin/r.ts",
		);
		expect(resolveLiteral("@klh/belt/src/x.ts", "a/b.ts")).toBe(
			"packages/belt/src/x.ts",
		);
		expect(resolveLiteral("/abs/x.ts", "a.ts")).toBeNull();
		expect(resolveLiteral("https://x/y.ts", "a.ts")).toBeNull();
	});

	test("resolutionCandidates: extensionless + .js→.ts", () => {
		expect(resolutionCandidates("lib/gone")).toContain("lib/gone.ts");
		expect(resolutionCandidates("lib/gone")).toContain("lib/gone/index.ts");
		expect(resolutionCandidates("lib/x.js")).toContain("lib/x.ts");
	});

	test("refForms: full, stem, tail2, basename forms", () => {
		const forms = refForms("hooks/lib/gates/old.ts");
		expect(forms).toContain("hooks/lib/gates/old.ts");
		expect(forms).toContain("hooks/lib/gates/old");
		expect(forms).toContain("gates/old.ts");
		expect(forms).toContain("old.ts");
	});

	test("parseGrepRows: tree:file\\0line\\0content rows", () => {
		const rows = parseGrepRows(
			"main:a.ts\x003\x00import ./b.ts\nmain:a.ts\x003\x00dup\n",
		);
		expect(rows).toEqual([{ file: "a.ts", line: 3, content: "import ./b.ts" }]);
	});

	// W1778: the minted dangling path packages/suspenders/hooks/lib/usage/
	// cache-sla.json never existed — cache-sla.ts joins the literal onto
	// homedir()/.cache/claude-governor as the runtime sweep status file, not
	// a repo path. Bare-form literal, so the W1302.2.1 reference scope never
	// judges it; pin all three facts so the false positive stays dead.
	test("W1778: cache-sla.ts status literal is a runtime homedir path, not a reference", () => {
		const body = readFileSync(join(P, "hooks/lib/usage/cache-sla.ts"), "utf8");
		expect(pathLiterals(body)).toContain("cache-sla.json");
		const saved = process.env.KLH_CACHE_SLA_STATUS;
		delete process.env.KLH_CACHE_SLA_STATUS;
		try {
			expect(cacheSlaStatusPath()).toBe(
				join(homedir(), ".cache", "claude-governor", "cache-sla.json"),
			);
		} finally {
			if (saved !== undefined) process.env.KLH_CACHE_SLA_STATUS = saved;
		}
		expect(
			unresolvedSpecifiers(P, "HEAD", ["hooks/lib/usage/cache-sla.ts"]),
		).toEqual([]);
	});

	test("probe2 catches the W1304 incident shape (../bin runner missing)", async () => {
		const repo = await base();
		await Bun.write(
			Bun.file(join(repo, "gates", "sched.ts")),
			'const p = new URL("../bin/runner.ts", import.meta.url).pathname;\nexport const P = p;\n',
		);
		g(repo, ["add", "-A"]);
		g(repo, ["commit", "-m", "sched"]);
		const head = g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
		// file moved to gates/ depth but the runner literal kept the old depth
		const hit = unresolvedSpecifiers(repo, head, ["gates/sched.ts"]);
		expect(hit).toHaveLength(1);
		expect(hit[0].target).toBe("bin/runner.ts");
		expect(hit[0].refBy).toBe("gates/sched.ts");
		expect(hit[0].specifier).toBe("../bin/runner.ts");
		// the W1304 repair shape: the runner lands at bin/ — scan goes quiet
		await Bun.write(
			Bun.file(join(repo, "bin", "runner.ts")),
			"export const r = 1;\n",
		);
		g(repo, ["add", "-A"]);
		g(repo, ["commit", "-m", "runner"]);
		const fixed = g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
		expect(unresolvedSpecifiers(repo, fixed, ["gates/sched.ts"])).toEqual([]);
	});

	test("W1302.2.1: fixture strings in test files never judged (probe2 scoped)", async () => {
		const repo = await base();
		// the real families' shapes: bare fixture names, a colon-prefixed git
		// rev form, a staged-file list (review-lane-proof / merge-guard /
		// sync-harness.test shape)
		await Bun.write(
			Bun.file(join(repo, "test", "guard.test.ts")),
			[
				'const repo = "/tmp/fx";',
				'writeFileSync(join(repo, "real.ts"), "export const stub = 0;\\n");',
				'git(repo, "show", ":base.ts");',
				'stage(["harness-receipt.json", "bin/coord.ts", "packages/belt/package.json"]);',
			].join("\n"),
		);
		// outside a test file the scanner keeps its power on dot-prefixed refs
		await Bun.write(
			Bun.file(join(repo, "lib", "caller.ts")),
			'import { d } from "./missing.ts";\nexport const c = d;\n',
		);
		g(repo, ["add", "-A"]);
		g(repo, ["commit", "-m", "delta"]);
		const head = g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
		const hits = unresolvedSpecifiers(repo, head, [
			"test/guard.test.ts",
			"lib/caller.ts",
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0].refBy).toBe("lib/caller.ts");
		expect(hits[0].target).toBe("lib/missing.ts");
	});

	test("W1302.2.1: bare data-path strings and runtime-dir targets never judged", async () => {
		const repo = await base();
		// sync-harness.ts shape: staged-file list + @klh doc ellipsis + a
		// runtime-home .harness climb — all data, none a repo reference
		await Bun.write(
			Bun.file(join(repo, "scripts", "stage.ts")),
			[
				"const staged = [",
				'\t"package.json",',
				'\t"hooks/gate.ts",',
				'\t"harness-receipt.json",',
				'\t"@klh/blam/...",',
				"];",
				'const harnessRoot = "../../.harness/packages/buckle";',
				"export const x = [staged, harnessRoot];",
			].join("\n"),
		);
		// the W1304 shape stays caught — proves the form rule, not file luck
		await Bun.write(
			Bun.file(join(repo, "lib", "runner.ts")),
			'const p = new URL("../bin/runner.ts", import.meta.url).pathname;\nexport const P = p;\n',
		);
		g(repo, ["add", "-A"]);
		g(repo, ["commit", "-m", "delta"]);
		const head = g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
		const hits = unresolvedSpecifiers(repo, head, [
			"scripts/stage.ts",
			"lib/runner.ts",
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0].refBy).toBe("lib/runner.ts");
		expect(hits[0].target).toBe("bin/runner.ts");
	});

	test("probe1: deleted-path reference found; same-basename survivor stays quiet", async () => {
		const repo = await base();
		// lib/gone.ts referenced by app.ts; keep/old.ts referenced by other/r.ts
		await Bun.write(
			Bun.file(join(repo, "lib", "gone.ts")),
			"export const g = 1;\n",
		);
		await Bun.write(
			Bun.file(join(repo, "app.ts")),
			'import { g } from "./lib/gone.ts";\nconsole.log(g);\n',
		);
		await Bun.write(
			Bun.file(join(repo, "keep", "old.ts")),
			"export const o = 1;\n",
		);
		await Bun.write(
			Bun.file(join(repo, "other", "r.ts")),
			'import { o } from "./keep/old.ts";\nconsole.log(o);\n',
		);
		g(repo, ["add", "-A"]);
		g(repo, ["commit", "-m", "world"]);
		// the merge deletes lib/gone.ts and keep/old.ts but re-adds other/old.ts
		g(repo, ["rm", "lib/gone.ts", "keep/old.ts"]);
		await Bun.write(
			Bun.file(join(repo, "other", "old.ts")),
			"export const o = 2;\n",
		);
		g(repo, ["add", "-A"]);
		g(repo, ["commit", "-m", "reorg"]);
		const before = g(repo, ["rev-parse", "HEAD~1"]).stdout.toString().trim();
		const after = g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
		const hits = danglingReferences(repo, before, after);
		expect(hits).toHaveLength(1);
		expect(hits[0].target).toBe("lib/gone.ts");
		expect(hits[0].refBy).toBe("app.ts");
		// the './old.ts' import still resolves — other/old.ts exists post-merge
	});

	test("bankDanglingRefs mints one deduped repair item + event", async () => {
		const repo = await base();
		const head = g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
		const call = `import { bankDanglingRefs } from ${JSON.stringify(join(HOOKS, "lib", "fleet-loop", "dangling-paths.ts"))};\nbankDanglingRefs(${JSON.stringify(repo)}, "w1302-test", [{ target: "lib/gone.ts", refBy: "app.ts", line: 2, specifier: "./lib/gone.ts" }], ${JSON.stringify(head)});`;
		// first bank mints the aggregate; the identical second bank dedupes by edge
		const first = run(repo, ["-e", call]);
		expect(first.out).toBe("");
		expect(first.code).toBe(0);
		const repeated = run(repo, ["-e", call]);
		expect(repeated.out).toBe("");
		expect(repeated.code).toBe(0);
		const db = storeDb(repo);
		try {
			const item = db
				.query(
					"SELECT id, title FROM work_items WHERE title LIKE 'Repair dangling path%'",
				)
				.all() as { id: string; title: string }[];
			expect(item).toHaveLength(1);
			expect(item[0].title).toBe(
				"Repair dangling paths found by the post-merge scan",
			);
		} finally {
			db.close();
		}
		expect(eventsCount(repo, "code.dangling-path")).toBe(1);
	});

	test("mergeOne wires the scan: a dangling deletion banks repair at merge time", async () => {
		const repo = await base();
		await Bun.write(
			Bun.file(join(repo, "lib", "gone.ts")),
			"export const g = 1;\n",
		);
		await Bun.write(
			Bun.file(join(repo, "app.ts")),
			'import { g } from "./lib/gone.ts";\nconsole.log(g);\n',
		);
		g(repo, ["add", "-A"]);
		g(repo, ["commit", "-m", "world"]);
		const a = mint(repo, "wiring test item");
		await laneBranch(repo, a);
		// the lane commit deletes lib/gone.ts; app.ts keeps importing it
		expect(
			g(repo, ["rm", "lib/gone.ts"], join(repo, ".worktrees", a)).exitCode,
		).toBe(0);
		g(repo, ["commit", "-m", "drop gone"], join(repo, ".worktrees", a));
		const tip = g(repo, ["rev-parse", "HEAD"], join(repo, ".worktrees", a))
			.stdout.toString()
			.trim();
		close(repo, a, tip);
		seedReceipt(repo, a, tip);
		const r = once(repo);
		if (r.code !== 0) throw new Error(`once failed: ${r.out}`);
		// the branch lands (and is retired); the ladder may advance the head
		// further with its qlty fix-up, so assert ancestry, not equality
		expect(g(repo, ["merge-base", "--is-ancestor", tip, "main"]).exitCode).toBe(
			0,
		);
		expect(loopLog(repo)).toContain("MERGED");
		expect(loopLog(repo)).toContain("DANGLING-PATH");
		const db = storeDb(repo);
		try {
			const repairs = db
				.query(
					"SELECT COUNT(*) AS c FROM work_items WHERE title LIKE 'Repair dangling path%'",
				)
				.get() as { c: number };
			expect(repairs.c).toBeGreaterThanOrEqual(1);
		} finally {
			db.close();
		}
		expect(eventsCount(repo, "code.dangling-path")).toBeGreaterThanOrEqual(1);
	});

	test("post-close repair handoff: deferred head, repair close lands, record intact", async () => {
		const repo = await base();
		const a = mint(repo, "post-close regression item");
		const wt = join(repo, ".worktrees", a);
		const x = await laneBranch(repo, a);
		close(repo, a, x);
		seedReceipt(repo, a, x);
		// branch advances past the immutable close
		await Bun.write(Bun.file(join(wt, "f.txt")), "one\ntwo\nthree\n");
		g(repo, ["commit", "-am", "advance"], wt);
		const y = g(repo, ["rev-parse", "HEAD"], wt).stdout.toString().trim();
		const r1 = once(repo);
		expect(r1.code).toBe(0);
		expect(g(repo, ["rev-parse", "main"]).stdout.toString().trim()).not.toBe(y);
		// the repair item B closes at Y; its branch is pinned at Y and the
		// registry binds branch suspenders/A to B (itemClaimOf override)
		const b = mint(repo, "post-close repair item");
		bindBranch(repo, b);
		expect(g(repo, ["branch", `suspenders/${b}`, y]).exitCode).toBe(0);
		close(repo, b, y);
		seedReceipt(repo, b, y, `suspenders/${b}`);
		const r2 = once(repo);
		expect(r2.code).toBe(0);
		// branch suspenders/A (bound to repair item B) lands — Y is an
		// ancestor of main afterwards; the ladder may advance the head
		// further with its qlty fix-up, so assert ancestry, not equality
		expect(g(repo, ["merge-base", "--is-ancestor", y, "main"]).exitCode).toBe(
			0,
		);
		const db = storeDb(repo);
		try {
			const rec = (item: string) =>
				db
					.query(
						"SELECT commit_sha FROM work_completion_records WHERE item = ?",
					)
					.get(item) as { commit_sha: string };
			expect(rec(a).commit_sha).toBe(x); // immutable record untouched
			expect(rec(b).commit_sha).toBe(y);
		} finally {
			db.close();
		}
	});
});

// W1302.8 (A22): references by syntax, findings into ONE aggregate item
const memStore = () => {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,title TEXT,state TEXT); CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	return db;
};

// seeds legacy history and mints aggregates through an injected enqueue
const aggregateKit = (db: Database, project: string) => {
	const minted: string[] = [];
	const enqueue = (title: string, desc: string) => {
		minted.push(desc);
		const id = `W9${minted.length}`;
		db.query("INSERT INTO work_items VALUES(?,?,?,'READY')").run(
			project,
			id,
			title,
		);
		return id;
	};
	const item = (id: string, title: string, state: string) =>
		db
			.query("INSERT INTO work_items VALUES(?,?,?,?)")
			.run(project, id, title, state);
	const event = (scope: string, target: string, refBy: string) =>
		db
			.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(1,'seed','code.dangling-path',?,?,NULL)",
			)
			.run(scope, JSON.stringify({ project, target, refBy }));
	return { minted, enqueue, item, event };
};

const edge = (target: string, refBy: string) => ({
	target,
	refBy,
	line: 0,
	specifier: `./${target}`,
});

const commitAll = (repo: string): string => {
	g(repo, ["add", "-A"]);
	g(repo, ["commit", "-m", "delta"]);
	return g(repo, ["rev-parse", "HEAD"]).stdout.toString().trim();
};

describe("W1302.8 classified scan + one aggregate", () => {
	test("W2161: vanished-payload error text is not a filesystem reference", () => {
		const body =
			'throw new Error("Payload faces vanished from the source tree: packages/belt/bin/dashboard.ts");\n';
		expect(
			referencesIn("packages/suspenders/test/sync-harness.test.ts", body),
		).toEqual([]);
		expect(referencesIn("scripts/sync-harness.ts", body)).toEqual([]);
	});

	test("W1705/W1614/W1628 shapes carry no reference; a real import survives", () => {
		const jsdoc =
			" * `./hub-remote.ts`), resolution proved.\n */\nexport const h = 1;\n";
		expect(referencesIn("scripts/overlay.ts", `/**\n${jsdoc}`)).toEqual([]);
		const nested = `export const ok = (s: string) => s.includes('from "./supervisor.ts"');\n`;
		expect(referencesIn("scripts/steps.ts", nested)).toEqual([]);
		const apostrophe = `// entry's handler list); returns null.\nimport { a } from "./gone.ts";\nexport const b = a;\n`;
		expect(referencesIn("board/routes.ts", apostrophe)).toEqual([
			{ spec: "./gone.ts", kind: "import" },
		]);
	});

	test("probe2 judges a test file's imports, never its data strings", async () => {
		const repo = await base();
		await Bun.write(
			Bun.file(join(repo, "test", "a.test.ts")),
			[
				'import { x } from "../lib/gone.ts";',
				'const fixture = "./also-missing.ts";',
				'writeFileSync(join(dir, "./fx.ts"), "");',
				"export const t = [x, fixture];",
			].join("\n"),
		);
		const hits = unresolvedSpecifiers(repo, commitAll(repo), [
			"test/a.test.ts",
		]);
		expect(hits.map((h) => [h.target, h.refBy, h.specifier])).toEqual([
			["lib/gone.ts", "test/a.test.ts", "../lib/gone.ts"],
		]);
	});

	test("probe2 judges url, dir-join and config forms; build output never", async () => {
		const repo = await base();
		await Bun.write(
			Bun.file(join(repo, "lib", "deep", "a.ts")),
			[
				'import { join } from "node:path";',
				'const p = join(import.meta.dir, "..", "bin", "run.ts");',
				'const u = new URL("../cli.ts", import.meta.url);',
				"export const x = [p, u];",
			].join("\n"),
		);
		// vscode-extension shape: main points at untracked compiler output
		const manifest = {
			main: "./out/extension.js",
			bin: { p: "./bin/p.ts" },
			description: "./gone.ts",
		};
		await Bun.write(
			Bun.file(join(repo, "pkg", "package.json")),
			JSON.stringify(manifest),
		);
		const hits = unresolvedSpecifiers(repo, commitAll(repo), [
			"lib/deep/a.ts",
			"pkg/package.json",
		]);
		expect(hits.map((h) => h.target).sort()).toEqual([
			"lib/bin/run.ts",
			"lib/cli.ts",
			"pkg/bin/p.ts",
		]);
	});

	test("probe1 counts a test's import of a deleted path, never fixture data or docs", async () => {
		const repo = await base();
		await Bun.write(
			Bun.file(join(repo, "lib", "gone.ts")),
			"export const g = 1;\n",
		);
		await Bun.write(
			Bun.file(join(repo, "test", "gone.test.ts")),
			'import { g } from "../lib/gone.ts";\nexport const t = g;\n',
		);
		await Bun.write(
			Bun.file(join(repo, "test", "fx.test.ts")),
			'const name = "lib/gone.ts";\nwriteFileSync(join(tmp, "./lib/gone.ts"), name);\n',
		);
		await Bun.write(
			Bun.file(join(repo, "lib", "doc.ts")),
			"/** Was `./gone.ts` before the reorg. */\nexport const d = 1;\n",
		);
		const before = commitAll(repo);
		g(repo, ["rm", "lib/gone.ts"]);
		const after = commitAll(repo);
		const hits = danglingReferences(repo, before, after);
		expect(hits.map((h) => [h.target, h.refBy, h.line, h.specifier])).toEqual([
			["lib/gone.ts", "test/gone.test.ts", 1, "../lib/gone.ts"],
		]);
	});

	test("aggregate: many edges bank into ONE item; later batches append, never re-mint", async () => {
		const repo = await base();
		const db = memStore();
		const kit = aggregateKit(db, projectIdentity(repo));
		const opts = { db, enqueue: kit.enqueue };
		const first = Array.from({ length: 30 }, (_, i) =>
			edge(`lib/g${i}.ts`, `app${i}.ts`),
		);
		expect(bankDanglingRefs(repo, "t", first, "sha1", opts)).toHaveLength(30);
		expect(kit.minted).toHaveLength(1);
		expect(kit.minted[0]).toContain("... 10 more");
		const fresh = [edge("lib/n1.ts", "b.ts"), edge("lib/n2.ts", "b.ts")];
		const again = [...first.slice(0, 5), ...fresh, fresh[1]];
		expect(bankDanglingRefs(repo, "t", again, "sha2", opts)).toEqual(fresh);
		expect(kit.minted).toHaveLength(1);
		const scopes = db
			.query("SELECT scope, COUNT(*) AS c FROM events GROUP BY scope")
			.all();
		expect(scopes).toEqual([{ scope: "W91", c: 32 }]);
		const titles = db.query("SELECT title FROM work_items").all();
		expect(titles).toEqual([{ title: AGGREGATE_TITLE }]);
	});

	test("aggregate dedupe: SUPERSEDED/CANCELLED/orphan history never re-mints; DONE re-banks", async () => {
		const repo = await base();
		const db = memStore();
		const kit = aggregateKit(db, projectIdentity(repo));
		// legacy per-edge title only (the W1781 cache-sla junk shape)
		kit.item(
			"W1781",
			"Repair dangling path lib/a.ts referenced by test/cache-sla.test.ts",
			"SUPERSEDED",
		);
		kit.item(
			"W1705",
			"Repair dangling path lib/b.ts referenced by x.ts",
			"SUPERSEDED",
		);
		kit.event("W1705", "lib/b.ts", "x.ts");
		kit.item("W50", AGGREGATE_TITLE, "CANCELLED");
		kit.event("W50", "lib/c.ts", "y.ts");
		kit.event("W404", "lib/e.ts", "q.ts"); // holder row gone
		kit.item("W60", "Repair dangling path lib/d.ts referenced by z.ts", "DONE");
		kit.event("W60", "lib/d.ts", "z.ts");
		const refs = [
			edge("lib/a.ts", "test/cache-sla.test.ts"),
			edge("lib/b.ts", "x.ts"),
			edge("lib/c.ts", "y.ts"),
			edge("lib/e.ts", "q.ts"),
			edge("lib/d.ts", "z.ts"),
		];
		const banked = bankDanglingRefs(repo, "t", refs, "sha", {
			db,
			enqueue: kit.enqueue,
		});
		// only the repaired-then-re-broken edge banks, into a fresh aggregate
		expect(banked.map((r) => r.target)).toEqual(["lib/d.ts"]);
		expect(kit.minted).toHaveLength(1);
		// findings are never deleted: four seeded events stay, one appended
		const count = db.query("SELECT COUNT(*) AS c FROM events").get();
		expect(count).toEqual({ c: 5 });
	});
});
