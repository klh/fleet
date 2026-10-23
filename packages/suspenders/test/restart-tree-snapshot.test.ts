import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartTreeHash } from "../scripts/lib/restart-tree-snapshot.ts";

const roots: string[] = [];
const git = (cwd: string, args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw Error(p.stderr.toString());
	return p.stdout.toString();
};
function repo() {
	const root = mkdtempSync(join(tmpdir(), "restart-tree-"));
	roots.push(root);
	git(root, ["init", "-q"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(root, "tracked.ts"), "export const value = 1;\n");
	git(root, ["add", "tracked.ts"]);
	git(root, ["commit", "-qm", "baseline"]);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("ordinary snapshot retains exact previous encoding and detects tracked/untracked edits", () => {
	const root = repo();
	writeFileSync(join(root, "new.ts"), "new source\n");
	const expected = hash(
		JSON.stringify([
			git(root, ["rev-parse", "HEAD"]).trim(),
			git(root, ["diff", "--binary", "HEAD"]),
			["new.ts", hash("new source\n")],
		]),
	);
	expect(restartTreeHash(root)).toBe(expected);
	writeFileSync(join(root, "new.ts"), "changed source\n");
	expect(restartTreeHash(root)).not.toBe(expected);
	const next = restartTreeHash(root);
	writeFileSync(join(root, "tracked.ts"), "export const value = 2;\n");
	expect(restartTreeHash(root)).not.toBe(next);
});

test("collapsed embedded Git directory and nested worktree are hashed without executing child Git", () => {
	const root = repo(),
		embedded = join(root, "probe", "repo");
	mkdirSync(embedded, { recursive: true });
	git(embedded, ["init", "-q"]);
	git(embedded, ["config", "user.name", "Fixture"]);
	git(embedded, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(embedded, "product.ts"), "original\n");
	git(embedded, ["add", "product.ts"]);
	git(embedded, ["commit", "-qm", "child baseline"]);
	git(embedded, [
		"worktree",
		"add",
		"--detach",
		"--quiet",
		join(embedded, "child"),
	]);
	expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toContain(
		"probe/repo/",
	);
	const original = restartTreeHash(root);
	expect(restartTreeHash(root)).toBe(original);
	writeFileSync(
		join(embedded, "child", "product.ts"),
		"preserved dirty child\n",
	);
	expect(restartTreeHash(root)).not.toBe(original);
	expect(readFileSync(join(embedded, "child", "product.ts"), "utf8")).toBe(
		"preserved dirty child\n",
	);
});

test("internal links bind target contents and link text; external links and cycles refuse", () => {
	const root = repo(),
		external = repo();
	writeFileSync(join(root, "target.txt"), "a");
	symlinkSync("target.txt", join(root, "link"));
	const first = restartTreeHash(root);
	rmSync(join(root, "link"));
	symlinkSync("./target.txt", join(root, "link"));
	expect(restartTreeHash(root)).not.toBe(first);
	writeFileSync(join(root, "target.txt"), "b");
	expect(restartTreeHash(root)).not.toBe(first);
	symlinkSync(join(external, "tracked.ts"), join(root, "outside"));
	expect(() => restartTreeHash(root)).toThrow("symlink escapes");
	rmSync(join(root, "outside"));
	symlinkSync(".", join(root, "cycle"));
	expect(() => restartTreeHash(root)).toThrow("cycle");
});

test("embedded external gitdir reference refuses without reading the external repository", () => {
	const root = repo(),
		external = repo(),
		embedded = join(root, "child");
	mkdirSync(embedded);
	writeFileSync(join(embedded, ".git"), `gitdir: ${join(external, ".git")}\n`);
	writeFileSync(join(embedded, "product.ts"), "preserve me\n");
	expect(() => restartTreeHash(root)).toThrow("Git reference escapes");
	expect(readFileSync(join(embedded, "product.ts"), "utf8")).toBe(
		"preserve me\n",
	);
});

test("bounds refuse explicitly and sanctioned artifacts do not hide similarly named source", () => {
	const root = repo();
	writeFileSync(join(root, "source-node_modules-helper.ts"), "a");
	const first = restartTreeHash(root);
	writeFileSync(join(root, "source-node_modules-helper.ts"), "b");
	expect(restartTreeHash(root)).not.toBe(first);
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "artifact"), "ignored dependency");
	mkdirSync(join(root, ".fleet"));
	writeFileSync(join(root, ".fleet", "artifact"), "ignored runtime");
	const limits = {
		entries: 10000,
		bytes: 256 * 1024 * 1024,
		depth: 48,
		durationMs: 10000,
	};
	expect(() => restartTreeHash(root, { ...limits, bytes: 0 })).toThrow(
		"byte bound",
	);
	expect(() => restartTreeHash(root, { ...limits, entries: 0 })).toThrow(
		"entry/depth bound",
	);
	expect(() => restartTreeHash(root, { ...limits, durationMs: -1 })).toThrow(
		"duration",
	);
	const embedded = join(root, "embedded");
	mkdirSync(embedded);
	git(embedded, ["init", "-q"]);
	expect(() => restartTreeHash(root, { ...limits, depth: 0 })).toThrow(
		"entry/depth bound",
	);
	symlinkSync("../tracked.ts", join(embedded, ".git", "linked-metadata"));
	expect(() => restartTreeHash(root)).toThrow("symlinked Git metadata");
});
