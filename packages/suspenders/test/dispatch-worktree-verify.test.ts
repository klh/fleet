// test/dispatch-worktree-verify.test.ts — W695.8.7 re-integration of
// parked/W349: dispatch verifies the worktree branch before spawn. Lives in
// its own file because dispatch-next.test.ts sits at the 1500-line law cap;
// the harness mirrors dispatch-next.test.ts (scratch HOME + repo + async
// spawns so the stub buckle front never stalls).
import { describe, expect, test, afterAll } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	chmodSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneSid } from "../hooks/lib/laneslug.ts";
import { projectIdentity } from "../hooks/lib/govdb.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-w349-dispatch-home-"));
const REPO = realpathSync(
	mkdtempSync(join(tmpdir(), "suspenders-w349-dispatch-repo-")),
);
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const testExecutor = join(HOME, "test-claude");
writeFileSync(testExecutor, "#!/bin/sh\nexit 0\n");
chmodSync(testExecutor, 0o700);
const env = {
	SUSPENDERS_CLAUDE_BIN: testExecutor,
	...process.env,
	HOME,
	SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
	SUSPENDERS_LANE_MAX_ATTEMPTS: "3",
};

mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

// scratch repo: one commit so worktree ops would have a base
const g = (args: string[]): void => {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd: REPO,
		encoding: "utf8",
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
writeFileSync(join(REPO, "README.md"), "x");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

// scratch belt.env with an admin key — mint succeeds at the stub below
writeFileSync(join(HOME, "belt.env"), "BUCKLE_ADMIN_KEY=bksk_admin_scratch\n");

const stubBuckle = (mint = false): {
	port: number;
	calls: string[];
	stop: () => void;
} => {
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			calls.push(`${req.method} ${path}`);
			if (path === "/status") return new Response("ok");
			if (path === "/v1/admin/keys" && mint)
				return Response.json({ key: "bksk_fixture_only", key_id: "owned-key" });
			if (path === "/v1/admin/keys")
				return new Response(JSON.stringify({ error: "stub-mint-fail" }), {
					status: 500,
				});
			if (path.endsWith("/revoke"))
				return new Response(JSON.stringify({ revoked: "ok" }));
			return new Response("not found", { status: 404 });
		},
	});
	return { port: server.port, calls, stop: () => server.stop(true) };
};

const toolA = async (
	extra: Record<string, string | undefined>,
	bin: string,
	...args: string[]
): Promise<{ out: string; err: string; code: number }> => {
	const p = Bun.spawn([process.execPath, join(BIN, bin), ...args], {
		cwd: REPO,
		env: { ...env, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	const code = await p.exited;
	return { out, err, code };
};

const dispatchA = async (
	extra: Record<string, string | undefined>,
	...args: string[]
): Promise<{ out: string; err: string; code: number }> => {
	const p = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "..", "scripts", "dispatch-next.ts"),
			"--repo",
			REPO,
			...args,
		],
		{
			cwd: REPO,
			env: { ...env, ...extra },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	const code = await p.exited;
	return { out, err, code };
};

const addItem = async (title: string): Promise<string> => {
	const added = await toolA({}, "work.ts", "add", title);
	const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
	expect(id).toBeTruthy();
	return id;
};

describe("leftover worktree verification before spawn (W349)", () => {
	test("wrong-branch leftover is recreated before spawn", async () => {
		const stub = stubBuckle(true);
		const id = await addItem("W349 wrong-branch leftover fixture");
		const sid = laneSid(id, projectIdentity(REPO));
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
		expect((await toolA({}, "worktree.ts", "create", id)).code).toBe(0);
		const dir = join(REPO, ".worktrees", id);
		// the W219 disease: the tree sits on a foreign branch
		const foreign = `suspenders/foreign-${id}`;
		Bun.spawnSync(["git", "-C", dir, "checkout", "-b", foreign], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const result = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
			},
			"--item",
			id,
		);
		expect(result.out).toContain("before spawn (W349)");
		expect(
			Bun.spawnSync(["git", "-C", dir, "branch", "--show-current"], {
				stdout: "pipe",
			})
				.stdout.toString()
				.trim(),
		).toBe(`suspenders/${id}`);
		expect(existsSync(join(dir, ".klh-brief.md"))).toBe(true);
		stub.stop();
		rmSync(join(REPO, ".fleet", "lanes.json"), { force: true });
	}, 60_000);

	test("dirty wrong-branch leftover refuses the spawn and keeps the residue", async () => {
		const stub = stubBuckle(true);
		const id = await addItem("W349 dirty leftover fixture");
		const sid = laneSid(id, projectIdentity(REPO));
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
		expect((await toolA({}, "worktree.ts", "create", id)).code).toBe(0);
		const dir = join(REPO, ".worktrees", id);
		const foreign = `suspenders/foreign-${id}`;
		Bun.spawnSync(["git", "-C", dir, "checkout", "-b", foreign], {
			stdout: "ignore",
			stderr: "ignore",
		});
		writeFileSync(join(dir, "residue.txt"), "x");
		const result = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
			},
			"--item",
			id,
		);
		expect(result.out).toContain("residue is never silently discarded");
		expect(existsSync(join(dir, "residue.txt"))).toBe(true); // untouched
		expect(existsSync(join(dir, ".klh-brief.md"))).toBe(false); // no spawn
		// uncommitted launch → claim released for retry once residue cleared
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("READY");
		stub.stop();
		rmSync(join(REPO, ".fleet", "lanes.json"), { force: true });
	}, 60_000);

	test("right-branch residue refuses a fresh spawn; a resume stands", async () => {
		const stub = stubBuckle(true);
		const id = await addItem("W349 unbanked residue fixture");
		const sid = laneSid(id, projectIdentity(REPO));
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
		expect((await toolA({}, "worktree.ts", "create", id)).code).toBe(0);
		const dir = join(REPO, ".worktrees", id);
		writeFileSync(join(dir, "residue.txt"), "x"); // dirty, right branch
		const env2 = {
			SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
			SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
		};
		const fresh = await dispatchA(env2, "--item", id);
		expect(fresh.out).toContain("unbanked residue");
		expect(existsSync(join(dir, "residue.txt"))).toBe(true);
		expect(existsSync(join(dir, ".klh-brief.md"))).toBe(false);
		// a dead-lane resume owns that state — the tree stands and it spawns.
		// The fresh SKIP released the claim; re-take it so isResumableClaim holds.
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		writeFileSync(
			join(REPO, ".fleet", "lanes.json"),
			JSON.stringify([
				{
					sid,
					item: id,
					pid: 99999999,
					branch: `suspenders/${id}`,
					worktree: dir,
					launchedAt: 1,
					attempt: 0,
				},
			]),
		);
		const resumed = await dispatchA(env2, "--item", id);
		expect(resumed.out).not.toContain("unbanked residue");
		expect(existsSync(join(dir, "residue.txt"))).toBe(true); // resume keeps it
		expect(existsSync(join(dir, ".klh-brief.md"))).toBe(true);
		stub.stop();
		rmSync(join(REPO, ".fleet", "lanes.json"), { force: true });
	}, 60_000);

	test("dry-run previews the recreation without performing it", async () => {
		const id = await addItem("W349 dry-run leftover fixture");
		const sid = laneSid(id, projectIdentity(REPO));
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
		expect((await toolA({}, "worktree.ts", "create", id)).code).toBe(0);
		const dir = join(REPO, ".worktrees", id);
		const foreign = `suspenders/foreign-${id}`;
		Bun.spawnSync(["git", "-C", dir, "checkout", "-b", foreign], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const result = await dispatchA({}, "--item", id, "--dry-run");
		expect(result.out).toContain("DRY dispatch");
		expect(result.out).toContain("live dispatch recreates it before spawn");
		// dry-run is read-only: the tree still sits on the foreign branch
		expect(
			Bun.spawnSync(["git", "-C", dir, "branch", "--show-current"], {
				stdout: "pipe",
			})
				.stdout.toString()
				.trim(),
		).toBe(`suspenders/foreign-${id}`);
	}, 60_000);
});
