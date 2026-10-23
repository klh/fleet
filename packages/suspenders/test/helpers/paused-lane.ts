import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolated real claimed work graph shared by Stop and managed-runtime tests. */
export function pausedLaneFixture(sid = "pause-runtime-fixture") {
	const home = mkdtempSync(join(tmpdir(), "claimed-pause-"));
	const repo = join(home, "repo");
	mkdirSync(repo);
	const env = {
		...process.env,
		HOME: home,
		GOVERNOR_STORE_URL: "local",
		SUSPENDERS_SID: sid,
	};
	delete env.KLH_CLAIM_TOKEN;
	const hooks = new URL("../../hooks/", import.meta.url).pathname;
	const exec = (cwd: string, bin: string, args: string[], input?: string) =>
		execFileSync(bin, args, {
			cwd,
			env,
			input,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	exec(repo, "git", ["init", "-q"]);
	exec(repo, "git", ["config", "user.email", "fixture@example.invalid"]);
	exec(repo, "git", ["config", "user.name", "Fixture"]);
	exec(repo, "git", ["commit", "--allow-empty", "-qm", "baseline"]);
	const workAt = (cwd: string, args: string[]) =>
		exec(cwd, process.execPath, [join(hooks, "bin/work.ts"), ...args]);
	const id = workAt(repo, ["add", "pause fixture"]).match(/W\d+/)?.[0];
	if (!id) throw new Error("fixture work add did not return an ID");
	const take = workAt(repo, ["take", id, "--as", sid]);
	const cwd = take.match(/worktree: (.+)/)?.[1];
	if (!cwd) throw new Error("fixture take did not attach a worktree");
	const sha = exec(cwd, "git", ["rev-parse", "HEAD"]);
	mkdirSync(join(cwd, ".fleet"), { recursive: true });
	writeFileSync(
		join(cwd, ".fleet/lane-context.json"),
		JSON.stringify({
			sid,
			item: id,
			baseline: sha,
			launchedAt: 1,
			claimToken: take.match(/claim token: ([a-f0-9]+)/)?.[1],
		}),
	);
	const transcript = join(cwd, ".fleet/native-transcript.jsonl");
	writeFileSync(
		transcript,
		`${JSON.stringify({ type: "assistant", uuid: "fixture-native-turn", timestamp: new Date().toISOString(), message: { id: "fixture-native-message", content: [{ type: "text", text: "Checkpointing current progress." }] } })}\n`,
	);
	return {
		home,
		cwd,
		sid,
		env,
		hooks,
		sha,
		id,
		coord: (args: string[]) =>
			exec(cwd, process.execPath, [
				join(hooks, "bin/coord.ts"),
				...args,
				"--as",
				sid,
			]),
		work: (args: string[]) => workAt(cwd, args),
		stop: () => {
			const p = Bun.spawnSync(
				[process.execPath, join(hooks, "gate.ts"), "stop"],
				{
					cwd,
					env,
					stdin: Buffer.from(
						JSON.stringify({
							cwd,
							session_id: "native-uuid-not-fleet-sid",
							stop_hook_active: true,
							transcript_path: transcript,
						}),
					),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			return {
				code: p.exitCode,
				out: p.stdout.toString(),
				err: p.stderr.toString(),
			};
		},
	};
}
