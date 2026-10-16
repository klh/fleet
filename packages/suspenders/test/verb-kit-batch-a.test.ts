// test/verb-kit-batch-a.test.ts — W656.1 smoke: every batch-A CLI renders
// --help from its verb-kit spec, and one real verb executes unchanged on the
// preserved surface. The two second-person minters (approve-destructive,
// lifecycle-authority) refuse lanes by cwd, so their help face is asserted
// from a non-lane cwd.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000); // spawn-heavy suite (memory: 5s default is the flake floor)

const BIN = join(import.meta.dir, "..", "hooks", "bin");
const CWD = join(import.meta.dir, "..", "..", "..");
// HOME-isolated temp dir: the spawned CLIs open the registry, and an
// un-isolated child would run the migration ladder against the live HOME
const tmp = mkdtempSync(join(tmpdir(), "w656-1-smoke-"));

const run = (file: string, args: string[], cwd = CWD) => {
	const p = Bun.spawnSync(["bun", join(BIN, file), ...args], {
		cwd,
		env: { ...process.env, HOME: tmp },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
};

const BATCH_A = [
	"admission.ts",
	"approve-destructive.ts",
	"auth.ts",
	"claim.ts",
	"lifecycle-authority.ts",
	"progress.ts",
	"scrub-gate.ts",
	"splice.ts",
];

// the two minters refuse a lane cwd before argv — help must still render
// from a non-lane cwd (owner-terminal posture)
const LANE_REFUSERS = ["approve-destructive.ts", "lifecycle-authority.ts"];

describe("verb-kit batch A (W656.1)", () => {
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	for (const file of BATCH_A) {
		if (LANE_REFUSERS.includes(file)) continue;
		test(`${file} --help renders from the kit`, () => {
			const r = run(file, ["--help"]);
			expect(r.code).toBe(0);
			expect(r.out.trim().length).toBeGreaterThan(0);
		});
	}

	for (const file of LANE_REFUSERS) {
		test(`${file} --help renders from a non-lane cwd`, () => {
			const r = run(file, ["--help"], tmp);
			expect(r.code).toBe(0);
			// registry help (about + verbs) vs per-verb help (usage line)
			expect(r.out.trim().length).toBeGreaterThan(0);
		});
	}

	test("auth keyring lists the ring or the legacy note (exit 0)", () => {
		const r = run("auth.ts", ["keyring"]);
		expect(r.code).toBe(0);
		expect(r.out.length).toBeGreaterThan(0);
	});

	test("claim list exits 0 on the live registry", () => {
		const r = run("claim.ts", ["list"]);
		expect(r.code).toBe(0);
	});

	test("progress list exits 0 (empty or live entries)", () => {
		const r = run("progress.ts", ["list"]);
		expect(r.code).toBe(0);
	});

	test("admission check rejects an unsupported kind (exit 2, deterministic)", () => {
		const r = run("admission.ts", ["check", "--kind", "not-a-kind"]);
		expect(r.code).toBe(2);
		expect(r.out).toContain("UNKNOWN");
	});

	test("scrub-gate files scans a clean file (exit 0)", () => {
		const f = join(tmp, "clean.txt");
		writeFileSync(f, "just prose, nothing scrub-worthy\n");
		const r = run("scrub-gate.ts", ["files", f]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("clean");
	});

	test("splice replaces exactly the expected occurrence", () => {
		const f = join(tmp, "splice.txt");
		writeFileSync(f, "alpha beta gamma\n");
		const r = run("splice.ts", [
			f,
			"--find",
			"beta",
			"--replace",
			"BETA",
			"--count",
			"1",
		]);
		expect(r.code).toBe(0);
		expect(readFileSync(f, "utf8")).toBe("alpha BETA gamma\n");
	});

	test("splice count-mismatch aborts untouched (exit 1)", () => {
		const f = join(tmp, "splice-abort.txt");
		writeFileSync(f, "only once here\n");
		const r = run("splice.ts", [
			f,
			"--find",
			"once",
			"--replace",
			"x",
			"--count",
			"2",
		]);
		expect(r.code).toBe(1);
		expect(readFileSync(f, "utf8")).toBe("only once here\n");
	});
});
