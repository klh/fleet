import { expect, test } from "@playwright/test";
import { rmSync } from "node:fs";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";

test("restart authority reads actual claimed graph and refuses unpaused, foreign and forged checkpoints", () => {
	const f = pausedLaneFixture();
	const module = new URL(
		"../scripts/lib/claude-restart-operation.ts",
		import.meta.url,
	).pathname;
	const read = (sid = f.sid) => {
		const child = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				"const {claudeRestartAuthority}=await import(process.env.FIXTURE_MODULE);try{const result=claudeRestartAuthority(process.env.FIXTURE_SID,process.env.FIXTURE_ITEM,process.cwd());console.log(JSON.stringify({checkpoint:result.checkpoint,owner:result.claim.owner_sid}));}catch(error){console.error(error.message);process.exitCode=1;}",
			],
			{
				cwd: f.cwd,
				env: {
					...f.env,
					FIXTURE_MODULE: module,
					FIXTURE_ITEM: f.id,
					FIXTURE_SID: sid,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		return {
			code: child.exitCode,
			out: child.stdout.toString(),
			error: child.stderr.toString(),
		};
	};
	try {
		expect(read().error).toContain("canonical PAUSED");
		f.coord(["fact", "set", `lane.${f.sid}.state`, "PAUSE_REQUESTED"]);
		f.coord([
			"capsule",
			"set",
			`--checkpoint=${f.sha}`,
			"--done=checkpoint",
			"--next=continue",
		]);
		f.coord(["paused", "--sha", f.sha]);
		expect(read()).toEqual({
			code: 0,
			out: `${JSON.stringify({ checkpoint: f.sha, owner: f.sid })}\n`,
			error: "",
		});
		expect(read("foreign-owner").error).toContain("claim context mismatch");
		f.coord([
			"fact",
			"set",
			`lane.${f.sid}.capsule`,
			JSON.stringify({ checkpoint: "f".repeat(40) }),
		]);
		expect(read().error).toContain("real ancestor checkpoint and capsule");
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
}, 10000);
