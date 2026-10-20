import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "suspenders-w957-messages-"));
const root = join(import.meta.dir, "..", "hooks");
const bus = join(root, "coord", "bus.ts");
const inbox = join(root, "lib", "lane-inbox.ts");
const boundary = join(root, "lib", "turn-boundary.ts");
const govdb = join(root, "lib", "govdb.ts");
const coord = join(root, "bin", "coord.ts");
const sid = "w957-interactive-session";

afterAll(() => rmSync(home, { recursive: true, force: true }));

function run(args: string[]): string {
	const p = Bun.spawnSync(["bun", ...args], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
	return new TextDecoder().decode(p.stdout);
}

function state(): {
	state: string;
	seen_at: number | null;
	accepted_at: number | null;
	pending: number[];
} {
	return JSON.parse(
		run([
			"-e",
			`
const { openGovernorDb } = await import(${JSON.stringify(govdb)});
const { pendingTurnMessages } = await import(${JSON.stringify(boundary)});
const db = openGovernorDb();
const row = db.query("SELECT state, seen_at, accepted_at FROM direct_message_receipts WHERE sid = ?").get(${JSON.stringify(sid)});
console.log(JSON.stringify({ ...row, pending: pendingTurnMessages(db, ${JSON.stringify(sid)}).map((m) => m.id) }));
`,
		]),
	) as {
		state: string;
		seen_at: number | null;
		accepted_at: number | null;
		pending: number[];
	};
}

test("a hook display is SEEN, and only explicit inbox ack accepts the direct note", () => {
	run([
		"-e",
		`
const { emitEvent } = await import(${JSON.stringify(bus)});
emitEvent({ kind: "NOTE", source: "owner", to: ${JSON.stringify(sid)}, note: "finish ingestion" });
`,
	]);
	expect(state().state).toBe("QUEUED");
	const shown = run([
		"-e",
		`
const { drainLaneInboxFor } = await import(${JSON.stringify(inbox)});
console.log(drainLaneInboxFor(${JSON.stringify(sid)}));
`,
	]);
	expect(shown).toContain("finish ingestion");
	const seen = state();
	expect(seen.state).toBe("SEEN");
	expect(seen.seen_at).toBeGreaterThan(0);
	expect(seen.pending).toHaveLength(1);
	const unread = run([coord, "inbox", "--as", sid]);
	expect(unread).toContain("finish ingestion");
	expect(state().state).toBe("SEEN");
	const acknowledged = run([coord, "inbox", "--as", sid, "--ack"]);
	expect(acknowledged).toContain("finish ingestion");
	const accepted = state();
	expect(accepted.state).toBe("ACCEPTED");
	expect(accepted.accepted_at).toBeGreaterThan(0);
	expect(accepted.pending).toHaveLength(0);
});

test("one event can be accepted without accepting another directed event", () => {
	const target = "w1057-selective-session";
	const ids = JSON.parse(
		run([
			"-e",
			`
const { emitEvent } = await import(${JSON.stringify(bus)});
const { openGovernorDb } = await import(${JSON.stringify(govdb)});
const first = emitEvent({ kind: "NOTE", source: "owner", to: ${JSON.stringify(target)}, note: "first action" });
const second = emitEvent({ kind: "NOTE", source: "owner", to: ${JSON.stringify(target)}, note: "second action" });
console.log(JSON.stringify({ first, second }));
`,
		]),
	) as { first: number; second: number };
	const before = run([coord, "inbox", "--as", target]);
	expect(before).toContain("first action");
	expect(before).toContain("second action");
	expect(run([coord, "ack", String(ids.first), "--as", target])).toContain(
		`#${ids.first}`,
	);
	const after = run([coord, "inbox", "--as", target]);
	expect(after).not.toContain("first action");
	expect(after).toContain("second action");
	const rows = JSON.parse(
		run([
			"-e",
			`
const { openGovernorDb } = await import(${JSON.stringify(govdb)});
const db = openGovernorDb();
console.log(JSON.stringify(db.query("SELECT event_id, state FROM direct_message_receipts WHERE sid = ? AND event_id IN (?, ?) ORDER BY event_id").all(${JSON.stringify(target)}, ${ids.first}, ${ids.second})));
`,
		]),
	) as { event_id: number; state: string }[];
	expect(rows).toEqual([
		{ event_id: ids.first, state: "ACCEPTED" },
		{ event_id: ids.second, state: "SEEN" },
	]);
});

test("an accepted event is not reintroduced by the hook inbox", () => {
	const target = "w1057-accepted-hook-session";
	const id = Number(
		run([
			"-e",
			`const { emitEvent } = await import(${JSON.stringify(bus)});
console.log(emitEvent({ kind: "NOTE", source: "owner", to: ${JSON.stringify(target)}, note: "already handled" }));`,
		]).trim(),
	);
	run([coord, "inbox", "--as", target]);
	run([coord, "ack", String(id), "--as", target]);
	const drained = run([
		"-e",
		`const { drainLaneInboxFor } = await import(${JSON.stringify(inbox)});
console.log(drainLaneInboxFor(${JSON.stringify(target)}));`,
	]);
	expect(drained).toBe("null\n");
});

test("all directed consult inserts create receipts at the shared event boundary", () => {
	const target = "w1057-raw-consult-session";
	const receipt = JSON.parse(
		run([
			"-e",
			`const { openGovernorDb } = await import(${JSON.stringify(govdb)});
const db = openGovernorDb();
const inserted = db.query("INSERT INTO events (ts, source, kind, payload, target) VALUES (?, ?, ?, ?, ?)").run(Date.now(), "relay", "consult.answer", "{}", ${JSON.stringify(target)});
console.log(JSON.stringify(db.query("SELECT sid, state FROM direct_message_receipts WHERE event_id = ?").get(Number(inserted.lastInsertRowid))));`,
		]),
	) as { sid: string; state: string };
	expect(receipt).toEqual({ sid: target, state: "QUEUED" });
});

test("bulk inbox acknowledgment accepts only the displayed snapshot", () => {
	const target = "w1057-race-session";
	const states = JSON.parse(
		run([
			"-e",
			`const { setRest } = await import(${JSON.stringify(join(root, "coord", "shared.ts"))});
setRest(["--as", ${JSON.stringify(target)}, "--ack"]);
const { emitEvent, cmdInbox } = await import(${JSON.stringify(bus)});
const { openGovernorDb } = await import(${JSON.stringify(govdb)});
const first = emitEvent({ kind: "NOTE", source: "owner", to: ${JSON.stringify(target)}, note: "displayed" });
let second = 0;
const original = console.log;
console.log = (...args) => {
  if (!second && String(args[0]).includes("displayed")) second = emitEvent({ kind: "NOTE", source: "owner", to: ${JSON.stringify(target)}, note: "arrived during display" });
};
await cmdInbox(["--ack"]);
console.log = original;
const db = openGovernorDb();
console.log(JSON.stringify(db.query("SELECT event_id, state FROM direct_message_receipts WHERE event_id IN (?, ?) ORDER BY event_id").all(first, second)));`,
		]),
	) as { event_id: number; state: string }[];
	expect(states.map((r) => r.state)).toEqual(["ACCEPTED", "QUEUED"]);
});
