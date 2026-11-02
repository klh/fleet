// inbox-json-parity.e2e.ts — W2580 (review #103237 B1): coord inbox's two
// faces share ONE side-effect contract. The JSON envelope is a RENDER, not a
// pure read: a display marks shown receipts QUEUED -> SEEN and advances the
// cursor ONLY with --ack — identical to the tty face. Asserted on receipt
// rows + cursor state behind the CLI, not just the envelope.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";
test.describe("@unit", () => {

const fx = cliFixture("w2580-parity");

test.afterAll(() => fx.cleanup());

const runCli = (args: string[]): { code: number; out: string; err: string } =>
	fx.run("coord.ts", args);

const sql = <T>(statement: string): T[] =>
	JSON.parse(
		fx.seed(`
const { openGovernorDb } = await import(${JSON.stringify(
		join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts"),
	)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(
		statement,
	)}).all()));
`),
	) as T[];

test("display parity: --json and tty both mark receipts SEEN, neither advances the cursor", () => {
	runCli(["emit", "NOTE", "--to", "w2580-json", "--note", "json face"]);
	runCli(["emit", "NOTE", "--to", "w2580-tty", "--note", "tty face"]);
	const j = runCli(["inbox", "--as", "w2580-json", "--json"]);
	expect(j.code).toBe(0);
	const envelope = JSON.parse(j.out) as { shown: number; verb: string };
	expect(envelope).toMatchObject({ verb: "inbox", shown: 1 });
	const t = runCli(["inbox", "--as", "w2580-tty"]);
	expect(t.out).toContain("tty face");
	expect(
		sql<{ sid: string; state: string }>(
			"SELECT sid, state FROM direct_message_receipts WHERE sid IN ('w2580-json', 'w2580-tty') ORDER BY sid",
		),
	).toEqual([
		{ sid: "w2580-json", state: "SEEN" },
		{ sid: "w2580-tty", state: "SEEN" },
	]);
	// the cursor moves only with --ack — on BOTH faces
	expect(
		sql("SELECT sid FROM cursors WHERE sid IN ('w2580-json', 'w2580-tty')"),
	).toEqual([]);
});

test("ack parity: --ack --json and --ack both ACCEPT the receipts and advance the cursor to max shown", () => {
	const ids = Object.fromEntries(
		sql<{ target: string; id: number }>(
			"SELECT target, id FROM events WHERE target IN ('w2580-json', 'w2580-tty') ORDER BY target",
		).map((r) => [r.target, r.id]),
	);
	const j = runCli(["inbox", "--as", "w2580-json", "--ack", "--json"]);
	expect((JSON.parse(j.out) as { shown: number }).shown).toBe(1);
	const t = runCli(["inbox", "--as", "w2580-tty", "--ack"]);
	expect(t.out).toContain("tty face");
	expect(
		sql<{ sid: string; state: string }>(
			"SELECT sid, state FROM direct_message_receipts WHERE sid IN ('w2580-json', 'w2580-tty') ORDER BY sid",
		),
	).toEqual([
		{ sid: "w2580-json", state: "ACCEPTED" },
		{ sid: "w2580-tty", state: "ACCEPTED" },
	]);
	expect(
		sql<{ sid: string; event_id: number }>(
			"SELECT sid, event_id FROM cursors WHERE sid IN ('w2580-json', 'w2580-tty') ORDER BY sid",
		),
	).toEqual([
		{ sid: "w2580-json", event_id: ids["w2580-json"] },
		{ sid: "w2580-tty", event_id: ids["w2580-tty"] },
	]);
	// both faces drained: JSON reports zero, tty prints the empty marker
	expect(
		(JSON.parse(
			runCli(["inbox", "--as", "w2580-json", "--json"]).out,
		) as { shown: number }).shown,
	).toBe(0);
	expect(runCli(["inbox", "--as", "w2580-tty"]).out).toContain(
		"(inbox empty)",
	);
});

});
