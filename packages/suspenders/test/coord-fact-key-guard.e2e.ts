// coord-fact-key-guard.test.ts — W773: `fact set` rejects flag-shaped keys
// (`fact set --text "v"` with the key omitted minted a junk row keyed
// "--text") and `fact rm` purges rows, including those legacy flag-shaped
// keys. Temp HOME; every CLI run in a bun subprocess
// (coord-fact-cas.test.ts recipe).
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";
test.describe({ tag: "@unit" }, () => {

test.setTimeout(30_000); // spawn-heavy suite (bun:test 5s default flake floor)

const STORE = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb-store.ts");
const fx = cliFixture("w773-fact-key-guard");

test.afterAll(() => fx.cleanup());

const runCli = (args: string[]): { code: number; out: string; err: string } =>
	fx.run("coord.ts", args);

// the guard blocks re-minting flag-shaped keys through the CLI, so the
// rm test seeds one the way the old build left it: a direct store insert
// in the SAME temp HOME (openStore resolves the db from HOME)
const seedRow = (key: string, value: string): number => {
	const src = `import { openStore } from ${JSON.stringify(STORE)}; openStore().query("INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'w773-test', 1, 1)").run(${JSON.stringify(key)}, ${JSON.stringify(value)});`;
	const p = Bun.spawnSync(["bun", "-e", src], {
		env: { ...process.env, HOME: fx.HOME },
		cwd: join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode;
};

test.describe("fact set — flag-shaped key guard (W773)", () => {
	test("key omitted: `fact set --text v` dies at usage, no --text row lands", () => {
		const r = runCli(["fact", "set", "--text", "keyless"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("usage: fact set");
		// W836: fact get rides the schema note after the value line
		expect(runCli(["fact", "get", "--text"]).out).toContain("(unset)");
	});

	test("flag-shaped positional key dies too", () => {
		const r = runCli(["fact", "set", "--foo", "bar"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("usage: fact set");
	});

	test("legit dotted keys still write", () => {
		const r = runCli(["fact", "set", "w773.ok", "fine"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("fact w773.ok = fine");
	});
});

test.describe("fact rm — the purge verb (W773)", () => {
	test("removes an existing row; get falls back to unset", () => {
		expect(runCli(["fact", "set", "w773.rm", "gone"]).code).toBe(0);
		const r = runCli(["fact", "rm", "w773.rm"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("fact w773.rm removed");
		expect(runCli(["fact", "get", "w773.rm"]).out).toContain("(unset)");
	});

	test("accepts a flag-shaped key — the junk rows ARE flag-shaped", () => {
		expect(seedRow("--text", "junk from the old build")).toBe(0);
		expect(runCli(["fact", "get", "--text"]).out).toContain(
			"junk from the old build",
		);
		const r = runCli(["fact", "rm", "--text"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("fact --text removed");
		expect(runCli(["fact", "get", "--text"]).out).toContain("(unset)");
	});

	test("missing key dies with no such key", () => {
		const r = runCli(["fact", "rm", "w773.nope"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain('no such key "w773.nope"');
	});

	test("rm with no argument dies at usage", () => {
		const r = runCli(["fact", "rm"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("usage: fact rm");
	});
});

});
