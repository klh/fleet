import { expect, test } from "@playwright/test";

test("Sphinx replay image selection requires an immutable operator pin @unit", async () => {
	const exports = await import("../bench/sphinx/replay-sandbox.ts");
	const schema = Reflect.get(exports, "ReplayImageSchema");
	expect(
		schema,
		"Replay image selection must have a runtime contract",
	).toBeDefined();
	const pinned = `swebench/test-case@sha256:${"a".repeat(64)}`;
	expect(schema.parse(pinned)).toBe(pinned);
	expect(schema.parse(undefined)).toMatch(/sphinx-9461@sha256:/);
	for (const invalid of [
		"latest",
		"image:tag",
		"",
		`--privileged@sha256:${"a".repeat(64)}`,
	])
		expect(schema.safeParse(invalid).success).toBe(false);
});
