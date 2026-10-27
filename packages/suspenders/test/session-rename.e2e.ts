// test/session-rename.test.ts — W930: the shared rename surface. `coord
// rename` stamps sessions.tags `name` (the W293 key all @name resolution
// reads), duplicate live same-project names refuse without --force, and the
// shared stop gate syncs a native CLI /rename (claude-code custom-title
// JSONL line — verified live 2026-10-19) through the same core. Temp HOME +
// temp git repo; every CLI/gate run in a bun subprocess
// (test/fleet.test.ts recipe).
import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.setTimeout(30_000); // spawn-heavy suite (bun:test 5s default flake floor)

const HOME = mkdtempSync(join(tmpdir(), "suspenders-rename-test-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-rename-test-repo-"));
const PKG = join(import.meta.dir, "..");
const COORD = join(PKG, "hooks", "bin", "coord.ts");
const GATE = join(PKG, "hooks", "gate.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const env = { ...process.env, HOME, NO_COLOR: "1" };

mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO], { stdout: "ignore" });
writeFileSync(join(REPO, "README.md"), "seed\n");
Bun.spawnSync(["git", "-C", REPO, "add", "README.md"], { stdout: "ignore" });
Bun.spawnSync(["git", "-C", REPO, "commit", "-q", "-m", "init"], {
	stdout: "ignore",
});

test.afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

function run(
	args: string[],
	extraEnv: Record<string, string> = {},
	input?: string,
) {
	// Bun's spawnSync drops the `input` option — stdin rides a temp file
	// (the session-bridge payloadFile recipe, gates.test.ts lesson)
	const pf =
		input &&
		join(
			HOME,
			`payload-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
		);
	if (pf) writeFileSync(pf, input);
	const p = Bun.spawnSync(["bun", ...args], {
		cwd: REPO,
		env: { ...env, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
		stdin: pf ? Bun.file(pf) : "ignore",
	});
	if (pf) rmSync(pf, { force: true });
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

const coord = (args: string[], extraEnv?: Record<string, string>) =>
	run([COORD, ...args], extraEnv);

function tagsOf(sid: string): Record<string, unknown> {
	const db = new Database(DB);
	db.run("PRAGMA busy_timeout = 4000");
	const row = db.query("SELECT tags FROM sessions WHERE sid = ?").get(sid) as {
		tags: string | null;
	} | null;
	db.close();
	return row?.tags ? JSON.parse(row.tags) : {};
}

function setRow(sid: string, fields: Record<string, unknown>): void {
	const db = new Database(DB);
	db.run("PRAGMA busy_timeout = 4000");
	const sets = Object.keys(fields)
		.map((k) => `${k} = ?`)
		.join(", ");
	db.query(`UPDATE sessions SET ${sets} WHERE sid = ?`).run(
		...Object.values(fields),
		sid,
	);
	db.close();
}

function lastRenameEvent(sid: string): { name?: string; previous?: string } {
	const db = new Database(DB);
	db.run("PRAGMA busy_timeout = 4000");
	const row = db
		.query(
			"SELECT payload FROM events WHERE kind = 'session.renamed' AND source = ? ORDER BY id DESC LIMIT 1",
		)
		.get(sid) as { payload: string | null } | null;
	db.close();
	return row?.payload ? JSON.parse(row.payload) : {};
}

// claude-code transcripts re-emit custom-title constantly; LAST line wins
function transcript(title: string): string {
	const dir = join(HOME, "tx");
	mkdirSync(dir, { recursive: true });
	const f = join(dir, "tx-claude.jsonl");
	writeFileSync(
		f,
		`${JSON.stringify({ type: "assistant", message: { model: "glm" } })}\n${JSON.stringify({ type: "custom-title", customTitle: "stale-earlier-name" })}\n${JSON.stringify({ type: "custom-title", customTitle: title })}\n`,
	);
	return f;
}

const stopPayload = (sid: string, txPath: string): string =>
	JSON.stringify({
		session_id: sid,
		transcript_path: txPath,
		cwd: REPO,
		hook_event_name: "Stop",
	});

function stopGate(payload: string, extraEnv?: Record<string, string>) {
	return run([GATE, "stop"], extraEnv, payload).code;
}

test.describe("coord rename verb (W930)", () => {
	test("bootstrap seeds a name; rename re-stamps it and keeps other keys", () => {
		expect(
			coord([
				"bootstrap",
				"--as",
				"laneA",
				"--name",
				"alpha-one",
				"--tags",
				JSON.stringify({ team: "ikea" }),
			]).code,
		).toBe(0);
		const r = coord(["rename", "--as", "laneA", "alpha-two"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("alpha-two");
		expect(tagsOf("laneA")).toEqual({ team: "ikea", name: "alpha-two" });
		expect(lastRenameEvent("laneA")).toMatchObject({
			name: "alpha-two",
			previous: "alpha-one",
		});
	});

	test("--name flag beats the positional walk; empty name dies at usage", () => {
		expect(coord(["rename", "--as", "laneA", "--name", "flag-wins"]).code).toBe(
			0,
		);
		expect(tagsOf("laneA").name).toBe("flag-wins");
		expect(coord(["rename", "--as", "laneA"]).code).toBe(2);
	});

	test("duplicate live same-project name refuses and names the holder", () => {
		expect(coord(["bootstrap", "--as", "laneB", "--role", "worker"]).code).toBe(
			0,
		);
		// slug-parity collision: "Alpha Two!" vs "flag-wins" — case/punct differ,
		// slug equality is what @name resolution compares
		coord(["rename", "--as", "laneA", "flag wins!"]);
		const r = coord(["rename", "--as", "laneB", "Flag-Wins"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("duplicate name");
		expect(r.err).toContain("laneA");
		expect(tagsOf("laneB").name).toBeUndefined(); // nothing written
	});

	test("--force overrides the duplicate refusal", () => {
		const r = coord(["rename", "--as", "laneB", "--force", "Flag-Wins"]);
		expect(r.code).toBe(0);
		expect(tagsOf("laneB").name).toBe("Flag-Wins");
	});

	test("no session and closed session refuse", () => {
		expect(coord(["rename", "--as", "ghost9", "whomever"]).code).toBe(2);
		expect(coord(["rename", "--as", "ghost9", "whomever"]).err).toContain(
			"no session",
		);
		setRow("laneB", { state: "CLOSED" });
		const r = coord(["rename", "--as", "laneB", "post-close"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("not RUNNING");
	});
});

test.describe("stop-gate native-rename sync (W930)", () => {
	test("native custom-title lands in sessions.tags through the shared gate", () => {
		expect(coord(["bootstrap", "--as", "laneT"]).code).toBe(0);
		const tx = transcript("native-title-wins");
		// run the REAL gate.ts stop with the claude payload — end-to-end
		expect(stopGate(stopPayload("laneT", tx))).toBe(0);
		expect(tagsOf("laneT").name).toBe("native-title-wins");
	});

	test("sync is idempotent and SUSPENDERS_RENAME_SYNC=0 disables it", () => {
		const tx = transcript("native-title-wins");
		// second run: tags already match — still exit 0
		expect(stopGate(stopPayload("laneT", tx))).toBe(0);
		expect(tagsOf("laneT").name).toBe("native-title-wins");
		// knob off: a changed native title does NOT land
		const tx2 = transcript("never-synced");
		expect(
			stopGate(stopPayload("laneT", tx2), { SUSPENDERS_RENAME_SYNC: "0" }),
		).toBe(0);
		expect(tagsOf("laneT").name).toBe("native-title-wins");
		// knob on again: the change lands
		expect(stopGate(stopPayload("laneT", tx2))).toBe(0);
		expect(tagsOf("laneT").name).toBe("never-synced");
	});

	test("duplicate name: the gate sync skips, never steals", () => {
		expect(coord(["bootstrap", "--as", "laneS", "--name", "clash"]).code).toBe(
			0,
		);
		expect(coord(["bootstrap", "--as", "laneU"]).code).toBe(0);
		const tx = transcript("Clash");
		expect(stopGate(stopPayload("laneU", tx))).toBe(0);
		expect(tagsOf("laneU").name).toBeUndefined(); // skipped — holder live
		// the holder dying frees the name: CLOSED holder → the sync lands
		setRow("laneS", { state: "CLOSED" });
		expect(stopGate(stopPayload("laneU", tx))).toBe(0);
		expect(tagsOf("laneU").name).toBe("Clash");
	});
});
