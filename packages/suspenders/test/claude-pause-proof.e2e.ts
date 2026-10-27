import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pause proof rejects invented and nonancestor commits despite canonical-looking facts", () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-pause-proof-"));
	const env = {
		...process.env,
		HOME: dir,
		GOVERNOR_STORE_URL: "local",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	};
	const exec = (bin: string, args: string[], input?: string) =>
		execFileSync(bin, args, {
			cwd: dir,
			env,
			encoding: "utf8",
			input,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	const coord = join(import.meta.dir, "../hooks/bin/coord.ts");
	const sid = "proof-fixture";
	const fact = (key: string, value: string) =>
		exec(process.execPath, [coord, "fact", "set", key, value, "--as", sid]);
	const module = new URL(
		"../hooks/lib/executors/claude-pause.ts",
		import.meta.url,
	).pathname;
	const proof = () =>
		JSON.parse(
			exec(process.execPath, [
				"-e",
				`import {claudePauseProof} from ${JSON.stringify(module)}; console.log(JSON.stringify(await claudePauseProof(${JSON.stringify(sid)})));`,
			]),
		);
	try {
		exec("git", ["init", "--quiet"]);
		const tree = exec("git", ["mktree"], "");
		const head = exec("git", ["commit-tree", tree], "current\n");
		const other = exec("git", ["commit-tree", tree], "unrelated\n");
		exec("git", ["update-ref", "HEAD", head]);
		fact(`lane.${sid}.state`, "PAUSED");
		for (const checkpoint of ["f".repeat(40), other]) {
			fact(`lane.${sid}.capsule`, JSON.stringify({ checkpoint }));
			expect(proof()).toBeNull();
		}
		fact(`lane.${sid}.capsule`, JSON.stringify({ checkpoint: head }));
		expect(proof()).toEqual({ checkpoint: head });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
