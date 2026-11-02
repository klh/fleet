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
	runCli(["emit", "NOTE", "--to", "w2580-seen-json", "--note", "json face"]);
	runCli(["emit", "NOTE", "--to", "w2580-seen-tty", "--note", "tty face"]);
	const j = runCli(["inbox", "--as", "w2580-seen-json", "--json"]);
	expect(j.code).toBe(0);
	const envelope = JSON.parse(j.out) as { shown: number; verb: string };
	expect(envelope).toMatchObject({ verb: "inbox", shown: 1 });
	const t = runCli(["inbox", "--as", "w2580-seen-tty"]);
	expect(t.code).toBe(0);
	expect(t.out).toContain("tty face");
	expect(
		sql<{ sid: string; state: string }>(
			"SELECT sid, state FROM direct_message_receipts WHERE sid IN ('w2580-seen-json', 'w2580-seen-tty') ORDER BY sid",
		),
	).toEqual([
		{ sid: "w2580-seen-json", state: "SEEN" },
		{ sid: "w2580-seen-tty", state: "SEEN" },
	]);
	// the cursor moves only with --ack — on BOTH faces
	expect(
		sql("SELECT sid FROM cursors WHERE sid IN ('w2580-seen-json', 'w2580-seen-tty')"),
	).toEqual([]);
});

test("ack parity: --ack --json and --ack both ACCEPT the receipts and advance the cursor to max shown", () => {
	// own fixtures: independent of the display test (selection/retries)
	runCli(["emit", "NOTE", "--to", "w2580-ack-json", "--note", "ack json"]);
	runCli(["emit", "NOTE", "--to", "w2580-ack-tty", "--note", "ack tty"]);
	const ids = Object.fromEntries(
		sql<{ target: string; id: number }>(
			"SELECT target, id FROM events WHERE target IN ('w2580-ack-json', 'w2580-ack-tty') ORDER BY target",
		).map((r) => [r.target, r.id]),
	);
	const j = runCli(["inbox", "--as", "w2580-ack-json", "--ack", "--json"]);
	expect(j.code).toBe(0);
	expect((JSON.parse(j.out) as { shown: number }).shown).toBe(1);
	const t = runCli(["inbox", "--as", "w2580-ack-tty", "--ack"]);
	expect(t.code).toBe(0);
	expect(t.out).toContain("ack tty");
	expect(
		sql<{ sid: string; state: string }>(
			"SELECT sid, state FROM direct_message_receipts WHERE sid IN ('w2580-ack-json', 'w2580-ack-tty') ORDER BY sid",
		),
	).toEqual([
		{ sid: "w2580-ack-json", state: "ACCEPTED" },
		{ sid: "w2580-ack-tty", state: "ACCEPTED" },
	]);
	expect(
		sql<{ sid: string; event_id: number }>(
			"SELECT sid, event_id FROM cursors WHERE sid IN ('w2580-ack-json', 'w2580-ack-tty') ORDER BY sid",
		),
	).toEqual([
		{ sid: "w2580-ack-json", event_id: ids["w2580-ack-json"] },
		{ sid: "w2580-ack-tty", event_id: ids["w2580-ack-tty"] },
	]);
	// both faces drained: JSON reports zero, tty prints the empty marker
	const drained = runCli(["inbox", "--as", "w2580-ack-json", "--json"]);
	expect(drained.code).toBe(0);
	expect((JSON.parse(drained.out) as { shown: number }).shown).toBe(0);
	const drainedTty = runCli(["inbox", "--as", "w2580-ack-tty"]);
	expect(drainedTty.code).toBe(0);
	expect(drainedTty.out).toContain("(inbox empty)");
});

});
