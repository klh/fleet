import { expect, test } from "./pw";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dir, "../hooks/bin");

test("remote-store completion cannot opt out of lane evidence and distinguishes imported test refactors", async () => {
	const root = mkdtempSync(join(tmpdir(), "completion-authority-"));
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(repo);
	const env = {
		...process.env,
		HOME: home,
		GOVERNOR_STORE_URL: "",
		SUSPENDERS_CLAIM_CHECK: "0",
	};
	delete env.KLH_CLAIM_TOKEN;
	delete env.SUSPENDERS_SID;
	delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
	delete env.GOVERNOR_STORE_TOKEN;
	delete env.GOVERNOR_STORE_SERVER_TOKEN_FILE;
	const git = (cwd: string, ...args: string[]) => {
		const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode, p.stderr.toString()).toBe(0);
		return p.stdout.toString().trim();
	};
	const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = probe.port;
	probe.stop(true);
	const server = Bun.spawn(
		[process.execPath, join(bin, "store-server.ts"), "--port", String(port)],
		{ env, stdout: "ignore", stderr: "pipe" },
	);
	const url = `http://127.0.0.1:${port}`;
	try {
		let healthy = false;
		for (let n = 0; n < 100; n++) {
			try {
				healthy = (await fetch(`${url}/health`)).ok;
			} catch {}
			if (healthy) break;
			await Bun.sleep(20);
		}
		expect(healthy).toBe(true);
		env.GOVERNOR_STORE_URL = url;
		git(repo, "init", "-b", "main");
		git(repo, "config", "user.name", "Fixture Reviewer");
		git(repo, "config", "user.email", "reviewer@example.invalid");
		const originalTest =
			'import {test,expect} from "bun:test";\ntest("sum",()=>expect(1+2).toBe(3));\n';
		writeFileSync(join(repo, "calculation.test.ts"), originalTest);
		git(repo, "add", ".");
		git(repo, "commit", "-m", "baseline test");
		const baseline = git(repo, "rev-parse", "HEAD");
		const cli = (file: string, cwd: string, ...args: string[]) => {
			const p = Bun.spawnSync([process.execPath, join(bin, file), ...args], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				code: p.exitCode,
				text: p.stdout.toString() + p.stderr.toString(),
			};
		};
		const sid = "completion-authority-fixture";
		expect(
			cli("coord.ts", repo, "bootstrap", "--as", sid, "--role", "worker").code,
		).toBe(0);
		const added = cli(
			"work.ts",
			repo,
			"add",
			"Preserve truthful completion evidence",
		);
		expect(added.code).toBe(0);
		const item = added.text.match(/W\d+/)?.[0] ?? "";
		const take = cli("work.ts", repo, "take", item, "--as", sid);
		expect(take.code, take.text).toBe(0);
		const token = take.text.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
		expect(token).toHaveLength(48);
		const tree = join(repo, ".worktrees", item);
		mkdirSync(join(tree, ".fleet"), { recursive: true });
		writeFileSync(
			join(tree, ".fleet/lane-context.json"),
			JSON.stringify({ sid, item, baseline, claimToken: token }),
		);
		writeFileSync(join(tree, "product.ts"), "export const result = 1 + 2;\n");
		git(tree, "add", "product.ts");
		git(tree, "commit", "-m", "implement result");
		// An upstream refactor replaces a test declaration with a shared helper.
		writeFileSync(
			join(repo, "calculation.test.ts"),
			'import {test,expect} from "bun:test";\nfunction exercise(){expect(1+2).toBe(3)}\ntest("shared sum",exercise);\n',
		);
		git(repo, "add", "calculation.test.ts");
		git(repo, "commit", "-m", "upstream test refactor");
		const upstream = git(repo, "rev-parse", "HEAD");
		git(tree, "merge", "--no-edit", "main");
		const good = git(tree, "rev-parse", "HEAD");
		rmSync(join(tree, "calculation.test.ts"));
		git(tree, "add", "calculation.test.ts");
		git(tree, "commit", "-m", "lane erodes existing test");
		const bad = git(tree, "rev-parse", "HEAD");
		const summary =
			"Implemented the result module with immutable product evidence and retained existing assertions.";
		const done = (sha: string, owner = sid, supplied = token) =>
			cli(
				"work.ts",
				tree,
				"done",
				item,
				"--as",
				owner,
				"--token",
				supplied,
				"--sha",
				sha,
				"--summary",
				summary,
			);
		const eroded = done(bad);
		expect(eroded.code, eroded.text).not.toBe(0);
		expect(eroded.text).toContain("closing diff erodes the test suite");
		expect(eroded.text).not.toContain("Escape hatch");
		git(tree, "branch", "-m", "unbound-lane");
		const unknownScope = done(bad);
		expect(unknownScope.code, unknownScope.text).not.toBe(0);
		expect(unknownScope.text).toContain("closing diff erodes the test suite");
		git(tree, "branch", "-m", `suspenders/${item}`);
		expect(
			JSON.parse(cli("work.ts", repo, "show", item, "--json").text).state,
		).toBe("CLAIMED");
		expect(done(good, "foreign-owner").code).not.toBe(0);
		expect(done(good, sid, "0".repeat(48)).code).not.toBe(0);
		// The immutable good candidate contains the upstream test split, not
		// the lane's later erosion. No baseline or history is rewritten.
		const accepted = done(good);
		expect(accepted.code, accepted.text).toBe(0);
		const record = JSON.parse(
			cli("work.ts", repo, "show", item, "--json").text,
		).completion;
		expect(record.baseline_sha).toBe(baseline);
		expect(record.commit_sha).toBe(good);
		expect(JSON.parse(record.evidence_json).claim_check_diff_base).toBe(
			upstream,
		);
		expect(
			readFileSync(join(tree, ".fleet/lane-context.json"), "utf8"),
		).toContain(baseline);
	} finally {
		server.kill();
		await server.exited;
		rmSync(root, { recursive: true, force: true });
	}
}, 20_000);
