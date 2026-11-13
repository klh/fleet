// bench/agentic-ledger/prepare-lib.ts — materialize the sealed fixture
// repo (refuses to overwrite). Lib core; prepare.ts is the CLI wrapper.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function fixtureSourceDir(): string {
	return join(import.meta.dir, "fixture");
}

export function prepareFixture(target: string): string {
	const resolved = resolve(target);
	if (existsSync(resolved))
		throw new Error(`refusing existing fixture directory: ${resolved}`);
	mkdirSync(resolved, { recursive: true });
	cpSync(fixtureSourceDir(), resolved, { recursive: true });
	const git = (...args: string[]): void => {
		const p = Bun.spawnSync(["git", "-C", resolved, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
	};
	git("init", "-q");
	git("add", ".");
	git(
		"-c",
		"user.name=BLAM",
		"-c",
		"user.email=blam@example.invalid",
		"commit",
		"-qm",
		"sealed fixture",
	);
	return resolved;
}
