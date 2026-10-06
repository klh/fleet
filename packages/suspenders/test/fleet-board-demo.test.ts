// Demo board is isolated from the live board and other test files.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { boardFixture, unusedPort } from "./helpers/board-fixture.ts";
type Row = Record<string, unknown>;
const { HOME, REPO, TOKEN, env, bin, q, waitUp, setDemoProc } =
	await boardFixture(0, afterAll);

describe("demo mode (--demo)", () => {
	const DEMO_PORT = unusedPort();
	const DEMO_BASE = `http://127.0.0.1:${DEMO_PORT}`;
	const demoProj = `${HOME}/.cache/claude-governor/demo`;
	let demoProc = Bun.spawn(
		["bun", join(bin, "fleet-board.ts"), "--demo", "--port", String(DEMO_PORT)],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	setDemoProc(demoProc);

	test("seeds sessions, claim labels, 4 mixed items, 2 OPEN + 2 ANSWERED forks, a dozen events", async () => {
		await waitUp(DEMO_BASE);
		const feed = await (await fetch(`${DEMO_BASE}/api/tasks`)).json();
		expect(feed.projects).toContain(demoProj);
		const dt = feed.tasks.filter((t: Row) => t.project === demoProj);
		expect(dt.length).toBe(4);
		expect(new Set(dt.map((t: Row) => t.state))).toEqual(
			new Set(["READY", "CLAIMED", "BLOCKED", "DONE"]),
		);
		const claimed = dt.find((t: Row) => t.state === "CLAIMED");
		expect(claimed.owner_label).toBe("backend lane"); // claim intent, not the sid
		const dec = await (await fetch(`${DEMO_BASE}/api/decisions`)).json();
		const demoOpen = dec.decisions.filter((d: Row) => d.project === demoProj);
		expect(demoOpen.length).toBe(2);
		expect(
			demoOpen.every(
				(d: Row) => d.state === "OPEN" && d.delivery === "DELIVERED",
			),
		).toBe(true);
		const hist = await (
			await fetch(`${DEMO_BASE}/api/decisions?history=1`)
		).json();
		const demoAns = hist.decisions.filter(
			(d: Row) => d.project === demoProj && d.state === "ANSWERED",
		);
		expect(demoAns.length).toBe(2);
		for (const d of demoAns) {
			expect(d.answer_note).toBeTruthy();
			expect(d.answered_ts).toBeGreaterThan(0);
		}
		// the waiting lane's drawer: claimed item carries events + both forks
		const detail = await (
			await fetch(
				`${DEMO_BASE}/api/task?project=${q(demoProj)}&id=${claimed.id}`,
			)
		).json();
		expect(detail.task.open_decisions).toBe(1);
		expect(detail.events.length).toBeGreaterThanOrEqual(4);
		expect(detail.decisions.some((d: Row) => d.state === "OPEN")).toBe(true);
		expect(detail.decisions.some((d: Row) => d.state === "ANSWERED")).toBe(
			true,
		);
		// the bus: a dozen events, all demo-stamped, never a real project
		const act = await (
			await fetch(`${DEMO_BASE}/api/activity?project=${q(demoProj)}`)
		).json();
		expect(act.events.length).toBeGreaterThanOrEqual(12);
		for (const e of act.events) expect(e.project).toBe(demoProj);
		// the dead lane surfaces as a zombie chip
		const data = await (await fetch(`${DEMO_BASE}/api/data`)).json();
		expect(
			data.zombies.some(
				(z: Row) => z.item === "W3" && z.label.includes("ZOMBIE"),
			),
		).toBe(true);
	});

	test("re-seed on restart is a no-op — no duplicate partition", async () => {
		demoProc?.kill();
		await demoProc?.exited;
		demoProc = Bun.spawn(
			[
				"bun",
				join(bin, "fleet-board.ts"),
				"--demo",
				"--port",
				String(DEMO_PORT),
			],
			{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
		);
		setDemoProc(demoProc);
		await waitUp(DEMO_BASE);
		const feed = await (await fetch(`${DEMO_BASE}/api/tasks`)).json();
		expect(feed.tasks.filter((t: Row) => t.project === demoProj).length).toBe(
			4,
		);
	});

	test("/api/start refuses to spawn lanes from a demo board", async () => {
		const r = await fetch(`${DEMO_BASE}/api/start`, {
			method: "POST",
			headers: {
				"x-klh-write-token": TOKEN,
				"content-type": "application/json",
			},
			body: JSON.stringify({ project: demoProj, id: "W1" }),
		});
		expect(r.status).toBe(409);
		expect((await r.json()).error).toContain("demo board");
	});

	test("/api/ship refuses to ship from a demo board (W64)", async () => {
		const r = await fetch(`${DEMO_BASE}/api/ship`, {
			method: "POST",
			headers: {
				"x-klh-write-token": TOKEN,
				"content-type": "application/json",
			},
			body: JSON.stringify({ project: demoProj, id: "W1" }),
		});
		expect(r.status).toBe(409);
		expect((await r.json()).error).toContain("demo board");
	});
});
