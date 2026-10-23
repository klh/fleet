// test/install-llm-drain.test.ts — W1205.2: the drain proof suite's
// secret-suffix half. A cut through the captured generator stderr must
// never expose a truncated secret: the 8KB window is line-aligned (the
// partial line at the cut is dropped whole), so per-line scrub rules see
// every kept line from its start.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRun } from "../scripts/install-llm-steps.ts";

setDefaultTimeout(60_000);

const dirs: string[] = [];
const tmp = (label: string): string => {
	const dir = mkdtempSync(join(tmpdir(), `w12052-drain-${label}-`));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// fixture: echo $FIXTURE_PAYLOAD to stderr and fail — the payload rides the
// inherited env (defaultRun spreads process.env at spawn time)
const writeFixture = (dir: string): string => {
	const gen = join(dir, "suffix-fixture.ts");
	writeFileSync(
		gen,
		[
			'const p = process.env.FIXTURE_PAYLOAD ?? "";',
			"await Bun.write(Bun.stderr, p);",
			"process.exit(9);",
		].join("\n"),
	);
	return gen;
};

// key material the scrub rules match (`\bsk-[A-Za-z0-9_-]{20,}\b`) whose
// alphabet shares no character with the 'x' filler — any kept fragment of
// the key would surface as a q-run in the sanitized message
const key = `sk-${"q".repeat(24)}`;
const filler = `${"x".repeat(64)}\n`;

const runFixture = async (
	dir: string,
	gen: string,
	payload: string,
): Promise<Error | null> => {
	const previous = process.env.FIXTURE_PAYLOAD;
	process.env.FIXTURE_PAYLOAD = payload;
	try {
		return await defaultRun([process.execPath, gen], dir).then(
			() => null,
			(e: Error) => e,
		);
	} finally {
		if (previous === undefined) delete process.env.FIXTURE_PAYLOAD;
		else process.env.FIXTURE_PAYLOAD = previous;
	}
};

describe("W1205.2 truncated stderr never reveals a secret suffix", () => {
	test("a key straddling the window cut is dropped with its partial line", async () => {
		const dir = tmp("straddle");
		const gen = writeFixture(dir);
		// 3250B filler + 60 x's = 3310B in; the 8192B window starts at
		// 11505-8192 = 3313 → the cut lands 3 bytes INTO the key
		const payload = `${filler.repeat(50)}${"x".repeat(60)}${key}\n${filler.repeat(125)}${"x".repeat(41)}\n`;
		const error = await runFixture(dir, gen, payload);
		expect(error).toBeInstanceOf(Error);
		const msg = (error as Error).message;
		expect(msg).toContain("rc=9");
		expect(msg).toContain("B truncated]");
		expect(msg).not.toContain(key);
		expect(msg).not.toContain("qqqq");
	});

	test("a giant newline-free line with a key yields no line-aligned tail", async () => {
		const dir = tmp("giant");
		const gen = writeFixture(dir);
		// one 12067B line: the window holds the key entirely but no newline —
		// nothing line-aligned survives, so the diagnostic carries no stderr
		const giant = `${"x".repeat(11840)}${key}${"x".repeat(200)}`;
		const error = await runFixture(dir, gen, giant);
		expect(error).toBeInstanceOf(Error);
		const msg = (error as Error).message;
		expect(msg).toContain("rc=9");
		expect(msg).toContain("no stderr captured");
		expect(msg).toContain("truncated");
		expect(msg).not.toContain(key);
		expect(msg).not.toContain("qqqq");
	});

	test("a whole key line inside the window is fully redacted, not truncated", async () => {
		const dir = tmp("whole");
		const gen = writeFixture(dir);
		// the key is the final short line inside the kept tail — the scrub
		// rule must redact it whole (no partial reveal via the display cap)
		const payload = `${filler.repeat(140)}${key}\n`;
		const error = await runFixture(dir, gen, payload);
		expect(error).toBeInstanceOf(Error);
		const msg = (error as Error).message;
		expect(msg).toContain("rc=9");
		expect(msg).toContain("[redacted]");
		expect(msg).not.toContain(key);
		expect(msg).not.toContain("qqqq");
	});
});
