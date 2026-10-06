import { expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GUI refresh rolls back broken installations and never writes config", () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-refresh-test-"));
	try {
		const prefix = join(home, "prefix");
		const entries = [
			join(home, ".claude/local-llm/dashboard.ts"),
			join(home, ".local/klh-local/bin/dashboard.ts"),
			join(prefix, "bin/fleet-board.ts"),
		];
		for (const entry of entries) {
			mkdirSync(join(entry, ".."), { recursive: true });
			writeFileSync(entry, "export const old = true;\n");
		}
		const config = join(home, ".claude/local-llm/registry.ts");
		writeFileSync(config, "export const operatorOwned = true;\n");
		const result = Bun.spawnSync(
			["bun", join(import.meta.dir, "../scripts/refresh-dashboards.ts")],
			{
				env: { ...process.env, HOME: home, SUSPENDERS_PREFIX: prefix },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).not.toBe(0); // deliberately incomplete registry/dependencies
		for (const entry of entries)
			expect(readFileSync(entry, "utf8")).toBe("export const old = true;\n");
		expect(readFileSync(config, "utf8")).toBe(
			"export const operatorOwned = true;\n",
		);
		expect(existsSync(join(prefix, "board/recovery.ts"))).toBe(false);
		expect(existsSync(join(home, ".claude/local-llm/dashboard-state.ts"))).toBe(
			false,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
