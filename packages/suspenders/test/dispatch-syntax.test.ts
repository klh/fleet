import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { probeDispatchSyntax } from "../scripts/lib/dispatch-syntax.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fleet-syntax-"));
	roots.push(root);
	const repo = join(root, "repo");
	const prefix = join(root, "prefix");
	const entries = [
		join(repo, "packages/suspenders/scripts/dispatch-next.ts"),
		join(repo, "packages/suspenders/hooks/bin/fleet-loop.ts"),
		join(prefix, "bin/fleet-loop.ts"),
	];
	for (const entry of entries) {
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, 'throw new Error("dispatch must never execute");\n');
	}
	return { repo, prefix, entries };
}
test("valid source and installed entries compile without executing them", () => {
	const f = fixture();
	expect(probeDispatchSyntax(f.repo, f.prefix)).toEqual({
		ok: true,
		sourceBroken: false,
		failures: [],
	});
});
test("unresolved source conflict markers fail even with valid installed copies", () => {
	const f = fixture();
	writeFileSync(
		f.entries[0],
		"<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> lane\n",
	);
	const result = probeDispatchSyntax(f.repo, f.prefix);
	expect(result.ok).toBe(false);
	expect(result.sourceBroken).toBe(true);
	expect(result.failures[0]).toContain(f.entries[0]);
});
test("installed dependency failure is observable while source stays valid", () => {
	const f = fixture();
	writeFileSync(f.entries[2], 'import "./missing-helper.ts";\n');
	const result = probeDispatchSyntax(f.repo, f.prefix);
	expect(result.ok).toBe(false);
	expect(result.sourceBroken).toBe(false);
	expect(result.failures[0]).toContain(f.entries[2]);
});
