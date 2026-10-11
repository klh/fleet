// test/verb-kit-batch-b.test.ts — W656.2 smoke: every batch-B CLI renders
// --help from its verb-kit spec, and one real verb executes unchanged on the
// preserved surface (launchd/launchd-adjacent shapes stay verb-less).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000); // spawn-heavy suite (memory: 5s default is the flake floor)

const BIN = join(import.meta.dir, "..", "hooks", "bin");
const CWD = join(import.meta.dir, "..", "..", "..");

const run = (file: string, ...args: string[]) => {
	const p = Bun.spawnSync(["bun", join(BIN, file), ...args], {
		cwd: CWD,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
};

const BATCH_B = [
	"advise.ts",
	"copilot-usage.ts",
	"credit-forecast.ts",
	"morph.ts",
	"packet-prep.ts",
	"quota-window.ts",
	"soak.ts",
	"worktree.ts",
];

describe("verb-kit batch B (W656.2)", () => {
	const tmp = mkdtempSync(join(tmpdir(), "w656-2-smoke-"));
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	for (const file of BATCH_B) {
		test(`${file} --help renders from the kit`, () => {
			const r = run(file, "--help");
			expect(r.code).toBe(0);
			expect(r.out.trim().length).toBeGreaterThan(0);
		});
	}

	test("credit-forecast sample → forecast round-trip (isolated db/state)", () => {
		const db = join(tmp, "samples.jsonl");
		const state = join(tmp, "state.json");
		const s = run(
			"credit-forecast.ts",
			"sample",
			"--used",
			"100",
			"--limit",
			"50000",
			"--plan",
			"business",
			"--db",
			db,
			"--state",
			state,
		);
		expect(s.code).toBe(0);
		expect(s.out).toContain("sampled:");
		const f = run("credit-forecast.ts", "forecast", "--db", db, "--json");
		expect(f.code).toBe(0); // fresh single sample, no burn → OK
		const body = JSON.parse(f.out) as { verdict: string };
		expect(body.verdict).toBe("OK");
	});

	test("packet-prep preps a real file (--json NDJSON face)", () => {
		const f = join(tmp, "doc.txt");
		writeFileSync(f, "# Header\n\nSome operational prose to compress.\n");
		const r = run("packet-prep.ts", f, "--json");
		expect(r.code).toBe(0);
		const line = JSON.parse(r.out.trim().split("\n")[0]) as {
			source: string;
		};
		expect(line.source).toBe(f);
	});

	test("advise without an event id dies with usage (exit 1, pre-db)", () => {
		const r = run("advise.ts");
		expect(r.code).toBe(1);
		expect(r.err).toContain("usage:");
	});

	test("worktree path resolves the registry (real verb, read-only)", () => {
		const r = run("worktree.ts", "path", "W656.2");
		expect(r.code).toBe(0);
		expect(r.out.trim()).toContain("W656.2");
	});

	test("copilot-usage reports read-only (--json, no flush)", () => {
		const r = run("copilot-usage.ts", "--json");
		expect(r.code).toBe(0);
		const body = JSON.parse(r.out) as { ok: boolean };
		expect(typeof body.ok).toBe("boolean");
	});
});
