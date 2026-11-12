import { expect, test } from "@playwright/test";
import { phase0ExitCode } from "../deploy/phase0-rehearsal/verify.ts";

const rehearsal = { name: "stream", ok: true };
const revocation = { name: "revocation", ok: true };
const down = { name: "compose-down", ok: true };

test("passes when rehearsal and teardown succeed", () => {
	expect(phase0ExitCode(0, [rehearsal, revocation, down])).toBe(0);
});

test("fails when revocation fails after a successful rehearsal", () => {
	expect(
		phase0ExitCode(0, [rehearsal, { ...revocation, ok: false }, down]),
	).toBe(1);
});

test("fails when stack removal fails after a successful rehearsal", () => {
	expect(
		phase0ExitCode(0, [rehearsal, revocation, { ...down, ok: false }]),
	).toBe(1);
});

test("keeps the rehearsal failure when teardown succeeds", () => {
	expect(phase0ExitCode(1, [revocation, down])).toBe(1);
});
