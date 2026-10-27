import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAPSULE_MAX_BYTES,
	assertCapsuleBounds,
	capsuleValidity,
} from "../hooks/lib/lanes/capsule-fence.ts";

const root = mkdtempSync(join(tmpdir(), "fleet-capsfence-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode === 0 ? p.stdout.toString().trim() : "";
};
git("init", "-q");
git("config", "user.email", "test@example.invalid");
git("config", "user.name", "test");
const commit = (msg: string): string => {
	writeFileSync(join(repo, "f.txt"), `${msg}\n`);
	git("add", "f.txt");
	git("commit", "-qm", msg);
	return git("rev-parse", "HEAD");
};
const base = commit("base");
const head = commit("next");

describe("assertCapsuleBounds", () => {
	test("under the cap returns the json with ts folded in", () => {
		const j = assertCapsuleBounds({ done: "x" }, 123);
		expect(JSON.parse(j).ts).toBe(123);
	});
	test("over the cap throws", () => {
		expect(() =>
			assertCapsuleBounds({ pad: "x".repeat(CAPSULE_MAX_BYTES) }, 1),
		).toThrow(/2048-byte cap/);
	});
});

describe("capsuleValidity", () => {
	test("no capsule → none + blind-start line", () => {
		const v = capsuleValidity(null, {});
		expect(v.verdict).toBe("none");
		expect(v.lines[0]).toContain("starting blind");
	});
	test('checkpoint "none" → advisory line', () => {
		const v = capsuleValidity({ checkpoint: "none" }, {});
		expect(v.verdict).toBe("none");
		expect(v.lines.join(" ")).toContain("no checkpoint");
	});
	test("fresh: checkpoint is the head", () => {
		const v = capsuleValidity(
			{ checkpoint: head, ts: String(Date.now()) },
			{ repoDir: repo, headSha: head },
		);
		expect(v.verdict).toBe("fresh");
		expect(v.past).toBe(0);
		expect(v.lines.join(" ")).toContain("fresh, banked");
	});
	test("behind: checkpoint is an ancestor with new commits", () => {
		const v = capsuleValidity(
			{ checkpoint: base, ts: String(Date.now()) },
			{ repoDir: repo, headSha: head },
		);
		expect(v.verdict).toBe("behind");
		expect(v.past).toBe(1);
		expect(v.lines.join(" ")).toContain("1 commit(s) behind");
	});
	test("diverged: checkpoint sha absent from the repo", () => {
		const v = capsuleValidity(
			{ checkpoint: "a".repeat(40), ts: String(Date.now()) },
			{ repoDir: repo, headSha: head },
		);
		expect(v.verdict).toBe("diverged");
		expect(v.lines.join(" ")).toContain("diverged");
	});
	test("diverged: checkpoint on a side branch (not an ancestor of head)", () => {
		git("checkout", "-qb", "side");
		const side = commit("side commit");
		const v = capsuleValidity(
			{ checkpoint: side, ts: String(Date.now()) },
			{ repoDir: repo, headSha: head },
		);
		expect(v.verdict).toBe("diverged");
		git("checkout", "-q", head);
	});
	test("unknown: head unreadable in a given repo", () => {
		const v = capsuleValidity(
			{ checkpoint: head },
			{ repoDir: repo, headSha: null },
		);
		expect(v.verdict).toBe("unknown");
		expect(v.lines.join(" ")).toContain("head unreadable");
	});
	test("unknown: no repo available at all", () => {
		const v = capsuleValidity({ checkpoint: head }, {});
		expect(v.verdict).toBe("unknown");
		expect(v.lines.join(" ")).toContain("no git repo available");
	});
	test("stale banked age rides the lines", () => {
		const v = capsuleValidity(
			{ checkpoint: head, ts: String(Date.now() - 25 * 3600 * 1000) },
			{ repoDir: repo, headSha: head },
		);
		expect(v.bankedAgeMin).toBeGreaterThan(24 * 60);
		expect(v.lines.join(" ")).toContain("stale hand-off");
	});
	test("checkpoint_ts ages the checkpoint in minutes", () => {
		const v = capsuleValidity(
			{
				checkpoint: head,
				ts: String(Date.now()),
				checkpoint_ts: String(Math.floor(Date.now() / 1000) - 600),
			},
			{ repoDir: repo, headSha: head },
		);
		expect(v.checkpointAgeMin).toBeGreaterThanOrEqual(9);
		expect(v.checkpointAgeMin).toBeLessThanOrEqual(11);
	});
});
