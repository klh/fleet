import { expect, test } from "bun:test";
import { isResumableClaim } from "./resumable-claim.ts";

test("current work show header permits the exact owner's unfinished claim", () => {
	const output =
		"◐ W517 CLAIMED  feature: .prefer discovery\n  owner_sid: autow517\n  description: state: DONE is an example\n";
	expect(isResumableClaim(output, "W517", "autow517")).toBe(true);
	expect(
		isResumableClaim(output.replace("CLAIMED", "RUNNING"), "W517", "autow517"),
	).toBe(true);
});

test("colors and hierarchical work IDs preserve exact identity", () => {
	const output =
		"\u001b[33m◐\u001b[0m W494.2 \u001b[33mCLAIMED\u001b[0m fix\n  \u001b[2mowner_sid:\u001b[0m autow494-2\n";
	expect(isResumableClaim(output, "W494.2", "autow494-2")).toBe(true);
});

test("closed state and absent or different owners never resume", () => {
	for (const state of ["DONE", "READY", "SUPERSEDED", "BLOCKED", "ORPHANED"]) {
		expect(
			isResumableClaim(
				`◐ W517 ${state} title\n  owner_sid: autow517`,
				"W517",
				"autow517",
			),
		).toBe(false);
	}
	expect(
		isResumableClaim(
			"◐ W517 CLAIMED title\n  owner_sid: autow5170",
			"W517",
			"autow517",
		),
	).toBe(false);
	expect(
		isResumableClaim("◐ W517 CLAIMED title autow517", "W517", "autow517"),
	).toBe(false);
	expect(
		isResumableClaim(
			"◐ W518 CLAIMED title\n  owner_sid: autow517",
			"W517",
			"autow517",
		),
	).toBe(false);
});

test("a description mentioning CLAIMED and the sid cannot impersonate state", () => {
	expect(
		isResumableClaim(
			"✓ W517 DONE title\n  description: state: CLAIMED by autow517",
			"W517",
			"autow517",
		),
	).toBe(false);
	expect(isResumableClaim("error reading work graph", "W517", "autow517")).toBe(
		false,
	);
});
