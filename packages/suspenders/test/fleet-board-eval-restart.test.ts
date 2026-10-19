import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

const fixture = await boardFixture(0, afterAll);
const {
	HOME,
	REPO,
	env,
	bin,
	BASE,
	TOKEN,
	run,
	getDecisions,
	fork,
	sleep,
	waitUp,
	proc,
} = fixture;

test("decision evaluation finishes across a board restart", async () => {
	const model = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch() {
			await sleep(1_500);
			return Response.json({
				choices: [{ message: { content: "Keep the reviewed option." } }],
			});
		},
	});
	let restarted: Bun.Subprocess | null = null;
	try {
		const configDir = join(HOME, ".claude", "local-llm");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "suspenders-board.json"),
			JSON.stringify({
				recommendation_url: `http://127.0.0.1:${model.port}/v1/chat/completions`,
				recommendation_model: "test",
			}),
		);
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"restart-lane",
				"--note",
				"restart eval fork",
				"--as",
				"restart-lane",
			]).code,
		).toBe(0);
		const rec = fork(await getDecisions(), "restart eval fork");
		const started = await fetch(`${BASE}/api/decisions/${rec.id}/evaluate`, {
			method: "POST",
			headers: { "x-klh-write-token": TOKEN },
		});
		expect(started.status).toBe(202);
		expect((await started.json()).running).toBe(true);
		const before = await (
			await fetch(`${BASE}/api/decisions/${rec.id}/evals`)
		).json();
		const workerPid = before.status?.workerPid as number;
		expect(workerPid).toBeGreaterThan(0);
		// launchd restarts terminate the board's child process too.
		process.kill(workerPid, "SIGKILL");
		proc.kill();
		await proc.exited;
		restarted = Bun.spawn(
			["bun", join(bin, "fleet-board.ts"), "--port", String(fixture.PORT)],
			{
				cwd: REPO,
				env,
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		await waitUp(BASE);
		let feed: {
			evals: { text: string }[];
			status: { running: boolean; error: string | null } | null;
		} | null = null;
		for (let i = 0; i < 30; i++) {
			feed = await (
				await fetch(`${BASE}/api/decisions/${rec.id}/evals`)
			).json();
			if (feed?.evals.length) break;
			await sleep(100);
		}
		expect(feed?.evals[0]?.text).toBe("Keep the reviewed option.");
		expect(feed?.evals).toHaveLength(1);
		expect(feed?.status).toMatchObject({ running: false, error: null });

		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"exit-lane",
				"--note",
				"worker exit fork",
				"--as",
				"exit-lane",
			]).code,
		).toBe(0);
		const exitRec = fork(await getDecisions(), "worker exit fork");
		const exitStart = await fetch(
			`${BASE}/api/decisions/${exitRec.id}/evaluate`,
			{ method: "POST", headers: { "x-klh-write-token": TOKEN } },
		);
		expect(exitStart.status).toBe(202);
		const exitFeed = await (
			await fetch(`${BASE}/api/decisions/${exitRec.id}/evals`)
		).json();
		process.kill(exitFeed.status.workerPid, "SIGKILL");
		let stopped: { status: { running: boolean; error: string | null } } | null =
			null;
		for (let i = 0; i < 20; i++) {
			stopped = await (
				await fetch(`${BASE}/api/decisions/${exitRec.id}/evals`)
			).json();
			if (stopped && !stopped.status.running) break;
			await sleep(100);
		}
		expect(stopped?.status.error).toContain("worker exited");
	} finally {
		restarted?.kill();
		await restarted?.exited;
		model.stop(true);
	}
});
