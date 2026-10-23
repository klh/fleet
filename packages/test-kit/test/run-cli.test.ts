// test/run-cli.test.ts — the kit's own suite for runCli(): arg passthrough,
// cwd/env overrides, exit codes.
import { afterAll, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/run-cli.ts";
import { scratchWorld } from "../src/scratch-world.ts";

const w = scratchWorld({ prefix: "kit-runcli-" });

// probe bin: echoes each argv, its cwd, KIT_PROBE on stderr, optional exit code
const bin = join(w.home, "probe-cli.ts");
writeFileSync(
	bin,
	[
		"for (const a of process.argv.slice(2)) console.log(a);",
		"console.log(process.cwd());",
		'console.error(process.env.KIT_PROBE ?? "no-env");',
		'if (process.argv.includes("--die")) process.exit(3);',
		"",
	].join("\n"),
	{ mode: 0o755 },
);

test("runCli: spawns [bun, bin, ...args] and returns out/err/code", () => {
	const r = runCli(bin, ["a", "b"]);
	expect(r.code).toBe(0);
	expect(r.out.split("\n").slice(0, 2)).toEqual(["a", "b"]);
	expect(r.err.trim()).toBe("no-env");
});

test("runCli: cwd + env overrides reach the child", () => {
	const r = runCli(bin, [], {
		cwd: w.repo,
		env: { ...w.env, KIT_PROBE: "cwd-marker" },
	});
	expect(r.out.trimEnd().split("\n").at(-1)).toBe(realpathSync(w.repo));
	expect(r.err.trim()).toBe("cwd-marker");
});

test("runCli: child exit codes pass through", () => {
	const r = runCli(bin, ["--die"]);
	expect(r.code).toBe(3);
});

afterAll(() => {
	w.clean();
});
