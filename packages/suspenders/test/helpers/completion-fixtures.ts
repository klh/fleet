// completion-fixtures.ts — the completion-record test fixtures (fixture(),
// crossFixture(), the cleanup drain and the durable summary string),
// extracted from test/work-completion-record.test.ts (W1238.6.6 decompose)
// so the suite can split without test double-registration. Importing this
// module registers the shared afterEach drain into the importing file.
import { afterEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const cleanup: string[] = [];
export const workFile = join(
	import.meta.dir,
	"..",
	"..",
	"hooks",
	"bin",
	"work.ts",
);
export function fixture(opts: { title?: string } = {}) {
	const repo = mkdtempSync(join(tmpdir(), "w554-completion-"));
	cleanup.push(repo);
	const home = join(repo, ".test-home");
	const env = { ...process.env, HOME: home, GOVERNOR_STORE_URL: "" };
	// W670: never leak the spawning lane's claim token into fixture children —
	// the context channel, not ambient env, must carry the take-minted token
	delete env.KLH_CLAIM_TOKEN;
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	expect(git("init").exitCode).toBe(0);
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	expect(git("commit", "--allow-empty", "-m", "baseline").exitCode).toBe(0);
	const baseline = git("rev-parse", "HEAD").stdout.toString().trim();
	const work = (...args: string[]) => {
		const p = Bun.spawnSync([process.execPath, workFile, ...args], {
			cwd: repo,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	};
	const added = work("add", opts.title ?? "durable completion evidence");
	const id = added.out.match(/W\d+/)?.[0] ?? "";
	const takeOut = work("take", id, "--as", "completion-lane");
	expect(takeOut.code).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(
		join(repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "completion-lane",
			item: id,
			baseline,
			launchedAt: Date.now(),
			// W643: the take-minted claim token rides the durable context channel
			claimToken: /claim token: ([0-9a-f]{48})/.exec(takeOut.out)?.[1],
		}),
	);
	writeFileSync(join(repo, "product.ts"), "export const repaired = true;\n");
	git("add", "product.ts");
	expect(git("commit", "-m", "implement repair").exitCode).toBe(0);
	const sha = git("rev-parse", "HEAD").stdout.toString().trim();
	return { repo, home, env, id, sha, baseline, work };
}
// W601: a graph project + sibling scope repo — work commits live in the
// scope repo on suspenders/<id>, the lane context in the graph repo.
export function crossFixture(opts: { scope?: boolean; marker?: boolean } = {}) {
	const parent = mkdtempSync(join(tmpdir(), "w601-cross-"));
	cleanup.push(parent);
	const repo = join(parent, "fleet");
	const scopeRepoPath = join(parent, "gaps");
	mkdirSync(repo);
	mkdirSync(scopeRepoPath);
	const env = {
		...process.env,
		HOME: join(repo, ".test-home"),
		GOVERNOR_STORE_URL: "",
	};
	// W670: strip the spawning lane's claim token (see fixture() above)
	delete env.KLH_CLAIM_TOKEN;
	const gitIn = (dir: string, ...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", dir, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
		return p.stdout.toString().trim();
	};
	for (const dir of [repo, scopeRepoPath]) {
		gitIn(dir, "init");
		gitIn(dir, "config", "user.name", "Test");
		gitIn(dir, "config", "user.email", "test@example.invalid");
		gitIn(dir, "commit", "--allow-empty", "-m", "base");
	}
	const work = (...args: string[]) => {
		const p = Bun.spawnSync([process.execPath, workFile, ...args], {
			cwd: repo,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			err: p.stderr.toString(),
		};
	};
	const id =
		work(
			"add",
			"cross-repo completion evidence",
			...(opts.scope === false ? [] : ["--scope", "gaps"]),
		).out.match(/W\d+/)?.[0] ?? "";
	expect(id).toMatch(/^W\d+$/);
	const takeOut = work("take", id, "--as", "cross-lane");
	expect(takeOut.code).toBe(0);
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(
		join(repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "cross-lane",
			item: id,
			baseline: gitIn(repo, "rev-parse", "HEAD"),
			launchedAt: Date.now(),
			// W643: the take-minted claim token rides the durable context channel
			claimToken: /claim token: ([0-9a-f]{48})/.exec(takeOut.out)?.[1],
		}),
	);
	gitIn(scopeRepoPath, "checkout", "-b", `suspenders/${id}`);
	writeFileSync(
		join(scopeRepoPath, "driver.ts"),
		opts.marker
			? ["describe", ".only(", '"x", () => {});\n'].join("")
			: "export const settleWait = true;\n",
	);
	gitIn(scopeRepoPath, "add", "-A");
	gitIn(scopeRepoPath, "commit", "-m", `${id}: qa driver settle wait`);
	return {
		repo,
		scopeRepoPath,
		env,
		id,
		scopeSha: gitIn(scopeRepoPath, "rev-parse", "HEAD"),
		work,
	};
}
afterEach(() => {
	for (const dir of cleanup.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
export const summary =
	"Implemented the product repair, verified the regression test and preserved the public interface.";
