import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

const { BASE, HOME, GREPO } = await boardFixture(0, afterAll);
const sid = "shared-coordinator";
const helper = "unbound-helper";
const now = Date.now();
const transcript = join(HOME, "fixture-transcript.jsonl");
const assistant = (text: string, ts: number) =>
	JSON.stringify({
		timestamp: new Date(ts).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
writeFileSync(
	transcript,
	`${assistant("old different-attempt progress", now - 60_000)}\n${JSON.stringify({ timestamp: new Date(now).toISOString(), message: { role: "user", content: "a fresh user record touches the file" } })}\n`,
);
mkdirSync(join(GREPO, ".fleet"), { recursive: true });
writeFileSync(
	join(GREPO, ".fleet", "lanes.json"),
	JSON.stringify([{ sid, item: "WBOUND", launchedAt: now - 1000, attempt: 2 }]),
);
const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
for (const owner of [sid, helper])
	db.query(
		"INSERT INTO sessions(sid,project,role,started_at,hb,transcript_path) VALUES (?,?,'worker',?,?,?)",
	).run(owner, GREPO, now, now, transcript);
for (const [id, owner] of [
	["WOTHER", sid],
	["WBOUND", sid],
	["WHELPER", helper],
])
	db.query(
		"INSERT INTO work_items(project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,?,?,'CLAIMED',?,?,?)",
	).run(GREPO, id, `tail binding ${id}`, owner, now, now);
db.close();
mkdirSync(join(HOME, ".claude-insights"), { recursive: true });
for (const owner of [sid, helper])
	writeFileSync(
		join(HOME, ".claude-insights", `coord-subscribe-${owner}.log`),
		"#57860 installer RELEASE suspenders/OTHER_ITEM\n",
	);

const task = async (id: string) =>
	(
		await (
			await fetch(
				`${BASE}/api/task?project=${encodeURIComponent(GREPO)}&id=${id}`,
			)
		).json()
	).task;
test("actual task API rejects shared owner inbox and old assistant despite fresh transcript mtime", async () => {
	for (const id of ["WOTHER", "WBOUND", "WHELPER"])
		expect((await task(id)).tail).toBeNull();
	const feed = await (await fetch(`${BASE}/api/tasks?done=all`)).json();
	for (const row of feed.tasks.filter(
		(t: { project: string }) => t.project === GREPO,
	))
		expect(row.tail).toBeNull();
	const drawer = await (
		await fetch(
			`${BASE}/api/tail?project=${encodeURIComponent(GREPO)}&id=WOTHER`,
		)
	).json();
	expect(drawer.transcript).toBeNull();
	expect(drawer.recent).toEqual([]);
});
test("current exact item binding retains timestamped assistant text without copying it to sibling claims", async () => {
	appendFileSync(
		transcript,
		`${assistant("current exact item observation", now + 1)}\n`,
	);
	expect((await task("WBOUND")).tail).toMatchObject({
		text: "current exact item observation",
		ts: new Date(now + 1).toISOString(),
	});
	expect((await task("WOTHER")).tail).toBeNull();
	expect((await task("WHELPER")).tail).toBeNull();
	const drawer = await (
		await fetch(
			`${BASE}/api/tail?project=${encodeURIComponent(GREPO)}&id=WBOUND`,
		)
	).json();
	expect(drawer.recent).toHaveLength(1);
	expect(drawer.transcript.text).toBe("current exact item observation");
});

test("a registry match cannot cross a session's canonical project partition", async () => {
	const store = new Database(`${HOME}/.cache/claude-governor/governor.db`);
	store
		.query("UPDATE sessions SET project = ? WHERE sid = ?")
		.run("other-project", sid);
	store.close();
	expect((await task("WBOUND")).tail).toBeNull();
});
