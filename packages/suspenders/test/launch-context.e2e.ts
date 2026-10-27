// test/launch-context.test.ts — W1240: the launch-context read model.
// The brief is served VERBATIM (the raw bytes dispatch wrote to
// .fleet/brief-<sid>.md); items without a stored brief fall back to their
// own labeled raw fields; items with neither report an honest "none".
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	briefFileFor,
	launchContextForItem,
} from "../hooks/board/launch-context.ts";

// briefFileFor/launchContextForItem resolve the brief through
// canonicalProjectRoot (git spawn). Point it at a throwaway git repo so the
// test never touches the real fleet checkout — and never the live .fleet.
const HOME = mkdtempSync(join(tmpdir(), "launch-context-test-"));
const ROOT = join(HOME, "repo");
mkdirSync(ROOT, { recursive: true });
Bun.spawnSync(["git", "-C", ROOT, "init", "-q"]);

const item = (over: Record<string, unknown> = {}) => ({
	project: ROOT,
	owner_sid: "sid-a" as string | null,
	description: "the raw description",
	alloc_reason: "manual take",
	why_parallel: null as string | null,
	...over,
});

test("stored brief is served verbatim, byte for byte", () => {
	const brief = "You are lane sid-a.\n\nMISSION: the raw mission text\n";
	mkdirSync(join(ROOT, ".fleet"), { recursive: true });
	writeFileSync(briefFileFor(ROOT, "sid-a"), brief);
	const r = launchContextForItem(item(), ["W1"]);
	expect(r.source).toBe("brief");
	expect(r.sid).toBe("sid-a");
	expect(r.text).toBe(brief); // string equality — the whole point
});

test("item fallback: labeled raw fields when no brief is stored", () => {
	const r = launchContextForItem(item({ owner_sid: "sid-b" }), ["W1", "W2"]);
	expect(r.source).toBe("item");
	expect(r.text).toBe(
		"[description] the raw description\n[alloc_reason] manual take\n[depends] W1, W2",
	);
});

test("none: no brief and no fields is an honest none", () => {
	const r = launchContextForItem(
		item({ owner_sid: "sid-c", description: null, alloc_reason: null }),
		[],
	);
	expect(r.source).toBe("none");
	expect(r.text).toBe("");
});

test("unclaimed item: never reads a brief, still speaks its fields", () => {
	const r = launchContextForItem(item({ owner_sid: null }), []);
	expect(r.source).toBe("item");
	expect(r.text).toBe(
		"[description] the raw description\n[alloc_reason] manual take",
	);
});

test.afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});
