import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBoard, type Board } from "./harness";

let board: Board;
let worker: ReturnType<typeof Bun.spawn>;
const sid = "paused-fixture-worker";
const item = "WPAUSE.1";

test.beforeAll(async () => {
	board = await startBoard("paused-lanes");
	const now = Date.now();
	const runtime = join(board.HOME, "claude-runtime.ts");
	writeFileSync(runtime, "setInterval(() => {}, 1000);\n");
	worker = Bun.spawn([process.execPath, runtime, sid], {
		stdout: "ignore",
		stderr: "ignore",
	});
	mkdirSync(join(board.MY_PROJ, ".fleet"), { recursive: true });
	writeFileSync(
		join(board.MY_PROJ, ".fleet", "lanes.json"),
		JSON.stringify([{ sid, item, pid: worker.pid, launchedAt: now - 1000 }]),
	);
	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	for (const [id, state, owner] of [
		["WPAUSE", "SHATTERED", null],
		[item, "CLAIMED", sid],
	])
		db.query(
			"INSERT INTO work_items(project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
		).run(board.MY_PROJ, id, id, state, owner, now, now);
	db.query(
		"INSERT INTO facts(key,value,source,ts) VALUES (?,'PAUSED','fixture',?)",
	).run(`lane.${sid}.state`, now);
	db.close();
});
test.afterAll(async () => {
	worker?.kill();
	if (worker) await worker.exited;
	await board?.stop();
});

test("paused execution has its own column, navigation and filter without changing its claim", async ({
	page,
}) => {
	await page.goto(`${board.BASE}/#lanes`);
	const paused = page
		.locator(".kcol")
		.filter({ has: page.locator("h3", { hasText: /^paused/ }) });
	const claimed = page
		.locator(".kcol")
		.filter({ has: page.locator("h3", { hasText: /^claimed/ }) });
	await expect(paused.locator(`[data-kid="${item}"]`)).toHaveCount(1);
	await expect(claimed.locator(`[data-kid="${item}"]`)).toHaveCount(0);
	await expect(page.locator(`#kanban [data-kid="${item}"]`)).toHaveCount(1);
	await expect(
		page.locator("#kstatusnav button").filter({ hasText: /^paused 1$/ }),
	).toHaveCount(1);
	await page.goto(`${board.BASE}/#tasks`);
	await page.locator('#taskFocus [data-focus="paused"]').click();
	await expect(page.locator(`#tasksBody [data-tid="${item}"]`)).toHaveCount(1);
	await expect(page.locator('#taskFocus [data-count="paused"]')).toHaveText(
		"1",
	);

	const db = new Database(`${board.HOME}/.cache/claude-governor/governor.db`);
	db.query("UPDATE facts SET value='RUNNING', ts=? WHERE key=?").run(
		Date.now(),
		`lane.${sid}.state`,
	);
	db.close();
	await page.goto(`${board.BASE}/#lanes`);
	await expect(paused.locator(`[data-kid="${item}"]`)).toHaveCount(0);
	// Resuming restores existing family placement; never duplicates the card.
	await expect(page.locator(`#kanban [data-kid="${item}"]`)).toHaveCount(1);
	await expect(
		page.locator("#kstatusnav button").filter({ hasText: /^paused 0$/ }),
	).toBeHidden();
	await expect(paused).toHaveCount(0);
	const payload = await (
		await page.request.get(`${board.BASE}/api/tasks`)
	).json();
	expect(
		payload.tasks.find((t: { id: string }) => t.id === item),
	).toMatchObject({
		state: "CLAIMED",
		owner_sid: sid,
		execution: { state: "live-harness" },
	});
});
