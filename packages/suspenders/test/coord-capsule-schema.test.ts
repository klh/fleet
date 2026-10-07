// test/coord-capsule-schema.test.ts — W516 capsule schema delta (amp handoff
// lift, research-ampcode.md §M1): --files/--snippets/--todos stored as
// arrays, and `capsule get --verify` re-checks each field against the disk
// (file exists? snippet range inside the file?) instead of trusting prose.
// Real coord verb against a scratch-HOME governor db (the dispatch-next
// pattern) — the live governor.db is never touched.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "w516-capsule-home-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

const coord = (
	...args: string[]
): { out: string; err: string; code: number } => {
	const p = Bun.spawnSync([process.execPath, join(BIN, "coord.ts"), ...args], {
		cwd: process.cwd(),
		env: { ...process.env, HOME },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode ?? 1,
	};
};

describe("capsule schema delta (W516)", () => {
	test("set stores files/snippets/todos as arrays; get --verify re-checks disk", () => {
		const probe = "hooks/coord/facts.ts";
		const set = coord(
			"capsule",
			"set",
			"--as",
			"w516cap",
			"--checkpoint=abc1234",
			"--file=hooks/coord/facts.ts:1",
			"--done=schema landed",
			"--next=verify",
			`--files=${probe},hooks/bin/oracle.ts`,
			`--snippets=${probe}:1-50`,
			"--todos=wire stop gate;tests",
		);
		expect(set.code).toBe(0);
		// plain get stays raw JSON — the parseCapsuleGet resume path in
		// dispatch-next parses stdout with JSON.parse, so byte-compat holds
		const got = coord("capsule", "get", "--as", "w516cap");
		expect(got.code).toBe(0);
		const cap = JSON.parse(got.out.trim()) as Record<string, unknown>;
		expect(cap.checkpoint).toBe("abc1234");
		const parsed = JSON.parse(got.out.trim()) as {
			files: string[];
			snippets: string[];
			todos: string[];
		};
		expect(parsed.files).toEqual([probe, "hooks/bin/oracle.ts"]);
		expect(parsed.snippets).toEqual([`${probe}:1-50`]);
		expect(parsed.todos).toEqual(["wire stop gate", "tests"]);
		const v = coord("capsule", "get", "--as", "w516cap", "--verify");
		expect(v.out).toContain("checkpoint: abc1234");
		expect(v.out).toContain(`✓ ${probe}`);
		expect(v.out).toContain(`✓ ${probe}:1-50 (file has`);
		expect(v.out).toContain("[ ] wire stop gate");
		expect(v.out).toContain("[ ] tests");
	});

	test("missing files and past-EOF snippet ranges fail loudly", () => {
		expect(
			coord(
				"capsule",
				"set",
				"--as",
				"w516bad",
				"--checkpoint=beef",
				"--next=x",
				"--files=no/such/file.ts",
				"--snippets=hooks/coord/facts.ts:99999-100000;also/missing.ts:1-2",
			).code,
		).toBe(0);
		const v = coord("capsule", "get", "--as", "w516bad", "--verify");
		expect(v.out).toContain("✗ MISSING no/such/file.ts");
		expect(v.out).toContain("range past EOF");
		expect(v.out).toContain("✗ MISSING also/missing.ts:1-2");
	});

	test("non-JSON capsule renders with a cannot-verify note, not a crash", () => {
		// a legacy/garbage capsule row written directly into the scratch db
		const db = new Database(
			join(HOME, ".cache", "claude-governor", "governor.db"),
		);
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'test', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run("lane.w516jsonbad.capsule", "not json{", Date.now());
		db.close();
		const v = coord("capsule", "get", "--as", "w516jsonbad", "--verify");
		expect(v.code).toBe(0);
		expect(v.out).toContain("cannot verify");
	});

	test("empty lane still renders (no capsule)", () => {
		expect(coord("capsule", "get", "--as", "w516none").out).toContain(
			"(no capsule)",
		);
	});
});
