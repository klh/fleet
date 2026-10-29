// e2e/board-scratch-leak.spec.ts — W9201: a reaped scratch/test project
// (repo deleted from disk, no origin) never surfaces in the live Board —
// hidden from the aggregate /api/tasks feed, the project list, the kanban
// projection and the state counts — while the board's own scratch project
// stays visible and an explicit ?project= opt-in still serves the ghost
// (deep-link honesty). The ghost rows ride the exact W1762-rejudge leak
// shape: a second sqlite connection banks work_items into the board's
// governor.db under a project path that is rm -rf'd after seeding.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type Board, startBoard } from "../test/helpers/board-harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;
let ghost = "";
let liveProject = "";
const now = Date.now();

function needBoard(): Board {
	if (!board) throw new Error("scratch-leak board not started");
	return board;
}

test.beforeAll(async () => {
	board = await startBoard("scratch-leak");
	const b = board;
	b.workOk(["add", "w9201 visible legit item"], "add");
	// the minted item's stored project (the repo's git common dir), read
	// back from the same store the board serves
	const feed = (await (await fetch(`${b.BASE}/api/tasks`)).json()) as {
		tasks: Array<{ project: string; title: string }>;
	};
	liveProject =
		feed.tasks.find((t) => t.title.includes("w9201 visible legit item"))
			?.project ?? "";

	// the leak shape: rows in the board's store under a to-be-reaped repo —
	// a second sqlite connection, exactly how the old in-process HOME-swap
	// fixtures banked scratch rows into the shared store
	const ghostRepo = join(b.HOME, "ghost-repo");
	mkdirSync(ghostRepo, { recursive: true });
	ghost = ghostRepo;
	const gdb = new Database(`${b.HOME}/.cache/claude-governor/governor.db`);
	for (const [id, state] of [
		["W9201", "READY"],
		["W9201b", "CLAIMED"],
	] as const)
		gdb
			.query(
				"INSERT INTO work_items(project,id,title,state,priority,created_at,updated_at) VALUES(?,?,?,?,0,?,?)",
			)
			.run(ghost, id, `Repair dangling path ${id}`, state, now, now);
	gdb.close();
	rmSync(ghostRepo, { recursive: true, force: true });
});

test("aggregate /api/tasks hides the reaped project, keeps the live one", async () => {
	const b = needBoard();
	const res = (await (await fetch(`${b.BASE}/api/tasks`)).json()) as {
		tasks: Array<{ project: string; id: string }>;
	};
	expect(res.tasks.some((t) => t.project === ghost)).toBe(false);
	expect(res.tasks.some((t) => t.project === liveProject)).toBe(true);
});

test("project list and kanban projection exclude the reaped project", async () => {
	const b = needBoard();
	const res = (await (await fetch(`${b.BASE}/api/tasks`)).json()) as {
		projects: string[];
	};
	expect(res.projects).not.toContain(ghost);
	expect(res.projects).toContain(liveProject);

	const kanban = (await (await fetch(`${b.BASE}/api/data`)).json()) as {
		projects: Array<{ project: string }>;
	};
	expect(kanban.projects.some((p) => p.project === ghost)).toBe(false);
});

test("state counts exclude the reaped project", async () => {
	const b = needBoard();
	const res = (await (await fetch(`${b.BASE}/api/work-summary`)).json()) as {
		counts: { ready: number };
	};
	// one visible READY row (the board's own project); the ghost READY row
	// must not inflate the count
	expect(res.counts.ready).toBe(1);
});

test("explicit ?project= opt-in still serves the ghost (deep-link honesty)", async () => {
	const b = needBoard();
	const res = (await (
		await fetch(`${b.BASE}/api/tasks?project=${encodeURIComponent(ghost)}`)
	).json()) as { tasks: Array<{ id: string }> };
	expect(res.tasks.some((t) => t.id === "W9201")).toBe(true);
});

test.afterAll(async () => {
	if (board) await board.stop();
});
