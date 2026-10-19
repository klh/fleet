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
