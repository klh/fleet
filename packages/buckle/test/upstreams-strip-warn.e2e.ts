// test/upstreams-strip-warn.e2e.ts — W2598 N3: boot warn on non-string
// strip_body_fields entries (operator typo signal; entry strips nothing).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { loadUpstreams } from "../src/upstreams.ts";

test.describe("@unit", () => {
	test("warns on non-string strip entries, loads anyway", () => {
		// FIXTURE
		const world = scratchWorld({ prefix: "buckle-strip-warn-" });
		const path = join(world.repo, "upstreams.json");
		const row = (strip: unknown) => ({
			url: "http://127.0.0.1:4301",
			dialect: "anthropic",
			adapter_config: { strip_body_fields: strip },
		});
		const write = (strip: unknown) =>
			writeFileSync(
				path,
				JSON.stringify({ groups: { "claude-x": [row(strip)] } }),
			);
		const warns: string[] = [];
		const orig = console.warn;
		console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
		// ASSERT
		try {
			write(["thinking", 42, null]);
			const pool = loadUpstreams(path);
			expect(pool.groups()).toEqual(["claude-x"]);
			expect(warns.filter((w) => w.includes("42"))).toHaveLength(1);
			expect(warns.filter((w) => w.includes("null"))).toHaveLength(1);
			warns.length = 0;
			write(["thinking", "effort"]);
			loadUpstreams(path);
			expect(warns).toHaveLength(0);
		} finally {
			console.warn = orig;
			world.clean();
		}
	});
});
