import { expect, test } from "@playwright/test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";

const HOOKS = join(import.meta.dir, "../../../.githooks");
const worlds: ReturnType<typeof scratchWorld>[] = [];

const git = (repo: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString(),
	};
};
const gitWithEnv = (
	repo: string,
	env: Record<string, string>,
	...args: string[]
) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString(),
	};
};

test.afterAll(() => {
	for (const world of worlds.splice(0)) world.clean();
});

// scratch repo with the W2270 hooks active: pre-commit and pre-merge-commit
// are self-contained copies; the lib-importing reference-transaction runs
// from THIS checkout via an absolute hooksPath so its imports resolve.
const hookWorld = (): ReturnType<typeof scratchWorld> => {
	const world = scratchWorld({ prefix: "fleet-w2270-" });
	worlds.push(world);
	const hookDir = join(world.repo, ".githooks");
	mkdirSync(hookDir);
	for (const name of ["pre-commit", "pre-merge-commit"]) {
		writeFileSync(join(hookDir, name), readFileSync(join(HOOKS, name)));
		chmodSync(join(hookDir, name), 0o755);
	}
	git(world.repo, "branch", "-M", "main");
	git(world.repo, "config", "core.hooksPath", HOOKS);
	git(world.repo, "config", "user.name", "test");
	git(world.repo, "config", "user.email", "test@example.invalid");
	return world;
};

const candidateOn = (world: ReturnType<typeof scratchWorld>): string => {
	git(world.repo, "checkout", "-b", "suspenders/BYPASS");
	writeFileSync(join(world.repo, "change.txt"), "review not approved\n");
	git(world.repo, "add", "change.txt");
	expect(
		git(
			world.repo,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"candidate",
		).code,
	).toBe(0);
	const sha = git(world.repo, "rev-parse", "HEAD").out;
	git(world.repo, "checkout", "main");
	return sha;
};

test("W2270 forged attestation file and bare direct FF cannot move main", () => {
	const world = hookWorld();
	const { repo } = world;
	const candidate = candidateOn(world);
	const before = git(repo, "rev-parse", "HEAD").out;
	// forge the exact bearer file shape the old hook trusted
	const grantPath = join(
		repo,
		git(repo, "rev-parse", "--git-path", "fleet-main-ref-grant.json").out,
	);
	writeFileSync(
		grantPath,
		JSON.stringify({
			old: before,
			tree: git(repo, "show", "-s", "--format=%T", candidate).out,
			at: Date.now(),
		}),
	);
	const forged = git(repo, "merge", "--ff-only", candidate);
	expect(forged.code).not.toBe(0);
	expect(`${forged.out}${forged.err}`).toContain("Main ref update refused");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
});

test("W2270 forged FLEET_GUARDED_MAIN_OLD/NEW env pair cannot move main", () => {
	const world = hookWorld();
	const { repo } = world;
	const candidate = candidateOn(world);
	const before = git(repo, "rev-parse", "HEAD").out;
	// the W2255.2-era fallback env attestation: caller-supplied, forgeable
	const forged = gitWithEnv(
		repo,
		{
			FLEET_GUARDED_MAIN_OLD: before,
			FLEET_GUARDED_MAIN_NEW: candidate,
			HOME: world.home,
			GOVERNOR_STORE_URL: "local",
		},
		"merge",
		"--ff-only",
		candidate,
	);
	expect(forged.code).not.toBe(0);
	expect(`${forged.out}${forged.err}`).toContain("Main ref update refused");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
});

test("W2270 direct merge --no-ff publication to main refuses", () => {
	const world = hookWorld();
	const { repo } = world;
	const candidate = candidateOn(world);
	const before = git(repo, "rev-parse", "HEAD").out;
	const noff = git(repo, "merge", "--no-ff", candidate, "-m", "direct");
	expect(noff.code).not.toBe(0);
	expect(`${noff.out}${noff.err}`).toContain("Direct merge into main refused");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
});

test("W2270 merge --no-commit + commit path refuses at pre-commit", () => {
	const world = hookWorld();
	const { repo } = world;
	const candidate = candidateOn(world);
	const before = git(repo, "rev-parse", "HEAD").out;
	const staged = gitWithEnv(
		repo,
		{ HOME: world.home, GOVERNOR_STORE_URL: "local" },
		"merge",
		"--no-ff",
		"--no-commit",
		candidate,
	);
	expect(staged.code).toBe(0);
	const commit = gitWithEnv(
		repo,
		{ HOME: world.home, GOVERNOR_STORE_URL: "local" },
		"commit",
		"-m",
		"direct",
	);
	expect(commit.code).not.toBe(0);
	expect(`${commit.out}${commit.err}`).toContain(
		"Direct merge into main refused",
	);
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
});

test("W2270 work-branch FFs and direct main commits fail closed without a grant", () => {
	const world = hookWorld();
	const { repo } = world;
	git(world.repo, "checkout", "-b", "suspenders/WORK");
	writeFileSync(join(repo, "ok.txt"), "ordinary work\n");
	git(repo, "add", "ok.txt");
	const commit = git(repo, "commit", "-m", "ordinary");
	expect(commit.code).toBe(0);
	git(repo, "checkout", "main");
	const before = git(repo, "rev-parse", "HEAD").out;
	// a plain work-branch FF is a ref-only publication — refused with no
	// grant, no env attestation, nothing: fail closed is the default
	const ff = gitWithEnv(
		repo,
		{ HOME: world.home, GOVERNOR_STORE_URL: "local" },
		"merge",
		"--ff-only",
		"suspenders/WORK",
	);
	expect(ff.code).not.toBe(0);
	expect(`${ff.out}${ff.err}`).toContain("Main ref update refused");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
	// committing directly ON main is itself a fast-forward (old parent →
	// new commit), so it rides the same store-grant gate and refuses —
	// ordinary work publishes through the guarded ladder or not at all
	const direct = gitWithEnv(
		repo,
		{ HOME: world.home, GOVERNOR_STORE_URL: "local" },
		"commit",
		"--allow-empty",
		"-m",
		"on main",
	);
	expect(direct.code).not.toBe(0);
	expect(`${direct.out}${direct.err}`).toContain("Main ref update refused");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
});

test("W2270 one-use store grant lets an exact reviewed FF publish, once", () => {
	const world = hookWorld();
	const { repo } = world;
	const candidate = candidateOn(world);
	const before = git(repo, "rev-parse", "HEAD").out;
	const env = {
		HOME: world.home,
		GOVERNOR_STORE_URL: "local",
	};
	// review-receipt's git probe inside the grandchild hits a transient
	// sandbox ENOENT under load; a fresh child on the next attempt succeeds
	const mintChild = () =>
		Bun.spawnSync(
			[
				"bun",
				"-e",
				`
			import {openStore,projectIdentity} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/govdb/govdb.ts"))};
			import {reviewContext,publishReviewReceipt} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/gates/review-receipt.ts"))};
			import {ensurePublishGrantsTable,mintPublishGrant} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/fleet-loop/publish-grant.ts"))};
			const db=openStore(), project=projectIdentity();
			const c=reviewContext(process.argv[1],"suspenders/BYPASS");
			db.query("DELETE FROM sessions WHERE sid='fixture-reviewer' AND project=?").run(project);
			db.query("INSERT OR REPLACE INTO work_items(project,id,title,state,result_sha,created_at,updated_at) VALUES (?,'W-T','fixture','DONE',?,?,?)").run(project,c.commit,Date.now(),Date.now());
			db.run("CREATE TABLE IF NOT EXISTS work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)");
			db.query("INSERT INTO work_completion_records VALUES (?,'W-T',?,'fixture-author')").run(project,c.commit);
			db.query("INSERT INTO sessions(sid,project,role,started_at,hb,state) VALUES ('fixture-reviewer',?,'reviewer',?,?,'DONE')").run(project,Date.now(),Date.now());
			publishReviewReceipt(db,project,'W-T',{version:1,commit:c.commit,base:c.base,instructions:c.instructions,reviewer:'fixture-reviewer',verdict:'PASS',blocking:[],evidence:'fixture independent review'});
			ensurePublishGrantsTable(db);
			mintPublishGrant(db,{project,item:"W-T",branch:"suspenders/BYPASS",old:process.argv[2],new:c.commit});
			db.close();
		`,
				repo,
				before,
			],
			{
				cwd: repo,
				env: { ...process.env, ...env },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	let mint = mintChild();
	for (let i = 0; mint.exitCode !== 0 && i < 2; i++) mint = mintChild();
	if (mint.exitCode !== 0)
		throw new Error(
			`mint child failed: ${mint.stderr.toString().slice(-1500)}`,
		);
	expect(mint.exitCode).toBe(0);
	const first = gitWithEnv(repo, env, "merge", "--ff-only", candidate);
	if (first.code !== 0)
		throw new Error(`guarded FF refused: ${first.out}${first.err}`);
	expect(git(repo, "rev-parse", "HEAD").out).toBe(candidate);
	// pair-bound + one-use at the hook level: a NEW child commit of the
	// published candidate cannot ride the spent grant's pair
	git(repo, "checkout", "suspenders/BYPASS");
	writeFileSync(join(repo, "more.txt"), "second candidate\n");
	git(repo, "add", "more.txt");
	const second = git(repo, "commit", "-m", "second");
	expect(second.code).toBe(0);
	const candidate2 = git(repo, "rev-parse", "HEAD").out;
	git(repo, "checkout", "main");
	const ride = gitWithEnv(
		repo,
		env,
		"update-ref",
		"refs/heads/main",
		candidate2,
	);
	expect(ride.code).not.toBe(0);
	expect(`${ride.out}${ride.err}`).toContain("Main ref update refused");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(candidate);
});

test("W2270 grant lib enforces one-use, pair binding and TTL at the store", () => {
	const world = hookWorld();
	const { repo } = world;
	const env = { ...process.env, HOME: world.home, GOVERNOR_STORE_URL: "local" };
	const run = (code: string) =>
		Bun.spawnSync(["bun", "-e", code], {
			cwd: repo,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
	const probe = `
		import {openStore} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/govdb/govdb.ts"))};
		import {consumePublishGrant} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/fleet-loop/publish-grant.ts"))};
		const db=openStore();
		const g={project:"p",old:"a".repeat(40),new:"b".repeat(40)};
		const now=Date.now();
		const put=()=>{db.query("INSERT INTO publish_grants(project,item,branch,old_sha,new_sha,minted_at) VALUES ('p','I','br',?,?," + String(now) + ")").run(g.old,g.new);};
		put();
		console.log(JSON.stringify(consumePublishGrant(db,g,now,600000)));
		put();
		console.log(JSON.stringify(consumePublishGrant(db,{project:"p",old:g.old,new:"c".repeat(40)},now,600000)));
		console.log(JSON.stringify(consumePublishGrant(db,g,now+601000,600000)));
		db.close();
	`;
	const first = run(probe);
	if (first.exitCode !== 0)
		throw new Error(
			`grant probe failed: ${first.stderr.toString().slice(-1200)}`,
		);
	expect(first.exitCode).toBe(0);
	const lines = first.stdout
		.toString()
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { ok: boolean });
	// 1: fresh grant consumes · 2: wrong new-sha pair misses · 3: TTL expired
	expect(lines.map((l) => l.ok)).toEqual([true, false, false]);
});

test("W2270 guarded ship with hooks installed still publishes", () => {
	const world = hookWorld();
	const { repo } = world;
	const before = git(repo, "rev-parse", "HEAD").out;
	git(repo, "checkout", "-b", "suspenders/GUARD");
	writeFileSync(join(repo, "change.ts"), "export const valid = 1;\n");
	git(repo, "add", "change.ts");
	git(repo, "commit", "-m", "lane");
	git(repo, "checkout", "main");
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(join(repo, ".fleet/lanes.json"), "[]");
	const env = {
		...process.env,
		HOME: join(repo, ".test-home"),
		GOVERNOR_STORE_URL: "",
		FLEET_UNTRACKED_GRACE_MS: "0",
	};
	const seeded = Bun.spawnSync(
		[
			"bun",
			"-e",
			`
			import {openStore,projectIdentity} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/govdb/govdb.ts"))};
			import {reviewContext,publishReviewReceipt} from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/gates/review-receipt.ts"))};
			const db=openStore(), project=projectIdentity();
			const c=reviewContext(process.argv[1],"suspenders/GUARD");
			db.query("INSERT OR REPLACE INTO work_items(project,id,title,state,result_sha,created_at,updated_at) VALUES (?,'GUARD','fixture','DONE',?,?,?)").run(project,c.commit,Date.now(),Date.now());
			db.run("CREATE TABLE IF NOT EXISTS work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)");
			db.query("INSERT INTO work_completion_records VALUES (?,'GUARD',?,'fixture-author')").run(project,c.commit);
			db.query("INSERT INTO sessions(sid,project,role,started_at,hb,state) VALUES ('fixture-reviewer',?,'reviewer',?,?,'DONE')").run(project,Date.now(),Date.now());
			publishReviewReceipt(db,project,'GUARD',{version:1,commit:c.commit,base:c.base,instructions:c.instructions,reviewer:'fixture-reviewer',verdict:'PASS',blocking:[],evidence:'fixture independent review'});
			db.close();
		`,
			repo,
		],
		{ cwd: repo, env, stdout: "pipe", stderr: "pipe" },
	);
	if (seeded.exitCode !== 0) throw new Error(seeded.stderr.toString());
	// guarded ship publishes through the real merge ladder; the reference-
	// transaction hook sees a non-FF merge commit (ordinary-grant path)
	const ship = Bun.spawnSync(
		[
			"bun",
			join(import.meta.dir, "../hooks/bin/fleet-loop.ts"),
			"ship",
			"--repo",
			repo,
			"--branch",
			"suspenders/GUARD",
		],
		{ cwd: repo, env, stdout: "pipe", stderr: "pipe" },
	);
	if (git(repo, "rev-parse", "HEAD").out === before)
		throw new Error(
			`ship did not publish: ${ship.stderr.toString().slice(-1500)}\n${readFileSync(join(repo, ".fleet/loop.log"), "utf8").slice(-3500)}`,
		);
	expect(readFileSync(join(repo, ".fleet/loop.log"), "utf8")).toContain(
		"MERGED",
	);
});
