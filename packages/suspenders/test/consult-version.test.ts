import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("consult version invalidates tracked and untracked content and rejects oversized state", () => {
	const repo = mkdtempSync(join(tmpdir(), "consult-version-"));
	const module = join(import.meta.dir, "../hooks/coord/consult-trust.ts");
	const version = () =>
		Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`const {consultVersion}=await import(${JSON.stringify(module)}); console.log(JSON.stringify(consultVersion()));`,
			],
			{ cwd: repo },
		)
			.stdout.toString()
			.trim();
	try {
		expect(version()).toBe("null");
		Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "source.ts"), "export const n = 1;\n");
		Bun.spawnSync(["git", "add", "source.ts"], { cwd: repo });
		const commit = Bun.spawnSync(
			[
				"git",
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"-qm",
				"base",
			],
			{ cwd: repo },
		);
		expect(commit.exitCode).toBe(0);
		const initial = version();
		writeFileSync(join(repo, "source.ts"), "export const n = 2;\n");
		expect(version()).not.toBe(initial);
		writeFileSync(join(repo, "new.ts"), "first\n");
		const added = version();
		writeFileSync(join(repo, "new.ts"), "second\n");
		expect(version()).not.toBe(added);
		writeFileSync(join(repo, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
		expect(version()).toBe("null");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
