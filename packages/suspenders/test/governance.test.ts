// test/governance.test.ts — the `coord governance` verb (W422.17, owner
// ruling 2026-10-06): the fleet's governance mode lives as the
// `fleet.governance` coord fact. Read prints the mode (absent = `strict
// (default)`); set upserts with a source. Isolated temp HOME, spawns the
// real CLI (consult-kb recipe).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-governance-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-governance-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");

function run(args: string[]) {
	const p = Bun.spawnSync(["bun", coord, ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

const storedSource = (): string | null => {
	const db = new Database(DB, { readonly: true });
	const row = db
		.query("SELECT source FROM facts WHERE key = 'fleet.governance'")
		.get() as { source: string } | null;
	db.close();
	return row?.source ?? null;
};

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("coord governance verb (W422.17)", () => {
	test("fact absent → prints `strict (default)`", () => {
		const r = run(["governance"]);
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("strict (default)");
	});

	test("governance solo sets the fact (default source) and read flips", () => {
		const set = run(["governance", "solo"]);
		expect(set.code).toBe(0);
		expect(set.out.trim()).toBe("fleet.governance = solo");
		expect(run(["governance"]).out.trim()).toBe("solo");
		expect(storedSource()).toBe("owner");
	});

	test("explicit --source is recorded and governance strict flips back", () => {
		const set = run(["governance", "strict", "--source", "test"]);
		expect(set.code).toBe(0);
		expect(set.out.trim()).toBe("fleet.governance = strict");
		expect(run(["governance"]).out.trim()).toBe("strict");
		expect(storedSource()).toBe("test");
	});

	test("invalid mode dies with usage", () => {
		const r = run(["governance", "anarchy"]);
		expect(r.code).not.toBe(0);
		expect(r.err).toContain("usage");
	});
});
