import { expect, test } from "./pw";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";
import { laneSid } from "../hooks/lib/lanes/laneslug.ts";
import { dispatchHarness, stubBuckle } from "./helpers/dispatch-harness.ts";

const h = dispatchHarness(test.afterAll, {
	tag: "reclaimed-context",
	beltEnv: true,
	executorBody: "#!/usr/bin/env bun\nawait Bun.sleep(15000);\n",
});

test("canonical reclaimed dirty context starts a fresh transcript and keeps its baseline", async () => {
	const stub = stubBuckle(true);
	let fixturePid: number | undefined;
	try {
		const id = await h.addItem("Preserve reclaimed dirty continuation fixture");
		const sid = laneSid(id, projectIdentity(h.REPO));
		const take = await h.toolA({}, "work.ts", "take", id, "--as", sid);
		expect(take.code).toBe(0);
		const token = /claim token: ([a-f0-9]{48})/.exec(take.out)?.[1];
		expect(token).toBeDefined();
		const tree = join(h.REPO, ".worktrees", id);
		const baseline = Bun.spawnSync(["git", "-C", tree, "rev-parse", "HEAD"])
			.stdout.toString()
			.trim();
		mkdirSync(join(tree, ".fleet"), { recursive: true });
		writeFileSync(
			join(tree, ".fleet", "lane-context.json"),
			JSON.stringify({
				sid,
				item: id,
				baseline,
				launchedAt: 1,
				claimToken: token,
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			join(tree, "continuation.txt"),
			"preserve this untracked product\n",
		);
		writeFileSync(join(tree, "README.md"), "preserve this tracked product\n");
		const reclaimed = await h.toolA(
			{},
			"work.ts",
			"reclaim",
			id,
			"--reason",
			"user",
		);
		expect(reclaimed.code).toBe(0);
		const result = await h.dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(h.HOME, "belt.env"),
				SUSPENDERS_RESUME_RETAKE: "off",
			},
			"--item",
			id,
		);
		expect(result.out).not.toContain("unbanked residue");
		expect(result.out).toContain(`dispatched ${id} → ${sid}`);
		fixturePid = JSON.parse(
			readFileSync(join(h.REPO, ".fleet", "lanes.json"), "utf8"),
		).find((lane: { item: string }) => lane.item === id)?.pid;
		expect(readFileSync(join(tree, "continuation.txt"), "utf8")).toBe(
			"preserve this untracked product\n",
		);
		expect(readFileSync(join(tree, "README.md"), "utf8")).toBe(
			"preserve this tracked product\n",
		);
		const context = JSON.parse(
			readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8"),
		);
		expect(context.baseline).toBe(baseline);
		expect(context.claimToken).not.toBe(token);
		expect(readFileSync(join(tree, ".klh-brief.md"), "utf8")).not.toContain(
			"RESUME MODE:",
		);
		const inspect = async (overrides: Record<string, unknown> = {}) => {
			const module = join(
				import.meta.dir,
				"../hooks/lib/lanes/reclaim-context.ts",
			);
			const dbModule = join(import.meta.dir, "../hooks/lib/govdb/govdb.ts");
			const item = JSON.parse(
				(await h.toolA({}, "work.ts", "show", id, "--json")).out,
			);
			const args = {
				project: projectIdentity(h.REPO),
				item: id,
				sid,
				token: context.claimToken,
				revision: item.updated_at,
				tree,
				...overrides,
			};
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { verifiedContextContinuation } from ${JSON.stringify(module)}; import { openStore } from ${JSON.stringify(dbModule)}; const store=openStore(); console.log(verifiedContextContinuation(store,JSON.parse(process.env.TEST_CONTINUATION)));store.close();`,
				],
				{
					cwd: tree,
					env: { ...h.env, TEST_CONTINUATION: JSON.stringify(args) },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const out = await new Response(child.stdout).text();
			expect(await child.exited).toBe(0);
			return out.trim() === "true";
		};
		expect(await inspect()).toBe(true);
		expect(await inspect({ token: "0".repeat(48) })).toBe(false);
		expect(await inspect({ sid: "another-owner" })).toBe(false);
		expect(await inspect({ tree: h.REPO })).toBe(false);
		expect(await inspect({ revision: 1 })).toBe(false);
		writeFileSync(
			join(tree, ".fleet", "lane-context.json"),
			JSON.stringify({ ...context, baseline: "0".repeat(40) }),
		);
		expect(await inspect()).toBe(false);
		writeFileSync(
			join(tree, ".fleet", "lane-context.json"),
			JSON.stringify(context),
		);
	} finally {
		if (fixturePid) process.kill(fixturePid, "SIGTERM");
		stub.stop();
	}
}, 30_000);

test("fresh dirty tree without canonical context cannot be adopted", async () => {
	const stub = stubBuckle(true);
	try {
		const id = await h.addItem("Unrelated dirty tree fixture");
		const sid = laneSid(id, projectIdentity(h.REPO));
		expect((await h.toolA({}, "work.ts", "take", id, "--as", sid)).code).toBe(
			0,
		);
		const tree = join(h.REPO, ".worktrees", id);
		writeFileSync(
			join(tree, "unrelated.txt"),
			"never adopt unrelated residue\n",
		);
		const result = await h.dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(h.HOME, "belt.env"),
			},
			"--item",
			id,
		);
		expect(result.out).toContain(
			`SKIP ${id} — worktree holds unbanked residue`,
		);
		expect(readFileSync(join(tree, "unrelated.txt"), "utf8")).toBe(
			"never adopt unrelated residue\n",
		);
	} finally {
		stub.stop();
	}
}, 30_000);

test("W1730 a released manual tree with its own product launches from its registered original base", async () => {
	const stub = stubBuckle(true);
	let fixturePid: number | undefined;
	try {
		const id = await h.addItem("Resume released manual product fixture");
		const sid = laneSid(id, projectIdentity(h.REPO));
		const manual = await h.toolA(
			{},
			"work.ts",
			"take",
			id,
			"--as",
			"manual-original",
		);
		expect(manual.code).toBe(0);
		const tree = join(h.REPO, ".worktrees", id);
		const git = (...args: string[]) =>
			Bun.spawnSync([
				"git",
				"-C",
				tree,
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@example.invalid",
				...args,
			]);
		const base = git("rev-parse", "HEAD").stdout.toString().trim();
		writeFileSync(join(tree, "original.ts"), "export const original = true;\n");
		expect(git("add", "original.ts").exitCode).toBe(0);
		expect(git("commit", "-m", "original manual product").exitCode).toBe(0);
		expect(
			(await h.toolA({}, "work.ts", "reclaim", id, "--reason", "user")).code,
		).toBe(0);
		const result = await h.dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BELT_ENV: join(h.HOME, "belt.env"),
				SUSPENDERS_RESUME_RETAKE: "off",
			},
			"--item",
			id,
		);
		expect(result.out).toContain(`dispatched ${id} → ${sid}`);
		fixturePid = JSON.parse(
			readFileSync(join(h.REPO, ".fleet", "lanes.json"), "utf8"),
		).find((lane: { item: string }) => lane.item === id)?.pid;
		// a HEAD-minted context (the W1357/W1315.1 refusal) hides original.ts
		const context = JSON.parse(
			readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8"),
		);
		expect(context.sid).toBe(sid);
		expect(context.baseline).toBe(base);
	} finally {
		if (fixturePid) process.kill(fixturePid, "SIGTERM");
		stub.stop();
	}
}, 30_000);
