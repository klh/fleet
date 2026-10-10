import { expect, test } from "bun:test";
import { recoverableClaims } from "../scripts/lib/claim-recovery.ts";

test("only old, unregistered automatic claims are recovery candidates", () => {
	const now = 2_000_000;
	const row = {
		id: "W1",
		owner_sid: "autow1",
		state: "CLAIMED",
		title: "repair",
		updated_at: 1,
		origin: "this-host:claude",
	};
	const rows = [
		row,
		{ ...row, id: "W2", owner_sid: "autow2" },
		{ ...row, id: "W3", owner_sid: "interactive-owner" },
		{ ...row, id: "W4", updated_at: now },
		{ ...row, id: "W5", state: "FAILED" },
		{ ...row, id: "W6", title: "owner decision" },
		{ ...row, id: "W7", updated_at: "bad" },
		{ ...row, id: "W8", origin: "other-host:claude" },
	];
	expect(
		recoverableClaims(
			rows,
			new Set(["autow2"]),
			now,
			(t) => t === "owner decision",
			(o) => o.startsWith("this-host:"),
		),
	).toEqual([row]);
	expect(
		recoverableClaims(
			{},
			new Set(),
			now,
			() => false,
			() => false,
		),
	).toEqual([]);
});
