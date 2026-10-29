// W2273 — memoProjectRoot: the board's poll paths resolve a project's
// primary checkout once per TTL instead of spawning git per request (the
// /api/tasks event-loop stall). Real git repo via the test kit.
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoProjectRoot, readLaneRegistry } from "./lane-registry.ts";

test("memoProjectRoot serves the cached root within the TTL and re-resolves after it @unit", () => {
	const world = scratchWorld({ prefix: "w2273-" });
	try {
		const sub = join(world.repo, "sub");
		mkdirSync(sub);
		const t0 = 1_000_000;
		const root = realpathSync(world.repo);
		expect(memoProjectRoot(sub, t0, 60_000)).toBe(root);
		// Without .git, a fresh resolve falls back to the input dir itself —
		// so an unchanged answer inside the TTL proves no git spawn happened.
		rmSync(join(world.repo, ".git"), { recursive: true, force: true });
		expect(memoProjectRoot(sub, t0 + 59_999, 60_000)).toBe(root);
		expect(memoProjectRoot(sub, t0 + 60_000, 60_000)).toBe(realpathSync(sub));
	} finally {
		world.clean();
	}
});

test("readLaneRegistry reads the primary checkout registry through the memo resolver @unit", () => {
	const world = scratchWorld({ prefix: "w2273-" });
	try {
		const sub = join(world.repo, "sub");
		mkdirSync(sub);
		mkdirSync(join(world.repo, ".fleet"));
		writeFileSync(
			join(world.repo, ".fleet", "lanes.json"),
			JSON.stringify([{ sid: "lane-a", item: "W1" }]),
		);
		const read = readLaneRegistry(sub, memoProjectRoot);
		expect(read.known).toBe(true);
		expect(read.lanes.map((l) => l.sid)).toEqual(["lane-a"]);
	} finally {
		world.clean();
	}
});
