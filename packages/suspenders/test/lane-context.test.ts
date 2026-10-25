// test/lane-context.test.ts — W628: the lane activation context file
// (.fleet/lane-context.json) rebinds to the kept child inside split's
// transaction. Unit coverage for the file helpers; the CLI-level rebind rides
// work-cli.test.ts's split suite and the completion-time warning rides
// work-completion-record.test.ts.

import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	keptLaneContextDirs,
	laneContextFile,
	readLaneContextFile,
	rebindLaneContext,
} from "../hooks/lib/lanes/lane-context.ts";

const dir = mkdtempSync(join(tmpdir(), "w628-lane-context-"));
mkdirSync(join(dir, ".fleet"), { recursive: true });
const contextPath = laneContextFile(dir);
const writeContext = (value: unknown): void =>
	writeFileSync(contextPath, JSON.stringify(value));

describe("rebindLaneContext (W628)", () => {
	test("rewrites item to the kept child and preserves the rest", () => {
		writeContext({ sid: "lane-a", item: "W1", baseline: "abc", launchedAt: 7 });
		expect(rebindLaneContext(dir, "lane-a", "W1", "W1.1")).toBe("W1.1");
		const context = JSON.parse(readFileSync(contextPath, "utf8"));
		expect(context).toEqual({
			sid: "lane-a",
			item: "W1.1",
			baseline: "abc",
			launchedAt: 7,
		});
	});

	test("a foreign sid or item is refused and the file is untouched", () => {
		for (const context of [
			{ sid: "other", item: "W1" },
			{ sid: "lane-a", item: "W2" },
		]) {
			writeContext(context);
			expect(rebindLaneContext(dir, "lane-a", "W1", "W1.1")).toBeNull();
			expect(JSON.parse(readFileSync(contextPath, "utf8"))).toEqual(context);
		}
	});

	test("missing or corrupt context files return null untouched", () => {
		rmSync(contextPath);
		expect(rebindLaneContext(dir, "lane-a", "W1", "W1.1")).toBeNull();
		writeFileSync(contextPath, "not json");
		expect(readLaneContextFile(dir)).toBeNull();
		expect(rebindLaneContext(dir, "lane-a", "W1", "W1.1")).toBeNull();
	});
});

test("keptLaneContextDirs: cwd first, then the parent worktree, deduped", () => {
	// a non-repo root: the git worktree lookup fails open to the conventional
	// .worktrees/<parent> path, which does not exist here — cwd alone survives
	const root = mkdtempSync(join(tmpdir(), "w628-not-a-repo-"));
	const dirs = keptLaneContextDirs(dir, root, "W404");
	expect(dirs[0]).toBe(dir);
	expect(dirs).toEqual([dir]);
	rmSync(root, { recursive: true, force: true });
});
