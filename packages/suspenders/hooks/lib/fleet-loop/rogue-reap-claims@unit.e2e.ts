import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	pruneStaleWorktrees,
	worktreeItem,
	worktreeProtected,
} from "./rogue-reap.ts";

function pruneClaim(item: string, state: string) {
	const world = scratchWorld({ prefix: "reap-claims-" });
	try {
		const wt = join(world.repo, ".worktrees", item);
		const branch = `suspenders/${item}`;
		const calls: string[][] = [],
			lookups: string[] = [];
		const result = pruneStaleWorktrees({
			repo: world.repo,
			main: "main",
			act: true,
			git: (args) => {
				calls.push(args);
				if (args[0] === "worktree" && args[1] === "list")
					return {
						code: 0,
						out: `worktree ${wt}\nHEAD abc123\nbranch refs/heads/${branch}\n\n`,
					};
				return { code: 0, out: args[0] === "rev-list" ? "0" : "" };
			},
			protectedReason: (path) =>
				worktreeProtected(
					path,
					[],
					() => "dead",
					(id) => {
						lookups.push(id);
						return id === item ? state : "SHATTERED";
					},
				),
		});
		return { wt, branch, calls, lookups, result };
	} finally {
		world.clean();
	}
}

for (const item of ["W2990.7", "W2990.2.1"]) {
	for (const state of ["CLAIMED", "RUNNING"]) {
		test(`${state} child ${item} survives merged-clean pruning @unit`, () => {
			const { wt, branch, calls, lookups, result } = pruneClaim(item, state);
			expect(lookups).toEqual([item]);
			expect(result).toEqual([
				{
					worktree: wt,
					branch,
					action: "skipped",
					why: `item ${item} ${state}`,
				},
			]);
			expect(calls).toEqual([["worktree", "list", "--porcelain"]]);
		});
	}
}

test("unclaimed merged-clean dotted child still prunes with recovery ref @unit", () => {
	const { wt, calls, result, lookups } = pruneClaim("W2990.7", "DONE");
	expect(lookups).toEqual(["W2990.7"]);
	expect(result[0]?.action).toBe("removed");
	expect(calls).toContainEqual(["worktree", "remove", wt]);
	expect(calls).toContainEqual(["branch", "-d", "suspenders/W2990.7"]);
	expect(
		calls.some(
			(args) =>
				args[0] === "update-ref" && args[1]?.startsWith("refs/recover/"),
		),
	).toBe(true);
});

for (const [name, expected] of [
	["W373", "W373"],
	["W2990.7", "W2990.7"],
	["W2990.2.1", "W2990.2.1"],
	["w894-base", "W894"],
	["w123_candidate", "W123"],
	["w2990.7-baseline", "W2990"],
	["not-a-fleet-item", "not-a-fleet-item"],
]) {
	test(`claim identity for ${name} is ${expected} @unit`, () => {
		expect(worktreeItem(join("/tmp", name))).toBe(expected);
	});
}
