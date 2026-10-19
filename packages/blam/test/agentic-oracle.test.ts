import { afterEach, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = join(import.meta.dir, "../bench/agentic");
const roots: string[] = [];

function score(root: string): { score: number; passed: number; total: number } {
	const p = Bun.spawnSync(["bun", join(source, "oracle.ts"), root], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = new TextDecoder().decode(p.stdout);
	if (!out.trim()) throw new Error(new TextDecoder().decode(p.stderr));
	return JSON.parse(out) as { score: number; passed: number; total: number };
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("Relay fixture has known failing baseline and a full-score reference", () => {
	const root = mkdtempSync(join(tmpdir(), "blam-relay-oracle-"));
	roots.push(root);
	cpSync(join(source, "fixture"), root, { recursive: true });
	const baseline = score(root);
	expect(baseline.total).toBe(22);
	expect(baseline.passed).toBe(7);
	for (const name of ["claim", "cache", "trace"])
		copyFileSync(
			join(source, "reference", `${name}.ts`),
			join(root, "src", `${name}.ts`),
		);
	expect(score(root)).toMatchObject({ score: 1, passed: 22, total: 22 });
});
