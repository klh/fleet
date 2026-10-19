// test/session-rename.test.ts — W930: the shared rename surface. `coord
// rename` stamps sessions.tags `name` (the W293 key all @name resolution
// reads), duplicate live same-project names refuse without --force, and the
// shared stop gate syncs a native CLI /rename (claude-code custom-title
// JSONL line — verified live 2026-10-19) through the same core. Temp HOME +
// temp git repo; every CLI/gate run in a bun subprocess
// (test/fleet.test.ts recipe).
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000); // spawn-heavy suite (bun:test 5s default flake floor)

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

afterAll(() => {
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

// ─── W954: bootstrap + subscribe-face rename sync ─────────────────────────
// The stop gate was the only sync face; an idle renamed session stayed
// UUID-labelled until its first turn ended (fleet-knowledge #47607).
const BOOT = join(PKG, "hooks", "session-start.ts");
const bootEnv: Record<string, string | undefined> = {
	...process.env,
	HOME,
	NO_COLOR: "1",
	SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
	SUSPENDERS_BELT_ENV: join(HOME, "absent-belt.env"),
};
delete bootEnv.SUSPENDERS_SID;
delete bootEnv.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;

describe("W954 session-start bootstrap sync", () => {
	test("native title lands at bootstrap; coord targets resolves it", () => {
		const sid = `w954boot-${Date.now()}`;
		const tx = transcript("idle-renamed");
		const payload = join(
			HOME,
			`boot-${Math.random().toString(36).slice(2)}.json`,
		);
		writeFileSync(
			payload,
			JSON.stringify({
				session_id: sid,
				source: "startup",
				transcript_path: tx,
				cwd: REPO,
			}),
		);
		const p = Bun.spawnSync(["bun", BOOT], {
			cwd: REPO,
			env: bootEnv as Record<string, string>,
			stdin: Bun.file(payload),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
		expect(tagsOf(sid).name).toBe("idle-renamed");
		const t = coord(["targets", "--filter", "idle-renamed", "--json"]);
		expect(t.code).toBe(0);
		expect(t.out).toContain(sid);
		rmSync(payload, { force: true });
	});
});

describe("coord rename verb (W930)", () => {
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

describe("stop-gate native-rename sync (W930)", () => {
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

describe("W954 subscribe-face sync", () => {
	test("syncNativeRenameBySid syncs from the session row", () => {
		expect(coord(["bootstrap", "--as", "w954sub1"]).code).toBe(0);
		setRow("w954sub1", { transcript_path: transcript("sid-keyed-sync") });
		const script =
			`import { syncNativeRenameBySid } from ${JSON.stringify(join(PKG, "hooks", "lib", "session-rename.ts"))};` +
			`import { openStore } from ${JSON.stringify(join(PKG, "hooks", "lib", "govdb.ts"))};` +
			`console.log(JSON.stringify(syncNativeRenameBySid(openStore(), "w954sub1")));`;
		const r = run(["-e", script]);
		expect(r.code).toBe(0);
		expect(tagsOf("w954sub1").name).toBe("sid-keyed-sync");
	});

	test("SUSPENDERS_RENAME_SYNC=0 disables the sid-keyed face", () => {
		const script =
			`import { syncNativeRenameBySid } from ${JSON.stringify(join(PKG, "hooks", "lib", "session-rename.ts"))};` +
			`import { openStore } from ${JSON.stringify(join(PKG, "hooks", "lib", "govdb.ts"))};` +
			`console.log(JSON.stringify(syncNativeRenameBySid(openStore(), "w954sub1")));`;
		setRow("w954sub1", { transcript_path: transcript("never-by-sid") });
		expect(run(["-e", script], { SUSPENDERS_RENAME_SYNC: "0" }).code).toBe(0);
		expect(tagsOf("w954sub1").name).toBe("sid-keyed-sync");
		expect(run(["-e", script]).code).toBe(0);
		expect(tagsOf("w954sub1").name).toBe("never-by-sid");
	});

	test("startNativeRenameWatch ticks the sync", () => {
		expect(coord(["bootstrap", "--as", "w954watch"]).code).toBe(0);
		setRow("w954watch", { transcript_path: transcript("watch-picked-up") });
		const script =
			`import { startNativeRenameWatch } from ${JSON.stringify(join(PKG, "hooks", "lib", "session-rename.ts"))};` +
			`import { openStore } from ${JSON.stringify(join(PKG, "hooks", "lib", "govdb.ts"))};` +
			`startNativeRenameWatch(openStore(), "w954watch", 200);` +
			`setTimeout(() => process.exit(0), 700);`;
		const r = run(["-e", script]);
		expect(r.code).toBe(0);
		expect(tagsOf("w954watch").name).toBe("watch-picked-up");
	});
});
