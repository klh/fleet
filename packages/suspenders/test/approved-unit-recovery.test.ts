// test/approved-unit-recovery.test.ts — W2177: a reviewed buckle unit that
// vanished from LaunchAgents recovers ONLY from a staged proposal whose
// candidate re-hashes to the receipt's approved sha for the same unit.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverApprovedUnit } from "../scripts/lib/approved-unit-recovery.ts";

const unit = "/fake/Library/LaunchAgents/com.suspenders.buckle-spoke.plist";
const sha = (s: string): string =>
	new Bun.CryptoHasher("sha256").update(s).digest("hex");
const dirs: string[] = [];
const reviewDir = (proposals: Record<string, unknown>): string => {
	const dir = mkdtempSync(join(tmpdir(), "w2177-review-"));
	dirs.push(dir);
	for (const [name, body] of Object.entries(proposals))
		writeFileSync(
			join(dir, name),
			typeof body === "string" ? body : JSON.stringify(body),
		);
	return dir;
};

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("W2177 recoverApprovedUnit", () => {
	test("returns the candidate whose bytes hash to the approved sha", () => {
		const approved = "<plist>approved</plist>";
		const dir = reviewDir({
			"a.json": { unit, candidate: "<plist>other</plist>" },
			"b.json": { unit, candidate: approved },
		});
		expect(recoverApprovedUnit(dir, unit, sha(approved))).toBe(approved);
	});

	test("refuses a matching hash staged for a different destination", () => {
		const approved = "<plist>approved</plist>";
		const dir = reviewDir({
			"a.json": { unit: "/elsewhere.plist", candidate: approved },
		});
		expect(recoverApprovedUnit(dir, unit, sha(approved))).toBeUndefined();
	});

	test("skips unreadable proposals and returns undefined on no match", () => {
		const dir = reviewDir({
			"bad.json": "{not json",
			"a.json": { unit, candidate: "<plist>other</plist>" },
		});
		expect(recoverApprovedUnit(dir, unit, sha("x"))).toBeUndefined();
	});

	test("a missing review directory is no match, not a crash", () => {
		expect(
			recoverApprovedUnit(join(tmpdir(), "w2177-absent-dir"), unit, sha("x")),
		).toBeUndefined();
	});
});
