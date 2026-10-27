// test/lane-take-origin.test.ts — W1813: the `work take --origin host:agent`
// agent suffix is the SPAWNED adapter id (the identity launchToken registers,
// W1731) — never a hardcoded claude. A codex pick must stamp :codex.

import { expect, test } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { REPO, executor, tool, dispatchWith, cleanup } = dispatchHarness(
	test.afterAll,
	{
		tag: "w1813-origin",
		// the launch must SURVIVE so the claim (and its origin stamp) persists;
		// an exiting stub trips the launch-failure release path
		executorBody: "#!/usr/bin/env bun\nawait Bun.sleep(20000);\n",
	},
);

test.describe("lane take origin (W1813)", () => {
	test("a codex pick stamps the codex adapter into --origin", () => {
		const id =
			(tool("work.ts", "add", "origin adapter fixture").out.match(/W\d+/) ??
				[])[0] ?? "";
		expect(id).toBeTruthy();
		writeFileSync(join(REPO, ".prefer"), "prefer=codex\n");
		try {
			const result = dispatchWith(
				{ SUSPENDERS_CODEX_BIN: executor },
				"--item",
				id,
				"--allow-ungoverned",
			);
			for (const why of ["SKIP", "REFUSED", "WAIT"]) {
				expect(result.out).not.toContain(`${why} ${id}`);
			}
			const origin = String(
				JSON.parse(tool("work.ts", "show", id, "--json").out).origin,
			);
			expect(origin.endsWith(":codex")).toBe(true);
		} finally {
			rmSync(join(REPO, ".prefer"), { force: true });
			tool("work.ts", "fail", id);
		}
	}, 60_000);
});

void cleanup;
