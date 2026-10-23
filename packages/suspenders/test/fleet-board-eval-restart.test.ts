import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
	// W1119: the eval leg enters the Buckle gate — the mock gate answers the
	// scoped-key pair and the credential rides the 0600 knowledge-buckle.json
	// file contract (re-read at call time, so the restarted board's recovery
	// worker resolves it too).
	const gate = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch() {
			await sleep(1_500);
			return Response.json({
				content: [{ type: "text", text: "Keep the reviewed option." }],
			});
		},
	});
	const configDir = join(HOME, ".claude", "local-llm");
	mkdirSync(configDir, { recursive: true });
	const credPath = join(configDir, "knowledge-buckle.json");
	writeFileSync(
		credPath,
		JSON.stringify({ url: `http://127.0.0.1:${gate.port}`, token: "bksk_restart_test" }),
	);
	chmodSync(credPath, 0o600);
	let restarted: Bun.Subprocess | null = null;
	try {
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
		expect(
			run("coord.ts", [
				"emit",
				"NEED_DECISION",
				"--to",
				"advice-lane",
				"--note",
				"advice restart fork",
				"--as",
				"advice-lane",
			]).code,
		).toBe(0);
		const adviceRec = fork(await getDecisions(), "advice restart fork");
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, 'running', 'test', 1, ?)",
		).run(`advice.${adviceRec.id}.requested`, Date.now());
		db.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, '2147483647', 'test', 1, ?)",
		).run(`advice.${adviceRec.id}.workerPid`, Date.now());
		db.close();
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
		let advice: { adviceError?: string; advicePending?: string | null } | null =
			null;
		for (let i = 0; i < 30; i++) {
			advice = fork(await getDecisions(), "advice restart fork");
			if (advice?.adviceError) break;
			await sleep(100);
		}
		expect(advice?.adviceError).toBeTruthy();
		expect(advice?.advicePending).toBeNull();

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
		gate.stop(true);
	}
});
