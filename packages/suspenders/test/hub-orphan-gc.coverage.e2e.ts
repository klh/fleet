// test/hub-orphan-gc.coverage.e2e.ts — W2660 coverage-proof for the W2321.5
// hub orphan GC. The unit suite (hub-orphan-gc.e2e.ts) exercises every leg
// with injected execs; this file runs the REAL pipeline end-to-end with NO
// injection: a REAL scratch git repo (kit scratchWorld) with REAL
// `git worktree add` lane trees carrying the .fleet/lane-context.json origin
// marker, driven through the REAL listScript → /bin/sh -c →
// parseHubGcListing → gcHub classification. Revert hub-orphan-gc.ts and
// every test here goes red — there is no listScript to run, no marker
// probe inside it, and no classification to observe. This is the
// no-coverage FAIL the W2645 review demanded the fix prove.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	gcHub,
	type HubGcTarget,
	listScript,
	parseHubGcListing,
	shQuote,
} from "../hooks/lib/fleet-loop/hub-orphan-gc.ts";

/** The REAL local exec face — /bin/sh -c against the scratch repo, exactly
 * the shape realGcExec uses for a local (desktop) hub. No injection. */
const shExec = (cwd: string, env: Record<string, string | undefined>) => {
	return (_t: HubGcTarget, script: string): { code: number; out: string } => {
		const p = Bun.spawnSync(["/bin/sh", "-c", script], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`;
		return { code: p.exitCode ?? 1, out };
	};
};

test.describe("@unit", () => {
	test("real pipeline: marker worktree discovered, classified, protected by live claim", () => {
		const world = scratchWorld({ prefix: "klh-gc-proof-" });
		try {
			// a lane worktree under the scratch repo carrying the marker,
			// plus an UNMARKED sibling that must never enter the listing
			const wt = join(world.repo, ".worktrees", "W777");
			const g = (args: string[]) =>
				Bun.spawnSync(["git", ...args], {
					cwd: world.repo,
					env: world.env,
					stdout: "ignore",
					stderr: "ignore",
				});
			expect(
				g(["worktree", "add", "-q", "-b", "suspenders/W777", wt]).exitCode,
			).toBe(0);
			mkdirSync(join(wt, ".fleet"), { recursive: true });
			writeFileSync(
				join(wt, ".fleet", "lane-context.json"),
				'{"sid":"x","item":"W777"}',
			);
			// commit the marker so the tree reads CLEAN — the reapable shape
			// (a live lane's untracked marker reads dirty and is protected)
			g([
				"-C",
				wt,
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"add",
				".fleet",
			]);
			g([
				"-C",
				wt,
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"-qm",
				"lane marker",
			]);
			expect(
				g([
					"worktree",
					"add",
					"-q",
					"-b",
					"suspenders/W888",
					join(world.repo, ".worktrees", "W888"),
				]).exitCode,
			).toBe(0);
			const target: HubGcTarget = { name: "scratch", repoRoot: world.repo };
			const exec = shExec(world.repo, world.env);
			// the listing leg itself, against real git — marker found, sibling
			// absent, section wire format round-trips
			const listing = exec(target, listScript(target));
			expect(listing.code).toBe(0);
			const parsed = parseHubGcListing(listing.out);
			expect(parsed.worktrees).toHaveLength(1);
			expect(parsed.worktrees[0]).toMatchObject({
				item: "W777",
				branch: "suspenders/W777",
				clean: true,
			});
			// full dry-run fire: terminal claim → would-reap on the real tree
			const fire = (claim: string) =>
				gcHub(target, {
					act: false,
					exec,
					claimState: (i) => (i === "W777" ? claim : null),
					ancestry: () => ({ merged: true, pushed: false }),
				});
			const done = fire("DONE");
			expect(done.authorityReachable).toBe(true);
			expect(done.rows).toHaveLength(1);
			expect(done.rows[0]).toMatchObject({
				item: "W777",
				branch: "suspenders/W777",
				action: "would-reap",
			});
			// a live claim on the SAME real tree protects it (fail-closed)
			expect(fire("CLAIMED").rows[0]?.action).toBe("protected");
			// B1 (W2661): the REAL act fire pins the REAPED WORKTREE's tip —
			// the branch is ahead of main, so a repo-root HEAD pin (main's tip)
			// would capture the wrong object. Execute the real reap script and
			// dereference the pin: it must equal the worktree's own HEAD.
			const wtTip = new TextDecoder()
				.decode(
					Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], {
						cwd: world.repo,
						env: world.env,
						stdout: "pipe",
					}).stdout,
				)
				.trim();
			const reap = gcHub(target, {
				act: true,
				exec,
				claimState: () => "DONE",
				ancestry: () => ({ merged: true, pushed: true }),
			});
			expect(reap.reaped).toBe(1);
			const pinned = new TextDecoder()
				.decode(
					Bun.spawnSync(
						["git", "-C", world.repo, "for-each-ref", "refs/recover"],
						{
							cwd: world.repo,
							env: world.env,
							stdout: "pipe",
						},
					).stdout,
				)
				.trim();
			const [pinnedSha] = pinned.split(/\s+/);
			expect(pinnedSha).toBe(wtTip);
		} finally {
			world.clean();
		}
	});

	// N2 proof (W2660): shQuote must be POSIX single-quote form — under
	// /bin/sh -c, a $ or backtick inside double quotes EXPANDS; the
	// hardened form must round-trip branch names carrying both, inert.
	test("shQuote: $ and backtick stay inert under real /bin/sh -c", () => {
		const nasty = "b$HOME`id`x";
		const p = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shQuote(nasty)}`], {
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: "/usr/bin:/bin" },
		});
		expect(new TextDecoder().decode(p.stdout)).toBe(nasty);
	});
});
