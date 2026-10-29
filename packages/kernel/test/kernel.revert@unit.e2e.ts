// kernel.revert.test.ts — W1868: behavior pin for the promoted C156 revert
// classifier + landing rule. The twins were DELETED in the same landing
// (W1476 review-evals.ts, W1477 review-guardrail.ts), so there is no
// byte-parity block in kernel.twin-parity.test.ts — this file is the pin.
import { describe, expect, test } from "@playwright/test";
import {
	classifyRevert,
	isRevertLanding,
} from "../src/kernel.revert.module.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

describe("kernel revert: C156 classifier", () => {
	test("named body hex wins over the subject", () => {
		expect(
			classifyRevert('Revert "W1 add x"', `This reverts commit ${sha}.\n`),
		).toEqual({ reverts: sha });
		expect(
			classifyRevert("Back out the board storm", `This reverts commit ${sha}.`),
		).toEqual({ reverts: sha });
	});

	test("subject-only revert keeps reverts null", () => {
		expect(classifyRevert('Revert "W1 add x"', "")).toEqual({ reverts: null });
	});

	test("re-lands classify null", () => {
		expect(
			classifyRevert(
				'Revert "Revert "W1 add x""',
				`This reverts commit ${sha}.`,
			),
		).toBeNull();
		expect(
			classifyRevert('Reapply "W1 add x"', `This reverts commit ${sha}.`),
		).toBeNull();
	});

	test("plain commits are not reverts", () => {
		expect(
			classifyRevert("W2 teach the reverter", 'prose about Revert "x"'),
		).toBeNull();
		expect(
			classifyRevert("Revert BELT_TIER default to minimal", "restore tier"),
		).toBeNull();
		expect(classifyRevert("Merge branch 'suspenders/W1'", "")).toBeNull();
	});
});

describe("kernel revert: landing rule (injected ancestor predicate)", () => {
	test("named revert counts when the target passes the predicate", () => {
		expect(
			isRevertLanding(
				'Revert "W1 add x"',
				`This reverts commit ${sha}.`,
				() => true,
			),
		).toEqual({ reverts: sha });
	});

	test("branch-internal undo drops when the predicate refuses", () => {
		expect(
			isRevertLanding(
				'Revert "W1 add x"',
				`This reverts commit ${sha}.`,
				() => false,
			),
		).toBeNull();
	});

	test("subject-only revert counts unconditionally", () => {
		expect(
			isRevertLanding('Revert "W1 add x"', "", () => false),
		).toEqual({ reverts: null });
		expect(
			isRevertLanding('Revert "W1 add x"', "", () => true),
		).toEqual({ reverts: null });
	});

	test("re-lands never reach the predicate", () => {
		let asked = false;
		expect(
			isRevertLanding('Reapply "W1 add x"', `This reverts commit ${sha}.`, () => {
				asked = true;
				return true;
			}),
		).toBeNull();
		expect(asked).toBe(false);
	});
});
