// coord-fact-cas.test.ts — W606: `coord fact set --if-version` / `coord capsule
// set --if-version=N` compare-and-set guards. Temp HOME under tmpdir; every CLI
// run happens in a bun subprocess so the parent test process never opens the
// real governor.db (coord-events.test.ts recipe).
import { describe, expect, test, afterAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000); // spawn-heavy suite (bun:test 5s default flake floor)

const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-coord-fact-cas-test-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const runCli = (args: string[]): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(["bun", COORD, ...args], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
	};
};

describe("fact set --if-version — the facts CAS", () => {
	test("legacy write (no flag): blind upsert, version increments, output unchanged", () => {
		const a = runCli(["fact", "set", "w606.plain", "first"]);
		expect(a.code).toBe(0);
		expect(a.out).toContain("fact w606.plain = first");
		const b = runCli(["fact", "set", "w606.plain", "second"]);
		expect(b.code).toBe(0);
		const g = runCli(["fact", "get", "w606.plain"]);
		expect(g.out).toContain("second");
		expect(g.out).toContain("(v2)"); // version exposed for read-then-CAS
	});

	test("create-only: --if-version 0 creates, second --if-version 0 refuses", () => {
		const a = runCli([
			"fact",
			"set",
			"w606.create",
			"born",
			"--if-version",
			"0",
		]);
		expect(a.code).toBe(0);
		const b = runCli([
			"fact",
			"set",
			"w606.create",
			"again",
			"--if-version",
			"0",
		]);
		expect(b.code).toBe(2);
		expect(b.err).toContain("refused");
		expect(b.err).toContain("current version 1");
	});

	test("CAS update: correct expectation writes, version bumps", () => {
		const g = runCli(["fact", "get", "w606.create"]); // (v1) → expect 1
		expect(g.out).toContain("(v1)");
		const w = runCli([
			"fact",
			"set",
			"w606.create",
			"updated",
			"--if-version",
			"1",
		]);
		expect(w.code).toBe(0);
		expect(w.out).toContain("fact w606.create = updated");
		expect(runCli(["fact", "get", "w606.create"]).out).toContain("(v2)");
	});

	test("CAS mismatch refuses with the current version", () => {
		const w = runCli([
			"fact",
			"set",
			"w606.create",
			"stale",
			"--if-version",
			"1",
		]); // current is 2
		expect(w.code).toBe(2);
		expect(w.err).toContain("refused");
		expect(w.err).toContain("current version 2");
		// value untouched by the refusal
		expect(runCli(["fact", "get", "w606.create"]).out).toContain(
			"updated (v2)",
		);
	});

	test("garbage --if-version dies at usage (exit 2)", () => {
		const w = runCli(["fact", "set", "w606.create", "x", "--if-version", "xx"]);
		expect(w.code).toBe(2);
		expect(w.err).toContain("--if-version");
	});

	test("missing row + --if-version 1 refuses (no phantom create)", () => {
		const w = runCli(["fact", "set", "w606.ghost", "x", "--if-version", "1"]);
		expect(w.code).toBe(2);
		expect(w.err).toContain("current version unset");
	});
});

describe("capsule set --if-version=N — the capsule CAS", () => {
	test("CAS update lands, refusal carries current version, payload never leaks the flag", () => {
		const s1 = runCli([
			"capsule",
			"set",
			"--as",
			"w606caps",
			"--checkpoint=abc",
		]);
		expect(s1.code).toBe(0);
		const s2 = runCli([
			"capsule",
			"set",
			"--as",
			"w606caps",
			"--if-version=1",
			"--checkpoint=def",
		]);
		expect(s2.code).toBe(0);
		const s3 = runCli([
			"capsule",
			"set",
			"--as",
			"w606caps",
			"--if-version=1",
			"--checkpoint=stale",
		]); // current is 2
		expect(s3.code).toBe(2);
		expect(s3.err).toContain("refused");
		expect(s3.err).toContain("current version 2");
		// the refusal left the stored payload untouched, flag never lands in it
		const g = runCli(["capsule", "get", "--as", "w606caps"]);
		const cap = JSON.parse(g.out.trim()) as Record<string, string>;
		expect(cap.checkpoint).toBe("def");
		expect(cap["if-version"]).toBeUndefined();
	});

	test("capsule get output stays JSON.parse-able (parseCapsuleGet contract)", () => {
		const g = runCli(["capsule", "get", "--as", "w606caps"]);
		expect(() => JSON.parse(g.out.trim())).not.toThrow();
	});
});

describe("concurrent CAS — exactly one writer wins", () => {
	test("two racing --if-version writers: one exit 0, one refusal", async () => {
		const seed = runCli([
			"fact",
			"set",
			"w606.race",
			"v1",
			"--if-version",
			"0",
		]);
		expect(seed.code).toBe(0);
		const spawn = () =>
			Bun.spawn(
				[
					"bun",
					COORD,
					"fact",
					"set",
					"w606.race",
					"racer",
					"--if-version",
					"1",
				],
				{
					env: { ...process.env, HOME: home },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
		const [a, b] = await Promise.all([spawn().exited, spawn().exited]);
		expect([a, b].sort()).toEqual([0, 2]);
		// winner's write landed exactly once more: v1 → v2
		expect(runCli(["fact", "get", "w606.race"]).out).toContain("(v2)");
	});
});
