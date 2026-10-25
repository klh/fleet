// coord-paused-target.test.ts — W885: the `paused` receipt targets the
// pausing lane's own sid, never a literal ("coordinator" orphaned the row —
// the store WS filter (store-server.ts: row.target !== f.as) and the inbox
// readEvents directedOnly pass only deliver to real sids). Temp HOME; every
// DB open and CLI run happens in a bun subprocess so the parent test process
// never opens the real governor.db (coord-events.test.ts recipe).
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";
test.describe({ tag: "@unit" }, () => {

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts");
const fx = cliFixture("w885-paused-target");
const SID = "w885-paused-sess-11111111";
const SHA = "a".repeat(40);

test.afterAll(() => fx.cleanup());

const runIn = (code: string): string => fx.seed(code);

const runCli = (args: string[]): { code: number; out: string; err: string } =>
	fx.run("coord.ts", args);

// read rows via a subprocess import — never open the real governor.db here
const sql = <T>(statement: string, ...params: string[]): T[] =>
	JSON.parse(
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(statement)}).all(${params.map((p) => JSON.stringify(p)).join(", ")})));
`),
	);

// seed PAUSE_REQUESTED + the continuation capsule cmdPaused demands, run the
// lane's own `paused` ack through the real CLI, return the emitted row
const pausedAfter = (): {
	code: number;
	out: string;
	err: string;
	row: { kind: string; target: string; payload: string } | undefined;
} => {
	runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const w = (key, value) => db.query("INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'w885-test', 1, ?)").run(key, value, Date.now());
w(${JSON.stringify(`lane.${SID}.state`)}, "PAUSE_REQUESTED");
w(${JSON.stringify(`lane.${SID}.capsule`)}, JSON.stringify({ checkpoint: ${JSON.stringify(SHA)}, done: "seeded", next: "resume" }));
db.close();
`);
	const p = runCli(["paused", "--as", SID, "--sha", SHA]);
	const rows = sql<{
		kind: string;
		target: string;
		payload: string;
	}>("SELECT kind, target, payload FROM events WHERE kind = 'paused'");
	return { code: p.code, out: p.out, err: p.err, row: rows.at(-1) };
};

test.describe("coord paused — directed receipt (W885)", () => {
	test("paused event targets the lane's own sid", () => {
		const r = pausedAfter();
		expect(r.err === "" ? r.code : `${r.code}: ${r.err}`).toBe(0);
		expect(r.out).toContain("PAUSED");
		expect(r.row).toBeDefined();
		expect(r.row?.target).toBe(SID);
		const payload = JSON.parse(r.row?.payload ?? "{}") as { sha?: string };
		expect(payload.sha).toBe(SHA);
	});

	test("lane state fact converges to PAUSED", () => {
		const rows = sql<{ value: string }>(
			"SELECT value FROM facts WHERE key = ?",
			`lane.${SID}.state`,
		);
		expect(rows.at(-1)?.value).toBe("PAUSED");
	});
});

});
