import { expect, test } from "@playwright/test";
import { effectiveMemoryBytes, freshWiredGuardGb } from "./belt-wired-guard.ts";

test("fresh wired guard uses the smaller host or container memory limit @unit", () => {
	const gib = 1024 ** 3;
	expect(effectiveMemoryBytes(128 * gib, ["max", String(8 * gib)])).toBe(
		8 * gib,
	);
	expect(freshWiredGuardGb(128 * gib, ["max", String(8 * gib)])).toBe("4");
	expect(freshWiredGuardGb(16 * gib, [String(64 * gib)])).toBe("8");
	expect(freshWiredGuardGb(gib, ["invalid"])).toBe("0.5");
});
