// spawner.test.ts — W508 kit↔belt spawner DRY contract, behaviorized
// (W1135.2): the kit module must re-export belt's lifecycle at RUNTIME —
// module identity, not source text. belt/bin/spawner.ts is the single
// source; the flat runtime home flattens it so the relative re-export
// resolves there (the heal itself is covered behaviorally by
// suspenders/test/belt-bin-overlay-flat-home.test.ts).
import { describe, expect, test } from "bun:test";

import * as belt from "../belt/bin/spawner.ts";
import * as kit from "./spawner.ts";

describe("kit spawner is belt's lifecycle at runtime", () => {
	test("every belt export is re-exported with belt identity", () => {
		for (const [name, value] of Object.entries(belt)) {
			expect((kit as Record<string, unknown>)[name]).toBe(value);
		}
		// a resurrection as a twin would break identity on the lifecycle
		expect(kit.ensureUp).toBe(belt.ensureUp);
		expect(kit.spawnReserved).toBe(belt.spawnReserved);
	});

	test("belt/bin/spawner.ts exposes the lifecycle surface", () => {
		expect(typeof belt.ensureUp).toBe("function");
		expect(typeof belt.spawnReserved).toBe("function");
	});
});

// W771.3: the closure heal itself (the W661 flatten walk + smoke self-check
// in install-llm-steps.ts) is behavior-covered by
// suspenders/test/belt-bin-overlay-flat-home.test.ts — no grep here.
