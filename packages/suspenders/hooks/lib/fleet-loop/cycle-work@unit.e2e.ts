import { expect, test } from "@playwright/test";
import { scratchWorld, runCliAsync } from "@klh/test-kit";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const resume of [false, true])
	test(`actual once refills before slow merge work ${resume ? "after interrupted merge" : "from a fresh cycle"} and logs failed dispatch without child secrets`, async () => {
		const world = scratchWorld({ prefix: "w3054-cycle-" });
		try {
			const bin = join(world.home, "bin"),
				order = join(world.home, "order"),
				args = join(world.home, "args.json");
			mkdirSync(bin);
			const git = Bun.which("git");
			if (!git) throw Error("Git prerequisite unavailable");
			for (const branch of ["fixture/first", "fixture/tail"])
				expect(
					Bun.spawnSync([git, "branch", branch], {
						cwd: world.repo,
						env: world.env,
					}).exitCode,
				).toBe(0);
			const fakeGit = join(bin, "git");
			writeFileSync(
				fakeGit,
				`#!${process.execPath}\nimport{appendFileSync}from'node:fs';const args=process.argv.slice(2);if(args[0]==='rev-list'&&args[1]==='--count'){appendFileSync(${JSON.stringify(order)},'merge:'+args[2].split('..').at(-1)+'\\n');await Bun.sleep(120);}const p=Bun.spawn([${JSON.stringify(git)},...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await p.exited);\n`,
			);
			chmodSync(fakeGit, 0o700);
			const dispatch = join(world.home, "dispatch.ts"),
				secret = "fixture-confidential-output";
			writeFileSync(
				dispatch,
				`import{appendFileSync,writeFileSync}from'node:fs';appendFileSync(${JSON.stringify(order)},'dispatch\\n');writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));console.error(${JSON.stringify(secret)});process.exit(23);\n`,
			);
			mkdirSync(join(world.home, ".config/klh"), { recursive: true });
			writeFileSync(
				join(world.home, ".config/klh/stack.json"),
				JSON.stringify({ fleet_loop: { lane_target: 8, dispatch_target: 3 } }),
			);
			mkdirSync(join(world.repo, ".fleet"));
			writeFileSync(
				join(world.repo, ".fleet/merge-hold"),
				JSON.stringify({
					owner: "fixture",
					reason: "integration fixture",
					expiresAt: new Date(Date.now() + 60000).toISOString(),
				}),
			);
			const command = [process.execPath, dispatch]
				.map((s) => `'${s.replaceAll("'", "'\"'\"'")}'`)
				.join(" ");
			if (resume) {
				const { markMaybeRan } = await import("./sweep-state.ts");
				expect(
					markMaybeRan(
						join(world.repo, ".fleet/merge-cycle.json"),
						"fixture/first",
					),
				).toBe(true);
			}
			const loop = new URL("../../bin/fleet-loop.ts", import.meta.url).pathname;
			const result = await runCliAsync(
				loop,
				[
					"once",
					"--repo",
					world.repo,
					"--project-only",
					"--glob",
					"fixture/*",
					"--lane-target",
					"8",
					"--dispatch-cmd",
					command,
				],
				{
					cwd: world.repo,
					env: {
						...world.env,
						KLH_STACK: join(world.home, ".config/klh/stack.json"),
						PATH: `${bin}:${process.env.PATH}`,
						SUSPENDERS_TRANSPORT_PROBE: "0",
					},
				},
			);
			expect(result.code).toBe(0);
			expect
				.soft(readFileSync(order, "utf8").trim().split("\n"))
				.toEqual([
					"dispatch",
					...[
						resume ? "fixture/tail" : "fixture/first",
						resume ? "fixture/first" : "fixture/tail",
					].map((b) => `merge:${b}`),
				]);
			expect(JSON.parse(readFileSync(args, "utf8"))).toEqual(["--target", "3"]);
			const log = readFileSync(join(world.repo, ".fleet/loop.log"), "utf8");
			expect.soft(log).toContain("DISPATCH");
			expect(log).toContain('"code":23');
			expect(log).toContain("operator merge hold");
			expect(log).not.toContain(secret);
		} finally {
			world.clean();
		}
	});

test("retired bookmark resumes at its successor; corrupt state falls back safely and failed stamping defers merges", async () => {
	const world = scratchWorld({ prefix: "w3054-retired-" });
	try {
		const { runMergePass } = await import("./cycle-work.ts");
		const { confirmCursor } = await import("./sweep-state.ts");
		const path = join(world.repo, ".fleet/merge-cycle.json"),
			seen: string[] = [],
			lines: string[] = [];
		expect(confirmCursor(path, Date.now(), "b-retired")).toBe(true);
		const merge = (branch: string) => {
			seen.push(branch);
			return { branch, outcome: "deferred" as const };
		};
		runMergePass({
			repo: world.repo,
			branches: ["a", "c"],
			merge,
			log: (line) => lines.push(line),
		});
		expect(seen).toEqual(["c", "a"]);
		seen.length = 0;
		writeFileSync(path, "malformed fixture JSON");
		runMergePass({
			repo: world.repo,
			branches: ["c", "a"],
			merge,
			log: (line) => lines.push(line),
		});
		expect(seen).toEqual(["a", "c"]);
		seen.length = 0;
		mkdirSync(join(world.repo, ".fleet/merge-cycle-pending.json.tmp"));
		runMergePass({
			repo: world.repo,
			branches: ["a", "c"],
			merge,
			log: (line) => lines.push(line),
		});
		expect(seen).toEqual([]);
		expect(lines.join("\n")).toContain("cannot bank attempt cursor");
	} finally {
		world.clean();
	}
});

test("dispatch observations distinguish completed, error and explicit unknown target without recording output", async () => {
	const { runCycleDispatch } = await import("./cycle-work.ts");
	for (const throws of [false, true]) {
		const lines: string[] = [],
			calls: string[] = [];
		let at = 10;
		const outcome = runCycleDispatch({
			template: "fixture --target 2",
			target: 8,
			timeoutMs: 1000,
			log: (line) => lines.push(line),
			now: () => (at += 25),
			run: (template) => {
				calls.push(template);
				if (throws) throw Error("fixture-private-error");
				return { code: 0, tail: "fixture-private-output".repeat(10000) };
			},
		});
		expect(calls).toEqual(["fixture --target 2"]);
		expect(outcome).toMatchObject({
			status: throws ? "error" : "completed",
			code: throws ? null : 0,
			target: null,
			configuredTarget: 8,
			targetSource: "template",
			admitted: null,
			durationMs: 25,
		});
		expect(lines.join("\n").length).toBeLessThan(512);
		expect(lines.join("\n")).not.toContain("fixture-private");
		expect(lines.join("\n")).not.toContain("fixture --target");
	}
});

test("interrupted merge bookmark advances to newly arrived tail work and wraps without discarding branches", async () => {
	const world = scratchWorld({ prefix: "w3054-bookmark-" });
	try {
		const { runMergePass } = await import("./cycle-work.ts");
		const { readPending, readCursor } = await import("./sweep-state.ts");
		const path = join(world.repo, ".fleet/merge-cycle.json"),
			failure = Error("interrupted merge");
		expect(() =>
			runMergePass({
				repo: world.repo,
				branches: ["b", "a"],
				log: () => {},
				merge: (branch) => {
					expect(readPending(path)?.runId).toBe(branch);
					throw failure;
				},
			}),
		).toThrow(failure);
		expect(readPending(path)?.runId).toBe("a");
		expect(readCursor(path)).toBeNull();
		const seen: string[] = [];
		runMergePass({
			repo: world.repo,
			branches: ["a", "new-tail", "b"],
			log: () => {},
			merge: (branch) => {
				seen.push(branch);
				return { branch, outcome: "deferred" };
			},
		});
		expect(seen).toEqual(["b", "new-tail", "a"]);
		expect(readPending(path)).toBeNull();
		expect(readCursor(path)?.runId).toBe("a");
	} finally {
		world.clean();
	}
});
