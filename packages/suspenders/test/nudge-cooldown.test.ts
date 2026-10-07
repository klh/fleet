// test/nudge-cooldown.test.ts — W514: sha-keyed advisory cooldown dedupe
// (claudecode research §1.6) on the ONE nudge channel (hookio.nudge), plus
// the shared atomic session-state IO it rides. Gate-level probes spawn the
// real hookio through a bun driver script; state lands in an isolated
// TMPDIR keyed per sid.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "../hooks/lib/session-state.ts";
import { bumpPathCount } from "../hooks/lib/gatestate.ts";

const TMP = mkdtempSync(join(tmpdir(), "suspenders-nudgecool-"));
const HOOKS = join(import.meta.dir, "..", "hooks");

// driver: readHook() stashes the payload, then nudge() decides — exit code
// and stdout carry the verdict JSON
const DRIVER = join(TMP, "driver.ts");
writeFileSync(
	DRIVER,
	`import { readHook, nudge } from ${JSON.stringify(join(HOOKS, "lib/hookio.ts"))};
await readHook();
nudge(process.argv[2] ?? "");`,
);

let n = 0;
function drive(sid: string | null, message: string, envExtra?: Record<string, string>): {
	out: string;
	code: number | null;
} {
	const pf = join(TMP, `payload-${n++}.json`);
	writeFileSync(
		pf,
		JSON.stringify({ tool_name: "Bash", ...(sid ? { session_id: sid } : {}) }),
	);
	const p = Bun.spawnSync(
		["bun", DRIVER, message],
		{
			cwd: TMP,
			env: { ...process.env, TMPDIR: TMP, ...(envExtra ?? {}) },
			stdin: Bun.file(pf),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return { out: p.stdout.toString(), code: p.exitCode };
}

const emitted = (r: { out: string }) => r.out.includes("additionalContext");

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("session-state IO", () => {
	test("write/read round-trip; corrupt or missing reads as null", () => {
		const f = sessionStatePath("t", "roundtrip");
		expect(writeSessionState(f, { a: 1 })).toBe(true);
		expect(readSessionState<Record<string, number>>(f)).toEqual({ a: 1 });
		writeFileSync(f, "{not json");
		expect(readSessionState(f)).toBeNull();
	});

	test("bumpPathCount counts per path through the shared IO", () => {
		const sid = `streak-${Math.random().toString(36).slice(2)}`;
		expect(bumpPathCount("edits", sid, "/x/y.ts")).toBe(1);
		expect(bumpPathCount("edits", sid, "/x/y.ts")).toBe(2);
	});
});

describe("nudge cooldown", () => {
	test("first emission passes, immediate repeat is suppressed", () => {
		const sid = `cool-${Math.random().toString(36).slice(2)}`;
		const first = drive(sid, "identical advisory");
		expect(emitted(first)).toBe(true);
		const second = drive(sid, "identical advisory");
		expect(second.out).toBe("{}"); // same sha within cooldown → plain allow
		expect(emitted(second)).toBe(false);
	});

	test("different text still emits under the same session", () => {
		const sid = `cool-${Math.random().toString(36).slice(2)}`;
		expect(emitted(drive(sid, "advisory one"))).toBe(true);
		expect(emitted(drive(sid, "advisory two"))).toBe(true);
	});

	test("SUSPENDERS_NUDGE_COOLDOWN_MS=0 disables the throttle", () => {
		const sid = `cool-${Math.random().toString(36).slice(2)}`;
		expect(emitted(drive(sid, "kill switch", { SUSPENDERS_NUDGE_COOLDOWN_MS: "0" }))).toBe(true);
		expect(emitted(drive(sid, "kill switch", { SUSPENDERS_NUDGE_COOLDOWN_MS: "0" }))).toBe(true);
	});

	test("no session_id fails open (always emits)", () => {
		expect(emitted(drive(null, "anon advisory"))).toBe(true);
		expect(emitted(drive(null, "anon advisory"))).toBe(true);
	});

	test("cooldown state file is 0600 and lives under the driver's TMPDIR", () => {
		const sid = `cool-${Math.random().toString(36).slice(2)}`;
		drive(sid, "perm probe");
		const f = join(TMP, `claude-nudge-${sid}.json`); // driver runs with TMPDIR=TMP
		expect(existsSync(f)).toBe(true);
		expect((statSync(f).mode & 0o777).toString(8)).toBe("600");
	});
});
