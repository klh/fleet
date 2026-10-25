// test/dispatch-worktree-verify.test.ts — W695.8.7 re-integration of
// parked/W349: dispatch verifies the worktree branch before spawn. The
// scratch HOME/repo + async spawns come from the shared dispatch harness
// (test/helpers/dispatch-harness.ts) so the stub buckle front never stalls.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneSid } from "../hooks/lib/lanes/laneslug.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";
import { dispatchHarness, stubBuckle } from "./helpers/dispatch-harness.ts";

const { HOME, REPO, toolA, dispatchA, addItem } = dispatchHarness(afterAll, {
	tag: "w349-dispatch",
	beltEnv: true,
});

describe("leftover worktree verification before spawn (W349)", () => {
	test("wrong-branch leftover is recreated before spawn", async () => {
		const stub = stubBuckle(true);
		const id = await addItem("W349 wrong-branch leftover fixture");
		const sid = laneSid(id, projectIdentity(REPO));
		// W870: take provisions the tree — no explicit create needed
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
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
		// W870: take provisions the tree — no explicit create needed
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
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
		// W870: take provisions the tree — no explicit create needed
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
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
		// W870: take provisions the tree — no explicit create needed
		expect((await toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(0);
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
