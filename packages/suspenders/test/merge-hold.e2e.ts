// merge-hold.test.ts — W1302.1: the operator merge hold as a contract (A2).
// Pure predicate coverage for readMergeHold/mergeHoldActive: the hold file
// must carry owner/reason/expiresAt, expire within the 7-day cap, and only a
// present, well-formed, unexpired hold reads active. The controller-side
// enforcement (set-aside + NEED_DECISION + sweep release) is proven at the
// flush level in fleet-loop-flush.test.ts; these tests pin the validation
// itself, including both expiresAt spellings (ISO string, epoch ms).
import { expect, test } from "./pw";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeHoldActive,
	readMergeHold,
} from "../hooks/lib/fleet-loop/merge-hold.ts";

const hold = (repo: string, body: string) => {
	mkdirSync(join(repo, ".fleet"), { recursive: true });
	writeFileSync(join(repo, ".fleet", "merge-hold"), body);
};

const validBody = (over: Record<string, unknown> = {}): string =>
	JSON.stringify({
		owner: "op",
		reason: "manual integration",
		expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
		...over,
	});

test.describe("merge-hold contract (W1302.1)", () => {
	const repo = join(
		tmpdir(),
		`w1302-hold-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);

	test("absent file reads none / inactive", () => {
		expect(readMergeHold(repo).state).toBe("none");
		expect(mergeHoldActive(repo)).toBe(false);
	});

	test("valid hold (ISO expiresAt) reads active", () => {
		hold(repo, validBody());
		expect(readMergeHold(repo).state).toBe("active");
		expect(mergeHoldActive(repo)).toBe(true);
	});

	test("valid hold (epoch-ms expiresAt) reads active", () => {
		hold(repo, validBody({ expiresAt: Date.now() + 3_600_000 }));
		expect(readMergeHold(repo).state).toBe("active");
	});

	test("expired hold reads expired / inactive", () => {
		hold(
			repo,
			validBody({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
		);
		const view = readMergeHold(repo);
		expect(view.state).toBe("expired");
		if (view.state === "expired") {
			expect(view.hold.owner).toBe("op");
			expect(view.hold.expiresAt).toBeLessThanOrEqual(Date.now());
		}
		expect(mergeHoldActive(repo)).toBe(false);
	});

	test("empty pre-W1302.1 marker is malformed (not valid JSON)", () => {
		hold(repo, "");
		expect(readMergeHold(repo)).toMatchObject({
			state: "malformed",
			why: "not valid JSON",
		});
		expect(mergeHoldActive(repo)).toBe(false);
	});

	test("missing owner is malformed", () => {
		hold(
			repo,
			JSON.stringify({ reason: "r", expiresAt: new Date().toISOString() }),
		);
		expect(readMergeHold(repo)).toMatchObject({
			state: "malformed",
			why: "missing owner",
		});
	});

	test("missing reason is malformed", () => {
		hold(
			repo,
			JSON.stringify({ owner: "op", expiresAt: new Date().toISOString() }),
		);
		expect(readMergeHold(repo)).toMatchObject({
			state: "malformed",
			why: "missing reason",
		});
	});

	test("missing/invalid expiresAt is malformed", () => {
		hold(repo, validBody({ expiresAt: undefined }));
		expect(readMergeHold(repo)).toMatchObject({
			state: "malformed",
			why: "missing or invalid expiresAt",
		});
		hold(repo, validBody({ expiresAt: "not-a-date" }));
		expect(readMergeHold(repo)).toMatchObject({
			state: "malformed",
			why: "missing or invalid expiresAt",
		});
	});

	test("expiresAt beyond the 7-day cap is malformed", () => {
		hold(
			repo,
			validBody({
				expiresAt: new Date(Date.now() + 8 * 86_400_000).toISOString(),
			}),
		);
		expect(readMergeHold(repo)).toMatchObject({
			state: "malformed",
			why: "expiresAt beyond the 7-day hold cap",
		});
		expect(mergeHoldActive(repo)).toBe(false);
	});

	test("non-object JSON is malformed", () => {
		hold(repo, '"just a string"');
		expect(readMergeHold(repo)).toMatchObject({
			state: "malformed",
			why: "not a JSON object",
		});
	});

	// W1302.1.1: cleanup belongs in test.afterAll — a bare rmSync at test.describe
	// scope runs at COLLECTION time (before any test) and leaks the tmpdir.
	test.afterAll(() => {
		rmSync(repo, { recursive: true, force: true });
	});
});
