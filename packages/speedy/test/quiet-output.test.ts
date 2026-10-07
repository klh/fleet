import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyQuietOutput, quietDefaults } from "../bin/quiet-output.ts";

const homes: string[] = [];
function fixture(): string {
	const home = mkdtempSync(join(tmpdir(), "fleet-quiet-output-"));
	homes.push(home);
	return join(home, "settings.json");
}
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

describe("quiet Claude presentation settings", () => {
	test("preserves governance, providers and an existing output style", () => {
		const path = fixture();
		const original = {
			hooks: { Stop: [{ command: "gate stop" }] },
			permissions: { defaultMode: "acceptEdits" },
			env: { ANTHROPIC_BASE_URL: "https://gateway.invalid" },
			outputStyle: "Custom",
			model: "model",
			unknownFutureSetting: { keep: true },
			tui: "classic",
			verbose: true,
		};
		writeFileSync(path, JSON.stringify(original));
		applyQuietOutput(path);
		const actual = JSON.parse(readFileSync(path, "utf8"));
		expect(actual).toEqual({ ...original, ...quietDefaults });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const first = readFileSync(path, "utf8");
		applyQuietOutput(path);
		expect(readFileSync(path, "utf8")).toBe(first);
	});
	test("creates a new protected settings object", () => {
		const path = fixture();
		applyQuietOutput(path);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(quietDefaults);
	});
	test.each(["broken json", "[]", "null", '"string"'])(
		"refuses malformed settings without overwriting: %s",
		(value) => {
			const path = fixture();
			writeFileSync(path, value);
			expect(() => applyQuietOutput(path)).toThrow();
			expect(readFileSync(path, "utf8")).toBe(value);
		},
	);
	test("refuses symlink settings and preserves the target", () => {
		const path = fixture();
		const target = `${path}.original`;
		writeFileSync(target, "{}");
		symlinkSync(target, path);
		expect(() => applyQuietOutput(path)).toThrow("regular file");
		expect(readFileSync(target, "utf8")).toBe("{}");
	});
	test("CLI preview and help are read-only", () => {
		const path = fixture();
		const cli = join(import.meta.dir, "../bin/quiet-output.ts");
		for (const args of [["--help"], ["--settings", path]]) {
			const result = Bun.spawnSync(["bun", cli, ...args]);
			expect(result.exitCode).toBe(0);
			expect(existsSync(path)).toBe(false);
		}
	});
	test("does not replace a dangling settings symlink", () => {
		const path = fixture();
		symlinkSync(`${path}.missing`, path);
		expect(() => applyQuietOutput(path)).toThrow("regular file");
	});
	test("standalone installable skill helper applies its settings", () => {
		const path = fixture();
		const cli = join(
			import.meta.dir,
			"../skills/quiet-work/scripts/quiet-output.ts",
		);
		const result = Bun.spawnSync(["bun", cli, "--apply", "--settings", path]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual(quietDefaults);
	});
});
