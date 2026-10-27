import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
	laneStopDecision,
	selfLaneStopNotice,
} from "../hooks/lib/lanes/lane-stop-decision.ts";
import { boardFixture } from "./helpers/board-fixture.ts";
const f = await boardFixture(0, test.afterAll);
const db = new Database(`${f.HOME}/.cache/claude-governor/governor.db`);
test.afterAll(() => db.close());
const project = "/projects/lane-stop/.git",
	foreign = "/projects/other/.git";
type Decision = {
	id: number;
	state: string;
	target: string;
	answer_token: string;
	answer_to: string;
};
const note = (item: string) =>
	`${item}: lane_turn_no_output (assistant_missing_output); no completion attempt consumed. Inspect route/stream and transcript delivery.`;
function work(
	item: string,
	p = project,
	state = "CLAIMED",
	owner = "stopped-lane",
) {
	db.query(
		"INSERT INTO work_items (project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
	).run(p, item, item, state, owner, Date.now(), Date.now());
}
const event = (item: string, text = note(item)) =>
	Number(
		db
			.query(
				"INSERT INTO events (ts,source,kind,payload) VALUES (?,'stopped-lane','NEED_DECISION',?)",
			)
			.run(Date.now(), JSON.stringify({ project, item, note: text }))
			.lastInsertRowid,
	);
async function feed(selected = project) {
	const r = await fetch(
		`${f.BASE}/api/decisions?history=1&project=${encodeURIComponent(selected)}`,
	);
	expect(r.ok).toBe(true);
	return (await r.json()).decisions as Decision[];
}
test("canonical publisher reaches owner-actionable board card", async () => {
	expect(
		f.run("coord.ts", [
			"bootstrap",
			"--as",
			"dead-publisher",
			"--role",
			"worker",
		]).code,
	).toBe(0);
	db.query(
		"UPDATE sessions SET state='DONE',hb=0 WHERE sid='dead-publisher'",
	).run();
	const helper = join(
			import.meta.dir,
			"../hooks/lib/lanes/lane-stop-decision.ts",
		),
		bus = join(import.meta.dir, "../hooks/coord/bus.ts");
	const script = `import{laneStopDecision}from ${JSON.stringify(helper)};import{emitEvent}from ${JSON.stringify(bus)};console.log(emitEvent(laneStopDecision(${JSON.stringify(project)},"W6","dead-publisher",${JSON.stringify(note("W6"))})));`;
	const child = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: f.REPO,
		env: f.env,
	});
	expect(child.exitCode).toBe(0);
	const id = Number(child.stdout.toString().trim());
	expect(id).toBeGreaterThan(0);
	expect((await feed()).find((r) => r.id === id)).toMatchObject({
		state: "OPEN",
		target: "dead-publisher",
		task_id: "W6",
		owner_actionable: true,
	});
	const card = (await feed()).find((r) => r.id === id);
	if (!card) throw new Error("published decision missing");
	const answer = await f.post("/api/answer", {
		id,
		to: card.target,
		note: "Inspect the transport before resuming",
		token: card.answer_token,
	});
	expect(answer.status).toBe(200);
	expect(answer.json).toMatchObject({
		ok: true,
		to: "dead-publisher",
		ruling: true,
	});
	expect((await feed()).find((r) => r.id === id)).toMatchObject({
		state: "ANSWERED",
		answer_to: "dead-publisher",
	});
});

test("only structured self operational notices skip turn drain, external and generic messages remain", () => {
	const self = laneStopDecision(project, "W80", "self-lane", note("W80"));
	const payload = JSON.stringify({ ...self.extra, note: self.note });
	expect(
		selfLaneStopNotice({
			kind: self.kind,
			source: self.source,
			target: self.to,
			payload,
		}),
	).toBe(true);
	const insert = (source: string, kind: string, payload: string) =>
		db
			.query(
				"INSERT INTO events (ts,source,target,kind,payload) VALUES (?,?,'self-lane',?,?)",
			)
			.run(Date.now(), source, kind, payload);
	insert("self-lane", self.kind, payload);
	insert("external-lane", self.kind, payload);
	insert("self-lane", "NOTE", JSON.stringify({ note: "Self reminder" }));
	insert(
		"self-lane",
		self.kind,
		JSON.stringify({ project, item: "W80", work: "W80", note: note("W80") }),
	);
	const module = join(import.meta.dir, "../hooks/lib/turn-boundary.ts");
	const script = `import{pendingTurnMessages}from ${JSON.stringify(module)};import{Database}from "bun:sqlite";const db=new Database(${JSON.stringify(`${f.HOME}/.cache/claude-governor/governor.db`)});console.log(JSON.stringify(pendingTurnMessages(db,"self-lane").map(row=>row.source)));db.close();`;
	const result = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: f.REPO,
		env: f.env,
	});
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString())).toEqual([
		"external-lane",
		"self-lane",
		"self-lane",
	]);
});

test("actual work done context refusal reaches board, retries dedupe, retakes create a fresh incident", async () => {
	const env = { ...f.env, KLH_CLAIM_TOKEN: undefined };
	const cmd = (args: string[]) =>
		Bun.spawnSync(args, { cwd: f.GREPO, env, stdout: "pipe", stderr: "pipe" });
	for (const args of [
		["init", "-q"],
		["config", "user.name", "Fixture"],
		["config", "user.email", "fixture@example.invalid"],
	])
		expect(cmd(["git", ...args]).exitCode).toBe(0);
	writeFileSync(join(f.GREPO, "README.md"), "Fixture baseline\n");
	expect(cmd(["git", "add", "README.md"]).exitCode).toBe(0);
	expect(cmd(["git", "commit", "-qm", "Fixture baseline"]).exitCode).toBe(0);
	const baseline = cmd(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
	const cli = (...args: string[]) =>
		cmd([process.execPath, join(f.bin, "work.ts"), ...args]);
	const added = cli("add", "Completion context fixture");
	expect(added.exitCode).toBe(0);
	const item = added.stdout.toString().match(/W\d+/)?.[0];
	if (!item) throw new Error("missing fixture item");
	expect(cli("take", item, "--as", "completion-fixture").exitCode).toBe(0);
	const row = JSON.parse(cli("show", item, "--json").stdout.toString());
	mkdirSync(join(f.GREPO, ".fleet"), { recursive: true });
	writeFileSync(
		join(f.GREPO, ".fleet/lane-context.json"),
		JSON.stringify({ item, sid: "previous-owner", baseline: "fixture" }),
	);
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = cli("done", item, "--as", "completion-fixture");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"Lane completion context does not match",
		);
	}
	const ids = () =>
		db
			.query(
				"SELECT id FROM events WHERE kind='NEED_DECISION' AND json_extract(payload,'$.project')=? AND json_extract(payload,'$.item')=?",
			)
			.all(row.project, item) as { id: number }[];
	expect(ids()).toHaveLength(1);
	expect(
		(await feed(row.project)).find((card) => card.id === ids()[0]?.id),
	).toMatchObject({
		state: "OPEN",
		target: "completion-fixture",
		task_id: item,
	});
	expect(cli("release", item, "--as", "completion-fixture").exitCode).toBe(0);
	const retake = cli("take", item, "--as", "completion-fixture");
	expect(retake.exitCode).toBe(0);
	expect(
		(await feed(row.project)).find((card) => card.id === ids()[0]?.id),
	).toMatchObject({ state: "CANCELLED" });
	expect(cli("done", item, "--as", "completion-fixture").exitCode).not.toBe(0);
	expect(ids()).toHaveLength(2);
	expect(
		(await feed(row.project)).find((card) => card.id === ids()[1]?.id),
	).toMatchObject({ state: "OPEN" });
	work(item, foreign, "DONE");
	expect(
		(await feed(row.project)).find((card) => card.id === ids()[1]?.id),
	).toMatchObject({ state: "OPEN" });
	writeFileSync(join(f.GREPO, ".fleet/lane-context.json"), "{");
	expect(cli("done", item, "--as", "completion-fixture").exitCode).not.toBe(0);
	expect(ids()).toHaveLength(2);
	const token = /claim token: ([0-9a-f]{48})/.exec(
		retake.stdout.toString(),
	)?.[1];
	if (!token) throw new Error("missing retake claim token");
	writeFileSync(
		join(f.GREPO, ".fleet/lane-context.json"),
		JSON.stringify({
			sid: "completion-fixture",
			item,
			baseline,
			claimToken: token,
		}),
	);
	writeFileSync(
		join(f.GREPO, "implemented.ts"),
		"export const fixtureResult = () => 42;\n",
	);
	expect(cmd(["git", "add", "implemented.ts"]).exitCode).toBe(0);
	expect(
		cmd(["git", "commit", "-qm", "Implement fixture result"]).exitCode,
	).toBe(0);
	const sha = cmd(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
	const done = cli(
		"done",
		item,
		"--as",
		"completion-fixture",
		"--sha",
		sha,
		"--summary",
		"Implemented the fixture result function and verified the bound claim completion evidence.",
	);
	expect(done.exitCode).toBe(0);
	expect(
		(await feed(row.project))
			.filter((card) => ids().some((event) => event.id === card.id))
			.map((card) => card.state),
	).toEqual(["CANCELLED", "CANCELLED"]);
	const open = await fetch(
		`${f.BASE}/api/decisions?project=${encodeURIComponent(row.project)}`,
	).then((response) => response.json());
	expect(open).toMatchObject({ count: 0, decisions: [] });
});

test("retakes retire typed legacy incidents only in their project and preserve generic questions", async () => {
	for (const item of ["W41", "W42", "W43"]) work(item);
	const generic = Number(
		db
			.query(
				"INSERT INTO events (ts,source,target,kind,payload) VALUES (?,'stopped-lane','stopped-lane','NEED_DECISION',?)",
			)
			.run(
				Date.now(),
				JSON.stringify({
					project,
					work: "W41",
					note: "Should the new policy be approved?",
				}),
			).lastInsertRowid,
	);
	const foreignIncident = event("W42"),
		legacy = event("W43");
	await feed();
	const claim = (p: string, item: string) =>
		db
			.query(
				"INSERT INTO events (ts,source,kind,payload) VALUES (?,'stopped-lane','work.claimed',?)",
			)
			.run(
				Date.now(),
				JSON.stringify({ project: p, work: item, by: "stopped-lane" }),
			);
	claim(project, "W41");
	claim(foreign, "W42");
	claim(project, "W43");
	const latest = event("W43");
	const rows = await feed();
	for (const id of [generic, foreignIncident, latest])
		expect(rows.find((card) => card.id === id)).toMatchObject({
			state: "OPEN",
		});
	expect(rows.find((card) => card.id === legacy)).toMatchObject({
		state: "CANCELLED",
	});
});
test("only latest active owned typed legacy incident backfills once, without emitting", async () => {
	for (const item of ["W7", "W8", "W9"]) work(item);
	const prior = event("W7"),
		id = event("W7"),
		generic = event("W8", "untargeted broadcast"),
		malformed = event("W9", note("W10"));
	work("W10", project, "DONE");
	const historical = event("W10");
	work("W11", project, "CLAIMED", "new-owner");
	const retaken = event("W11");
	work("W12");
	const previousActivation = event("W12");
	db.query(
		"INSERT INTO events (ts,source,kind,payload) VALUES (?,'stopped-lane','work.claimed',?)",
	).run(
		Date.now(),
		JSON.stringify({ project, work: "W12", by: "stopped-lane" }),
	);
	const before = db.query("SELECT COUNT(*) AS n FROM events").get(),
		rows = await feed();
	expect(rows.find((r) => r.id === id)).toMatchObject({
		state: "OPEN",
		target: "stopped-lane",
		task_id: "W7",
		owner_actionable: true,
	});
	expect(
		rows.some((r) =>
			[
				prior,
				generic,
				malformed,
				historical,
				retaken,
				previousActivation,
			].includes(r.id),
		),
	).toBe(false);
	expect((await feed()).filter((r) => r.id === id)).toHaveLength(1);
	expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(before);
});
test("cancellation and DONE join project plus work identity", async () => {
	for (const item of ["W31", "W32"]) {
		work(item);
		work(item, foreign, "DONE");
	}
	const cancel = (p: string) =>
		db
			.query(
				"INSERT INTO events (ts,source,kind,project,work,payload) VALUES (?,'test','work.cancelled',?,'W32',?)",
			)
			.run(Date.now(), p, JSON.stringify({ project: p, work: "W32" }));
	cancel(foreign);
	const a = event("W31"),
		b = event("W32");
	expect(
		(await feed()).filter((r) => [a, b].includes(r.id)).map((r) => r.state),
	).toEqual(["OPEN", "OPEN"]);
	db.query(
		"UPDATE work_items SET state='DONE' WHERE project=? AND id='W31'",
	).run(project);
	cancel(project);
	expect(
		(await feed()).filter((r) => [a, b].includes(r.id)).map((r) => r.state),
	).toEqual(["CANCELLED", "CANCELLED"]);
});
