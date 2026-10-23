import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPushSecrets } from "../hooks/lib/push-secrets.ts";

const GATE = join(import.meta.dir, "../hooks/gate.ts");
function gate(repo: string, command: string): string {
	const child = Bun.spawnSync([process.execPath, GATE, "pre-bash"], {
		cwd: repo,
		env: { ...process.env, HOME: join(repo, "..") },
		stdin: new TextEncoder().encode(
			JSON.stringify({
				tool_name: "Bash",
				tool_input: { command },
				cwd: repo,
				session_id: "push-range-fixture",
			}),
		),
		stdout: "pipe",
		stderr: "pipe",
	});
	return child.stdout.toString();
}

const secret = [
	"ghp_",
	"xK9mQ2vL",
	"8pR4tW7z",
	"B3nC6yF0",
	"jH5sD1aG",
	"9eU2",
].join("");
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "push-secrets-"));
	const repo = join(root, "repo"),
		remote = join(root, "remote.git");
	const git = (args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
	git(["config", "user.name", "Fixture"]);
	git(["config", "user.email", "fixture@example.test"]);
	Bun.spawnSync(["git", "init", "--bare", "-q", remote]);
	git(["remote", "add", "origin", remote]);
	const commit = (text: string) => {
		writeFileSync(join(repo, "data.txt"), text);
		git(["add", "."]);
		git(["commit", "-qm", "fixture"]);
		return git(["rev-parse", "HEAD"]);
	};
	commit("safe baseline\n");
	git(["push", "-qu", "origin", "main"]);
	return {
		repo,
		git,
		commit,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("only actual outgoing history is scanned, not an unrelated secret branch", () => {
	const f = fixture();
	try {
		f.git(["checkout", "-qb", "unrelated"]);
		f.commit(secret);
		f.git(["checkout", "-q", "main"]);
		f.commit("safe outgoing\n");
		expect(scanPushSecrets(f.repo, ["origin", "main"]).ok).toBe(true);
		expect(gate(f.repo, "git push origin main")).toBe("{}");
		expect(scanPushSecrets(f.repo, ["origin", "unrelated"]).ok).toBe(false);
		expect(gate(f.repo, "git push origin unrelated")).toContain(
			'"permissionDecision":"deny"',
		);
		expect(
			gate(f.repo, "git -c remote.origin.url=elsewhere push origin main"),
		).toContain('"permissionDecision":"deny"');
		f.commit(secret);
		f.commit("removed but still in outgoing history\n");
		expect(scanPushSecrets(f.repo, ["origin", "main"]).ok).toBe(false);
	} finally {
		f.cleanup();
	}
});

test("new branches, tags and multiple refspecs scan all genuine outgoing ancestors", () => {
	const f = fixture();
	try {
		f.git(["checkout", "-qb", "safe"]);
		f.commit("safe\n");
		f.git(["checkout", "-qb", "unsafe"]);
		f.commit(secret);
		f.git(["tag", "unsafe-tag"]);
		expect(scanPushSecrets(f.repo, ["origin", "safe", "unsafe"]).ok).toBe(
			false,
		);
		expect(scanPushSecrets(f.repo, ["origin", "refs/tags/unsafe-tag"]).ok).toBe(
			false,
		);
		expect(
			scanPushSecrets(f.repo, ["origin", "HEAD:refs/heads/renamed"]).ok,
		).toBe(false);
		f.git(["checkout", "-q", "main"]);
		f.git(["tag", "-a", "annotation", "-m", secret]);
		expect(scanPushSecrets(f.repo, ["origin", "refs/tags/annotation"]).ok).toBe(
			false,
		);
	} finally {
		f.cleanup();
	}
});

test("default pushes and deletions resolve safely; unknown or unresolved pushes fail closed", () => {
	const f = fixture();
	try {
		f.commit("safe\n");
		expect(scanPushSecrets(f.repo, []).ok).toBe(true);
		expect(scanPushSecrets(f.repo, ["origin", ":main"]).ok).toBe(true);
		expect(scanPushSecrets(f.repo, ["--delete", "origin", "main"]).ok).toBe(
			true,
		);
		expect(scanPushSecrets(f.repo, ["origin", "missing"]).ok).toBe(false);
		expect(scanPushSecrets(f.repo, ["--invented", "origin", "main"]).ok).toBe(
			false,
		);
		expect(scanPushSecrets(f.repo, ["missing-remote", "main"]).ok).toBe(false);
	} finally {
		f.cleanup();
	}
});

test("merge-only secrets, follow-tags and wildcard/mirror selections remain scanned", () => {
	const f = fixture();
	try {
		f.git(["checkout", "-qb", "feature"]);
		f.commit("feature\n");
		f.git(["checkout", "-q", "main"]);
		writeFileSync(join(f.repo, "other.txt"), "main\n");
		f.git(["add", "."]);
		f.git(["commit", "-qm", "main"]);
		f.git(["merge", "--no-ff", "--no-commit", "feature"]);
		writeFileSync(join(f.repo, "merged.txt"), secret);
		f.git(["add", "."]);
		f.git(["commit", "-qm", "merge"]);
		expect(scanPushSecrets(f.repo, ["origin", "main"]).ok).toBe(false);
		expect(
			scanPushSecrets(f.repo, ["origin", "refs/heads/*:refs/heads/*"]).ok,
		).toBe(false);
		expect(scanPushSecrets(f.repo, ["--mirror", "origin"]).ok).toBe(false);
		f.git(["checkout", "-q", "feature"]);
		f.git(["tag", "-a", "reachable", "-m", secret]);
		expect(
			scanPushSecrets(f.repo, ["--follow-tags", "origin", "feature"]).ok,
		).toBe(false);
		expect(scanPushSecrets(f.repo, ["origin", "tag", "reachable"]).ok).toBe(
			false,
		);
	} finally {
		f.cleanup();
	}
});

test("configured push refspecs and mirror mode cannot omit outgoing secret refs", () => {
	const f = fixture();
	try {
		f.git(["checkout", "-qb", "unsafe"]);
		f.commit(secret);
		f.git(["checkout", "-q", "main"]);
		f.git([
			"config",
			"remote.origin.push",
			"refs/heads/unsafe:refs/heads/unsafe",
		]);
		expect(scanPushSecrets(f.repo, ["origin"]).ok).toBe(false);
		f.git(["config", "--unset", "remote.origin.push"]);
		f.git(["config", "remote.origin.mirror", "true"]);
		expect(scanPushSecrets(f.repo, ["origin"]).ok).toBe(false);
	} finally {
		f.cleanup();
	}
});
