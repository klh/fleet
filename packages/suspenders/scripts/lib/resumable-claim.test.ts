import { expect, test } from "bun:test";
import { isResumableClaim } from "./resumable-claim.ts";

test("structured claimed/running records preserve exact item and owner", () => {
	for (const state of ["CLAIMED", "RUNNING"]) {
		const output = JSON.stringify({
			id: "W494.2",
			state,
			owner_sid: "autow494-2",
			description: "state: DONE",
		});
		expect(isResumableClaim(output, "W494.2", "autow494-2")).toBe(true);
		expect(isResumableClaim(output, "W494", "autow494-2")).toBe(false);
		expect(isResumableClaim(output, "W494.2", "autow494")).toBe(false);
	}
});
test("closed or unowned records never resume", () => {
	for (const state of ["DONE", "READY", "SUPERSEDED", "BLOCKED", "ORPHANED"]) {
		expect(
			isResumableClaim(
				JSON.stringify({
					id: "W517",
					state,
					owner_sid: "autow517",
					description: "CLAIMED autow517",
				}),
				"W517",
				"autow517",
			),
		).toBe(false);
	}
	for (const owner_sid of [null, "autow5170"]) {
		expect(
			isResumableClaim(
				JSON.stringify({ id: "W517", state: "CLAIMED", owner_sid }),
				"W517",
				"autow517",
			),
		).toBe(false);
	}
});
test("display text and malformed JSON fail closed", () => {
	for (const output of [
		"◐ W517 CLAIMED title owner_sid: autow517",
		"error",
		"null",
		"[]",
		"{}",
		'{"id":',
	]) {
		expect(isResumableClaim(output, "W517", "autow517")).toBe(false);
	}
});
