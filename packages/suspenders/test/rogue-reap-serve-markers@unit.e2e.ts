// rogue-reap-serve-markers@unit.e2e.ts — 2026-10-29 incident: knowledge-api
// and its health probe, launched by a lane from .worktrees/W2214, survived
// every rogue-reap cycle because no SERVE_MARKER matched them. A dead lane's
// leaked knowledge-api/probe serves are reaped; the installed (non-worktree)
// knowledge-api service and a live lane's serve are left alone.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRogueReap } from "../hooks/lib/fleet-loop/rogue-reap.ts";

const repo = mkdtempSync(join(tmpdir(), "reap-markers-"));
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));

const ps = [
	`  101     1 bun ${repo}/.worktrees/W2214/packages/suspenders/hooks/bin/knowledge-api.ts`,
	`  102     1 bun ${repo}/.worktrees/W2214/packages/suspenders/deploy/healthcheck/probe.ts`,
	"  103     1 bun /home/u/.claude/hooks/suspenders/hooks/bin/knowledge-api.ts",
	`  104     1 bun ${repo}/.worktrees/W9000/packages/suspenders/hooks/bin/knowledge-api.ts`,
].join("\n");
const cwd = {
	101: `${repo}/.worktrees/W2214`,
	102: `${repo}/.worktrees/W2214`,
	103: "/home/u",
	104: `${repo}/.worktrees/W9000`,
};

test("dead-lane knowledge-api + probe serves are reaped; installed + live-lane serves survive", () => {
	const killed = [];
	createRogueReap({
		repo,
		act: true,
		psOut: () => ps,
		launchctlList: () => "",
		cwdOf: (pid) => cwd[pid] ?? null,
		lanes: () => [
			{ sid: "lane-live", item: "W9000", worktree: `${repo}/.worktrees/W9000` },
		],
		verdictOf: (l) => (l.item === "W9000" ? "alive" : "dead"),
		claimState: (item) => (item === "W9000" ? "CLAIMED" : null),
		git: () => ({ code: 0, out: "" }),
		kill: (pid) => {
			killed.push(pid);
			return true;
		},
		statePath: join(repo, "state.json"),
		log: () => {},
	}).reap();
	expect(killed.sort()).toEqual([101, 102]);
});
