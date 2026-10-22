import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { bytesHash } from "../hooks/lib/reclaim-context-evidence.ts";
import { projectIdentity } from "../hooks/lib/govdb-project.ts";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const h = dispatchHarness(afterAll, { tag: "completion-reconcile" });
const owner = "manual-completion-fixture";

async function fixture() {
	const id = await h.addItem("Immutable completion reconciliation fixture");
	const take = await h.toolA({}, "work.ts", "take", id, "--as", owner);
	expect(take.code).toBe(0);
	const token = /claim token: ([a-f0-9]{48})/.exec(take.out)?.[1];
	if (!token) throw new Error("fixture token missing");
	const tree = join(h.REPO, ".worktrees", id);
	mkdirSync(join(tree, "node_modules"));
	writeFileSync(
		join(tree, "node_modules", "fixture"),
		"fixture infrastructure\n",
	);
	writeFileSync(join(tree, `${id}.ts`), "export const product = 1;\n");
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", tree, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		return p.stdout.toString().trim();
	};
	git("add", `${id}.ts`);
	git("commit", "-m", "actual fixture product");
	const sha = git("rev-parse", "HEAD");
	h.g(["merge", "--ff-only", `suspenders/${id}`]);
	h.g(["update-ref", "refs/remotes/origin/main", sha]);
	const done = await h.toolA(
		{},
		"work.ts",
		"done",
		id,
		"--as",
		owner,
		"--token",
		token,
		"--sha",
		sha,
		"--summary",
		"Actual committed fixture product verified before immutable completion reconciliation test.",
	);
	expect(done.code).toBe(0);
	const original = JSON.parse(
		(await h.toolA({}, "work.ts", "show", id, "--json")).out,
	).completion;
	const module = join(import.meta.dir, "../hooks/lib/govdb.ts");
	const revision = Date.now() + 100;
	// Simulate the historical bug only in this isolated fixture store.
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`import{openStore}from${JSON.stringify(module)};const s=openStore();s.query("UPDATE work_items SET state='CLAIMED',owner_sid=?,updated_at=? WHERE project=? AND id=?").run(...JSON.parse(process.env.FIXTURE_DRIFT));s.close();`,
		],
		{
			cwd: h.REPO,
			env: {
				...h.env,
				FIXTURE_DRIFT: JSON.stringify([
					owner,
					revision,
					projectIdentity(h.REPO),
					id,
				]),
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(await child.exited).toBe(0);
	const proof = {
		project: projectIdentity(h.REPO),
		item: id,
		owner,
		revision,
		completionHash: bytesHash(JSON.stringify(original)),
		productSha: sha,
		tree,
		head: sha,
		attestation: "restore-verified-immutable-completion-without-new-work",
	};
	const path = join(h.HOME, `${id}-evidence.json`);
	writeFileSync(path, JSON.stringify(proof), { mode: 0o600 });
	const run = (extra: string[] = []) =>
		h.toolA(
			{},
			"work.ts",
			"reconcile-completion",
			id,
			"--force",
			"--expect-owner",
			owner,
			"--expect-updated-at",
			String(revision),
			"--evidence",
			path,
			...extra,
		);
	return { id, tree, sha, path, proof, original, run };
}

test("actual CLI restores graph once without rewriting immutable completion", async () => {
	const f = await fixture();
	const results = await Promise.all([f.run(), f.run()]);
	expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
	const shown = JSON.parse(
		(await h.toolA({}, "work.ts", "show", f.id, "--json")).out,
	);
	expect(shown.state).toBe("DONE");
	expect(shown.owner_sid).toBeNull();
	expect(shown.completion).toEqual(f.original);
	expect((await f.run()).code).not.toBe(0);
	const eventResult = await h.toolA(
		{},
		"coord.ts",
		"events",
		"--kinds",
		"work.done,work.completion-reconciled",
		"--last",
		"50",
		"--json",
	);
	expect(eventResult.code).toBe(0);
	const events = JSON.parse(eventResult.out).events.filter(
		(e: { payload: { work: string } }) => e.payload.work === f.id,
	);
	expect(
		events.filter((e: { kind: string }) => e.kind === "work.done"),
	).toHaveLength(1);
	expect(
		events.filter(
			(e: { kind: string }) => e.kind === "work.completion-reconciled",
		),
	).toHaveLength(1);
}, 30_000);

test("missing operator intent and unpublished committed work refuse restoration", async () => {
	const f = await fixture();
	const noForce = await h.toolA(
		{},
		"work.ts",
		"reconcile-completion",
		f.id,
		"--expect-owner",
		owner,
		"--expect-updated-at",
		String(f.proof.revision),
		"--evidence",
		f.path,
	);
	expect(noForce.code).not.toBe(0);
	writeFileSync(
		join(f.tree, "unpublished.ts"),
		"export const additionalWork=2;\n",
	);
	for (const args of [
		["add", "unpublished.ts"],
		["commit", "-m", "unpublished fixture work"],
	]) {
		const p = Bun.spawnSync(["git", "-C", f.tree, ...args], {
			stdout: "ignore",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
	}
	const head = Bun.spawnSync(["git", "-C", f.tree, "rev-parse", "HEAD"])
		.stdout.toString()
		.trim();
	writeFileSync(f.path, JSON.stringify({ ...f.proof, head }));
	const result = await f.run();
	expect(result.code).not.toBe(0);
	expect(result.err).toContain("ancestry");
}, 30_000);

test("stale revision, wrong immutable hash and dirty work fail closed", async () => {
	const f = await fixture();
	writeFileSync(
		f.path,
		JSON.stringify({ ...f.proof, revision: f.proof.revision - 1 }),
	);
	expect((await f.run()).code).not.toBe(0);
	writeFileSync(
		f.path,
		JSON.stringify({ ...f.proof, completionHash: "0".repeat(64) }),
	);
	expect((await f.run()).code).not.toBe(0);
	writeFileSync(f.path, JSON.stringify(f.proof));
	writeFileSync(join(f.tree, "unbanked.ts"), "export const unfinished = 2;\n");
	expect((await f.run()).code).not.toBe(0);
	expect(readFileSync(join(f.tree, "unbanked.ts"), "utf8")).toContain(
		"unfinished",
	);
}, 30_000);

test("public or symlink operator evidence is rejected", async () => {
	const f = await fixture();
	chmodSync(f.path, 0o644);
	expect((await f.run()).code).not.toBe(0);
	const target = `${f.path}-private`;
	writeFileSync(target, JSON.stringify(f.proof), { mode: 0o600 });
	const { unlinkSync } = await import("node:fs");
	unlinkSync(f.path);
	symlinkSync(target, f.path);
	expect((await f.run()).code).not.toBe(0);
}, 30_000);

test("conventional path on a different registered branch is not item proof", async () => {
	const f = await fixture();
	const changed = Bun.spawnSync(
		["git", "-C", f.tree, "checkout", "-b", `foreign-${f.id}`],
		{ stdout: "ignore", stderr: "pipe" },
	);
	expect(changed.exitCode).toBe(0);
	const result = await f.run();
	expect(result.code).not.toBe(0);
	expect(result.err).toContain("registered");
}, 30_000);

test("actual native attachment and competing claim owner refuse restoration", async () => {
	const f = await fixture();
	const executable = join(h.HOME, "claude");
	writeFileSync(executable, "#!/usr/bin/env bun\nawait Bun.sleep(60000);\n", {
		mode: 0o700,
	});
	const native = Bun.spawn([executable, "--session-id", owner], {
		cwd: f.tree,
		env: h.env,
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		await Bun.sleep(100);
		mkdirSync(join(h.REPO, ".fleet"), { recursive: true });
		writeFileSync(
			join(h.REPO, ".fleet", "lanes.json"),
			JSON.stringify([
				{
					sid: owner,
					item: f.id,
					pid: native.pid,
					worktree: f.tree,
					host: hostname(),
				},
			]),
		);
		const attached = await f.run();
		expect(attached.code).not.toBe(0);
		expect(attached.err).toContain("native process");
	} finally {
		native.kill();
		await native.exited;
		writeFileSync(join(h.REPO, ".fleet", "lanes.json"), "[]");
	}
	const module = join(import.meta.dir, "../hooks/lib/govdb.ts");
	const change = Bun.spawn(
		[
			process.execPath,
			"-e",
			`import{openStore}from${JSON.stringify(module)};const s=openStore();s.query("UPDATE work_items SET owner_sid='competing-owner',updated_at=updated_at+1 WHERE project=? AND id=?").run(...JSON.parse(process.env.FIXTURE_CAS));s.close();`,
		],
		{
			cwd: h.REPO,
			env: { ...h.env, FIXTURE_CAS: JSON.stringify([f.proof.project, f.id]) },
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	expect(await change.exited).toBe(0);
	const raced = await f.run();
	expect(raced.code).not.toBe(0);
	expect(raced.err).toContain("Claim changed");
	const shown = JSON.parse(
		(await h.toolA({}, "work.ts", "show", f.id, "--json")).out,
	);
	expect(shown.owner_sid).toBe("competing-owner");
	expect(shown.completion).toEqual(f.original);
}, 30_000);
