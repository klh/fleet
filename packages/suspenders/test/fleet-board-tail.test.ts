// fleet-board-tail.test.ts — W417.6: the kanban lane-card tail across
// executor classes, end to end (HTTP /api/data against a real board on a
// scratch HOME). Codex-class lanes have no parseable Claude transcript;
// their card tail falls to the last coord event in the spawn-attached
// subscribe log (~/.claude-insights/coord-subscribe-<sid>.log). Claude-class
// lanes keep their transcript tail — the subscribe line only fills the gap.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";
const { HOME, GREPO, BASE, run } = await boardFixture(0, afterAll);

const subLog = (sid: string) =>
	join(HOME, ".claude-insights", `coord-subscribe-${sid}.log`);

function claimTo(sid: string, id: string): void {
	const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
	db.run("PRAGMA busy_timeout = 4500");
	db.query(
		"INSERT INTO work_items (project, id, title, state, owner_sid, created_by, created_at, updated_at) VALUES (?, ?, ?, 'CLAIMED', ?, 'test', ?, ?)",
	).run(GREPO, id, `tail ${id}`, sid, Date.now(), Date.now());
	db.close();
}

function task(id: string): Promise<Record<string, unknown> | undefined> {
	// the v3 tasks feed (docs/board-api.md); ids here are file-unique, so
	// no project filter — fixture work rows use GREPO, not REPO/MY_PROJ
	return fetch(`${BASE}/api/tasks`)
		.then((r) => r.json())
		.then((d: { tasks: Record<string, unknown>[] }) =>
			d.tasks.find((t) => t.id === id),
		);
}

describe("W417.6 lane-card tail at the subscribe log (cross-executor)", () => {
	test("codex-class lane — no transcript, card tail falls to the subscribe log's last event", async () => {
		const sid = "codex-lane-w4176";
		expect(
			run("coord.ts", ["bootstrap", "--as", sid, "--role", "worker"]).code,
		).toBe(0);
		claimTo(sid, "WT417A");
		mkdirSync(join(HOME, ".claude-insights"), { recursive: true });
		// formatEventLine output as a non-TTY subscribe appends it — plain
		// text, one event per line, oldest first, no trailing newline yet
		await Bun.write(
			subLog(sid),
			[
				"  #4584 autow417 broadcast suspenders — earlier event, not the tail",
				"  #4585 autow417 work.landed suspenders @abc12345 — Merge branch 'suspenders/W417.2'",
			].join("\n"),
		);
		const t = await task("WT417A");
		expect(t).toBeDefined();
		const tail = t.tail as { text: string; ts: string | null };
		expect(tail.text).toContain("work.landed");
		expect(tail.text).toContain("W417.2");
		expect(tail.text).not.toContain("earlier event");
		expect(typeof tail.ts).toBe("string");
	});

	test("subscribe line is ANSI-stripped and TAIL_MAX-capped", async () => {
		const sid = "ansi-lane-w4176";
		expect(
			run("coord.ts", ["bootstrap", "--as", sid, "--role", "worker"]).code,
		).toBe(0);
		claimTo(sid, "WT417B");
		mkdirSync(join(HOME, ".claude-insights"), { recursive: true });
		const longNote = `— ${"note ".repeat(40)}`.trimEnd();
		await Bun.write(
			subLog(sid),
			`  #9 srcid NEED_DECISION \u001b[2m#9\u001b[0m ${longNote}\n`,
		);
		const t = await task("WT417B");
		const tail = t.tail as { text: string };
		expect(tail.text).not.toContain("\u001b");
		expect(tail.text.length).toBeLessThanOrEqual(110);
		expect(tail.text).toContain("NEED_DECISION");
	});

	test("claude-class lane — transcript tail wins, subscribe log only fills the gap", async () => {
		const sid = "claude-lane-w4176";
		expect(
			run("coord.ts", ["bootstrap", "--as", sid, "--role", "worker"]).code,
		).toBe(0);
		claimTo(sid, "WT417C");
		mkdirSync(join(HOME, ".claude-insights"), { recursive: true });
		await Bun.write(subLog(sid), "  #1 srcid broadcast — subscribe event\n");
		const tp = join(HOME, "transcript-claude.jsonl");
		await Bun.write(
			tp,
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "milling the deck plates" }],
				},
			})}\n`,
		);
		const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
		db.run("PRAGMA busy_timeout = 4500");
		db.query("UPDATE sessions SET transcript_path = ? WHERE sid = ?").run(
			tp,
			sid,
		);
		db.close();
		const t = await task("WT417C");
		const tail = t.tail as { text: string };
		expect(tail.text).toBe("milling the deck plates");
		expect(tail.text).not.toContain("subscribe event");
	});

	test("neither surface — claimed lane's tail stays null", async () => {
		const sid = "silent-lane-w4176";
		expect(
			run("coord.ts", ["bootstrap", "--as", sid, "--role", "worker"]).code,
		).toBe(0);
		claimTo(sid, "WT417D");
		const t = await task("WT417D");
		expect(t).toBeDefined();
		expect(t.tail).toBeNull();
	});
});
