// W1831 — the claude executor's managed-runtime entrypoint must resolve on
// disk. The merge that produced 043636c6 was flagged for a dangling
// hooks/lib/executors/claude-runtime.ts path; the adapter actually joins up
// to hooks/bin/claude-runtime.ts, so this pins the resolved entrypoint to an
// existing file (regression guard against future join drift).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { claudeAdapter } from "../hooks/lib/executors/claude.ts";
import { adapterFor } from "../hooks/lib/executors/registry.ts";

test.describe("@unit", () => {
	test("claude managed runtime entrypoint resolves to the real file", () => {
		const here = dirname(resolve(import.meta.path));
		// the adapter computes the path relative to hooks/lib/executors/
		const executorsDir = resolve(here, "../hooks/lib/executors");
		const expected = join(executorsDir, "..", "..", "bin", "claude-runtime.ts");
		expect(claudeAdapter.managedRuntime?.entrypoint).toBe(expected);
		expect(existsSync(expected)).toBe(true);
	});

	test("adapterFor(\"claude\") serves the same resolvable entrypoint", () => {
		const adapter = adapterFor("claude");
		expect(adapter).toBe(claudeAdapter);
		expect(adapter.managedRuntime?.entrypoint.endsWith("claude-runtime.ts")).toBe(
			true,
		);
		expect(existsSync(adapter.managedRuntime?.entrypoint ?? "")).toBe(true);
	});
});
