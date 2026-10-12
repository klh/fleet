// test/fleet.test.ts — W293 session-name bridge: `coord bootstrap --name`
// stamps the user-facing lane name into sessions.tags JSON (merged with
// other tags, re-bootstrap renames), `coord fleet` shows it next to the
// short sid, and the board label helpers surface it.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-fleet-test-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-fleet-test-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const LANES = join(import.meta.dir, "..", "hooks", "board", "lanes.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const env = { ...process.env, HOME, NO_COLOR: "1" };
mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO], {
	stdout: "ignore",
	stderr: "ignore",
});
writeFileSync(join(REPO, "README.md"), "seed\n");
Bun.spawnSync(["git", "-C", REPO, "add", "README.md"], {
	stdout: "ignore",
	stderr: "ignore",
});
Bun.spawnSync(["git", "-C", REPO, "commit", "-q", "-m", "init"], {
	stdout: "ignore",
	stderr: "ignore",
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

function run(args: string[]) {
	const p = Bun.spawnSync(["bun", BIN, ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}

function tagsOf(sid: string): Record<string, unknown> {
	const db = new Database(DB);
	db.run("PRAGMA busy_timeout = 4000");
	const row = db.query("SELECT tags FROM sessions WHERE sid = ?").get(sid) as {
		tags: string | null;
	} | null;
	db.close();
	return row?.tags ? JSON.parse(row.tags) : {};
}

// the board label helpers open governor.db at import (hooks/board/context.ts)
// — run them in a HOME-overridden subprocess, the fleet-targets.test recipe
async function boardLabels(): Promise<
	Record<
		"named" | "claimIntent" | "nameOnly" | "unnamed" | "ownerFallback",
		string | null
	>
> {
	const script = `
		import { label, ownerLabel } from ${JSON.stringify(LANES)};
		console.log(JSON.stringify({
			named: label("lane293", "worker"),
			claimIntent: ownerLabel("lane293"),
			nameOnly: ownerLabel("lane299"),
			unnamed: label("plain999", "worker"),
			ownerFallback: ownerLabel("plain999"),
		}));
	`;
	const proc = Bun.spawn(["bun", "-e", script], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(`board helper subprocess failed: ${err}`);
	return JSON.parse(out.trim());
}

describe("W293 session-name bridge", () => {
	test("bootstrap --name stamps tags.name and merges with --tags", () => {
		expect(
			run([
				"bootstrap",
				"--as",
				"lane293",
				"--role",
				"worker",
				"--name",
				"ikea-opus",
				"--tags",
				JSON.stringify({ team: "ikea" }),
			]).code,
		).toBe(0);
		expect(tagsOf("lane293")).toEqual({ team: "ikea", name: "ikea-opus" });
	});

	test("re-bootstrap with a new --name renames and keeps other tag keys", () => {
		expect(
			run(["bootstrap", "--as", "lane293", "--name", "ikea-opus-2"]).code,
		).toBe(0);
		expect(tagsOf("lane293")).toEqual({ team: "ikea", name: "ikea-opus-2" });
	});

	test("coord fleet shows the name next to the short sid", () => {
		// claim row seeded directly (claim.ts validates live transcripts, which
		// a temp HOME lacks — same recipe as the board tests)
		const db = new Database(DB);
		db.run("PRAGMA busy_timeout = 4000");
		db.query(
			"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts) VALUES ('lane293', 'w293', 'W293 work', 0, ?)",
		).run(Date.now());
		db.close();
		const f = run(["fleet"]);
		expect(f.code).toBe(0);
		expect(f.out).toContain("ikea-opus-2 (lane293)");
	});

	test("board label helpers surface tags.name", async () => {
		// a named lane with no claim: owner_label shows the session name
		expect(
			run(["bootstrap", "--as", "lane299", "--name", "ikea-niner"]).code,
		).toBe(0);
		const r = await boardLabels();
		// label(): the user-given name beats even a live claim intent
		expect(r.named).toBe("ikea-opus-2");
		// owner_label keeps its documented order: claim intent, else name
		expect(r.claimIntent).toBe("W293 work");
		expect(r.nameOnly).toBe("ikea-niner");
		// a sid without a name falls through untouched (intent → sid rules hold)
		expect(r.unnamed).toBe("plain999");
		// owner_label for a sid with NO sessions row stays null — never invent
		// a label for an unknown sid
		expect(r.ownerFallback).toBeNull();
	});
});
