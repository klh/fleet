// review-evals.fixture.ts — W1476 helpers for tests/review-evals.e2e.ts.
// Playwright spec-file shape law: the spec keeps only imports + test
// registrations, every declaration lives here. Repos are OS-tmpdir git
// fixtures (never under a checkout, so git never resolves upward into a
// worktree). Store work runs in bun children with HOME=<repo>/.test-home and
// the repo-local hooks as SUSPENDERS_PREFIX — the w1302 merge-ladder harness
// shape — and the child's governor.db is read back directly.
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { reviewContext } from "../../packages/suspenders/hooks/lib/gates/review-receipt.ts";
import { projectIdentity } from "../../packages/suspenders/hooks/lib/govdb/govdb.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const HOOKS = join(REPO_ROOT, "packages", "suspenders", "hooks");
const WORK = join(HOOKS, "bin", "work.ts");
const LOOP = join(HOOKS, "bin", "fleet-loop.ts");
const EVALS = join(HOOKS, "lib", "fleet-loop", "review-evals.ts");
const REVIEWER = "review-w1476-fixture";

export interface IncidentEvent {
	scope: string;
	source: string;
	project: string;
	class: string;
	commit: string;
	reverts: string | null;
	work: string | null;
	mergedSha: string;
	case: string;
	subject: string;
	incident: string | null;
}

export interface CaseItem {
	id: string;
	title: string;
	description: string;
	tags: string | null;
	state: string;
}

function git(repo: string, args: string[], cwd?: string): string {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: cwd ?? repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

const env = (repo: string) => ({
	...process.env,
	HOME: join(repo, ".test-home"),
	GOVERNOR_STORE_URL: "",
	FLEET_UNTRACKED_GRACE_MS: "0",
	// the ladder is under test, not the heartbeat: a fresh HOME makes every
	// maintenance task due and the sweep ran 10 minutes inside one cycle
	SUSPENDERS_MAINTENANCE: "0",
	SUSPENDERS_PREFIX: HOOKS,
});

function bun(repo: string, args: string[]): { code: number; out: string } {
	const p = Bun.spawnSync(["bun", ...args], {
		cwd: repo,
		env: env(repo),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout.toString()}${p.stderr.toString()}`,
	};
}

const store = (repo: string) =>
	new Database(
		join(repo, ".test-home", ".cache", "claude-governor", "governor.db"),
	);

/** Write + commit one file (in `cwd`, default the repo); the full sha. */
export function commitFile(
	repo: string,
	path: string,
	content: string,
	message: string,
	cwd?: string,
): string {
	const at = cwd ?? repo;
	mkdirSync(dirname(join(at, path)), { recursive: true });
	writeFileSync(join(at, path), content);
	git(repo, ["add", "--", path], at);
	git(repo, ["commit", "-m", message], at);
	return git(repo, ["rev-parse", "HEAD"], at);
}

/** `git revert --no-edit <sha>` (in `cwd`); the revert's full sha. */
export function revertCommit(repo: string, sha: string, cwd?: string): string {
	git(repo, ["revert", "--no-edit", sha], cwd);
	return git(repo, ["rev-parse", "HEAD"], cwd);
}

export const head = (repo: string): string => git(repo, ["rev-parse", "HEAD"]);

export const identity = (repo: string): string => projectIdentity(repo);

/** A fresh repo on main with one base commit. */
export function tempRepo(): string {
	const dir = join(
		tmpdir(),
		`w1476-evals-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-b", "main", "."]);
	git(dir, ["config", "user.email", "t@threads.dk"]);
	git(dir, ["config", "user.name", "t"]);
	commitFile(dir, "f.txt", "one\n", "base");
	return dir;
}

/** Bounded passes: one rmSync can leave .git behind after git writes. */
export function dropRepo(dir: string): void {
	for (let pass = 0; pass < 3 && existsSync(dir); pass++)
		rmSync(dir, { recursive: true, force: true });
}

/** Mint an item in the fixture store; `extra` = more `work add` flags. */
export function mint(
	repo: string,
	title: string,
	extra: string[] = [],
): string {
	const add = bun(repo, [WORK, "add", title, "--by", "lane", ...extra]);
	const id = /\bW\d+(?:\.\d+)*\b/.exec(add.out)?.[0];
	if (add.code !== 0 || !id) throw new Error(`work add failed: ${add.out}`);
	return id;
}

/** reviewEvalsAfterMerge in a store-isolated child; its log lines. */
export function bankLanding(
	repo: string,
	item: string | undefined,
	before: string,
	landed: string,
): string[] {
	const options = JSON.stringify({
		repo,
		item,
		before,
		landed,
		source: "w1476-test",
	});
	const call = `import { reviewEvalsAfterMerge } from ${JSON.stringify(EVALS)};\nconsole.log("LINES", JSON.stringify(reviewEvalsAfterMerge(${options})));`;
	const r = bun(repo, ["-e", call]);
	const lines = /LINES (\[.*\])/.exec(r.out)?.[1];
	if (r.code !== 0 || !lines) throw new Error(`bank failed: ${r.out}`);
	return JSON.parse(lines) as string[];
}

/** review.incident events in id order, payload spread over scope/source. */
export function incidentEvents(repo: string): IncidentEvent[] {
	const db = store(repo);
	try {
		const rows = db
			.query(
				"SELECT scope, source, payload FROM events WHERE kind = 'review.incident' ORDER BY id",
			)
			.all() as { scope: string; source: string; payload: string }[];
		return rows.map((row) => ({
			scope: row.scope,
			source: row.source,
			...(JSON.parse(row.payload) as Omit<IncidentEvent, "scope" | "source">),
		}));
	} finally {
		db.close();
	}
}

/** Arena-case items minted so far, oldest first. */
export function caseItems(repo: string): CaseItem[] {
	const db = store(repo);
	try {
		return db
			.query(
				"SELECT id, title, description, tags, state FROM work_items WHERE title LIKE 'Add review-arena case%' ORDER BY created_at, id",
			)
			.all() as CaseItem[];
	} finally {
		db.close();
	}
}

export function loopLog(repo: string): string {
	try {
		return readFileSync(join(repo, ".fleet", "loop.log"), "utf8");
	} catch {
		return "";
	}
}

// close via the plane itself so result_sha lands exactly as production writes it
function close(repo: string, item: string, sha: string): void {
	const take = bun(repo, [WORK, "take", item, "--as", "flushlane"]);
	if (take.code !== 0) throw new Error(`work take failed: ${take.out}`);
	const token = /claim token: ([0-9a-f]{48})/.exec(take.out)?.[1];
	const done = bun(repo, [
		WORK,
		"done",
		item,
		"--as",
		"flushlane",
		"--sha",
		sha,
		"--summary",
		"seed closure paragraph for the W1476 review-evals ladder test: the plane itself records the completion evidence, long enough for the summary validator.",
		...(token ? ["--token", token] : []),
	]);
	if (done.code !== 0) throw new Error(`work done failed: ${done.out}`);
}

// a valid PASS receipt for the exact commit: reviewer session row +
// work.review event, instructions bound to the branch's real review context
function seedReceipt(repo: string, item: string, sha: string): void {
	const project = projectIdentity(repo);
	const ctx = reviewContext(repo, `suspenders/${item}`);
	const db = store(repo);
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
			evidence: "seeded PASS receipt for the W1476 review-evals ladder test",
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
}

/** End to end through the real ladder: main gains x, a lane branch reverts
 *  it, the item closes at the revert with a PASS receipt, one fleet-loop
 *  cycle merges. */
export function landRevertThroughLadder(repo: string): {
	item: string;
	reverted: string;
	revert: string;
	code: number;
	out: string;
} {
	const reverted = commitFile(repo, "x.txt", "x\n", "W0 add x");
	const item = mint(repo, "lane reverting x");
	const wt = join(repo, ".worktrees", item);
	git(repo, ["worktree", "add", "-b", `suspenders/${item}`, wt]);
	const revert = revertCommit(repo, reverted, wt);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(join(repo, ".fleet", "lanes.json"), "[]");
	close(repo, item, revert);
	seedReceipt(repo, item, revert);
	const once = bun(repo, [
		LOOP,
		"once",
		"--repo",
		repo,
		"--glob",
		"suspenders/*",
	]);
	return { item, reverted, revert, ...once };
}
