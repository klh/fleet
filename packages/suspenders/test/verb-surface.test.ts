// Every registered Work Graph and coordination verb must remain callable.
// Stateful round trips live beside this surface check (consult, capsule, work).
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
// W1003.1.1.1: the lifecycle-authority door intentionally refuses fleet
// lane worktrees by cwd, and this suite runs from lane cwds — spawn the
// child CLIs from a neutral directory (scripts still resolve from ROOT).
const NEUTRAL = mkdtempSync(join(tmpdir(), "verb-surface-"));
// These checks spawn every CLI/verb in series; process startup varies under
// concurrent Fleet work, while the contract being tested has no time limit.
const HELP_SMOKE_TIMEOUT_MS = 30_000;
const CLIS = [
	{ name: "coord", path: "packages/suspenders/hooks/bin/coord.ts", floor: 45 },
	{ name: "work", path: "packages/suspenders/hooks/bin/work.ts", floor: 26 },
];

function cli(
	path: string,
	...args: string[]
): { code: number; output: string } {
	const run = Bun.spawnSync([process.execPath, resolve(ROOT, path), ...args], {
		cwd: NEUTRAL,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: run.exitCode,
		output: `${run.stdout.toString()}${run.stderr.toString()}`,
	};
}

for (const spec of CLIS) {
	test(
		`${spec.name}: every advertised verb resolves to generated help`,
		() => {
			const top = cli(spec.path, "--help");
			expect(top.code).toBe(0);
			const first = top.output.split("\n", 1)[0] ?? "";
			const verbs = first.split(". ")[1]?.split(" | ") ?? [];
			expect(verbs.length).toBeGreaterThanOrEqual(spec.floor);
			expect(new Set(verbs).size).toBe(verbs.length);
			const failures = verbs.flatMap((verb) => {
				const result = cli(spec.path, verb, "--help");
				return result.code === 0 && result.output.includes("usage:")
					? []
					: [`${verb}: exit ${result.code}: ${result.output.slice(0, 150)}`];
			});
			expect(failures).toEqual([]);
		},
		HELP_SMOKE_TIMEOUT_MS,
	);
}

test(
	"every registered Suspenders CLI entrypoint opens its help",
	() => {
		const dir = resolve(ROOT, "packages/suspenders/hooks/bin");
		const entrypoints = readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) =>
				readFileSync(resolve(dir, name), "utf8").includes("runCli("),
			);
		expect(entrypoints.length).toBeGreaterThanOrEqual(19);
		const failures = entrypoints.flatMap((name) => {
			const path = `packages/suspenders/hooks/bin/${name}`;
			const result = cli(path, "--help");
			if (result.code !== 0 || !result.output.trim())
				return [`${name}: exit ${result.code}: ${result.output.slice(0, 150)}`];
			const verbs =
				result.output.split("\n", 1)[0]?.split(". ").at(-1)?.split(" | ") ?? [];
			if (!verbs.length || !verbs[0])
				return [`${name}: no registry verbs in help`];
			return verbs.flatMap((verb) => {
				const help = cli(path, verb, "--help");
				return help.code === 0 && help.output.includes("usage:")
					? []
					: [
							`${name} ${verb}: exit ${help.code}: ${help.output.slice(0, 150)}`,
						];
			});
		});
		expect(failures).toEqual([]);
	},
	HELP_SMOKE_TIMEOUT_MS,
);
