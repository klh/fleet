// verb-kit-version.e2e.ts — the W2551 --version face: every runCli door
// answers --version with ONE stable, machine-parsable line, exit 0, before
// any parsing that could create state — and the embedded dispatch door
// (the one process door that bypasses runCli) carries the same wiring.
// Spec-shape law: no TS annotations.
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { versionLine } from "../hooks/lib/cli-version.ts";
import { GOVDB_SCHEMA_VERSION } from "../hooks/lib/govdb/schema-version.ts";

const BUN = process.execPath;
const COORD_BIN = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DISPATCH_BIN = join(import.meta.dir, "..", "scripts", "dispatch-next.ts");
const LINE_RE = /^coord revision=\S+ schema=\d+$/;

test.describe("@unit", () => {
	test("versionLine renders one machine-parsable line with the schema tip", () => {
		const line = versionLine("coord");
		expect(line).toMatch(LINE_RE);
		expect(line).toContain(`schema=${GOVDB_SCHEMA_VERSION}`);
	});

	test("runCli doors answer --version with the line, exit 0", () => {
		for (const argv of [["--version"]]) {
			const proc = spawnSync(BUN, [COORD_BIN, ...argv], {
				encoding: "utf8",
			});
			expect(proc.status).toBe(0);
			expect(proc.stdout.trim()).toMatch(LINE_RE);
		}
	});

	test("lax verbs keep --version for their own dissection (consult)", () => {
		const proc = spawnSync(
			BUN,
			[
				COORD_BIN,
				"consult",
				"no-such-sid",
				"q",
				"--as",
				"no-such-asker",
				"--version",
				"test-version",
			],
			{ encoding: "utf8" },
		);
		expect(proc.stdout).not.toContain("revision=");
	});

	test("the dispatch embedded door answers --version (exit 0)", () => {
		const proc = spawnSync(BUN, [DISPATCH_BIN, "--version"], {
			encoding: "utf8",
		});
		expect(proc.status).toBe(0);
		expect(proc.stdout.trim()).toMatch(/^dispatch revision=\S+ schema=\d+$/);
	});
});
