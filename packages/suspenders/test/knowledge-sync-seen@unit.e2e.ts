// knowledge-sync-seen@unit.e2e.ts — hub design D8: lesson.seen.<sid> is
// session-start bookkeeping, never knowledge; it must not cross the sync.
import { expect, test } from "@playwright/test";
import { SYNCABLE_FACT } from "../hooks/lib/knowledge/knowledge-sync.ts";

test("lesson.seen.* never syncs; real lessons and findings do", () => {
	expect(SYNCABLE_FACT.test("lesson.seen.4ffc627b")).toBe(false);
	expect(SYNCABLE_FACT.test("lesson.oracle-local-leg")).toBe(true);
	expect(SYNCABLE_FACT.test("lesson.seenery")).toBe(true);
	expect(SYNCABLE_FACT.test("finding.x")).toBe(true);
	expect(SYNCABLE_FACT.test("claim.x")).toBe(false);
});
