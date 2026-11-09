import { expect, test } from "@playwright/test";

test("Pi display text removes terminal controls and callback credentials @unit", async () => {
	const { plain, safeUrl } = await import(
		"../pi-extensions/fleet-awareness/safe-text.ts"
	);
	const key = ["bksk", "a".repeat(40)].join("_");
	expect(plain(`\u001b[31mready\u001b[0m\n${key}`)).toBe("ready [REDACTED]");
	expect(
		safeUrl(
			"https://user:private-value@fixture.invalid/path?token=private-value",
		),
	).toBe("https://fixture.invalid");
	expect(safeUrl("javascript:fixture")).toBe("unknown");
});
