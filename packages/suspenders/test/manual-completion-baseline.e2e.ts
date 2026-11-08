import { expect, test } from "@playwright/test";
import { runCli, scratchWorld } from "@klh/test-kit";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const BIN = join(import.meta.dir, "../hooks/bin/work.ts");
const worlds: ReturnType<typeof scratchWorld>[] = [];
test.afterEach(() => {
	while (worlds.length) worlds.pop()?.clean();
});
for (const location of ["tree", "root"])
	for (const mode of ["ok", "missing-receipt", "stale-token", "stale-epoch"])
		test(
			"manual multi-commit completion preserves its original registered baseline from " +
				location +
				" " +
				mode +
				" @unit",
			() => {
				const world = scratchWorld({ prefix: "w2876-" });
				worlds.push(world);
				world.env.KLH_CLAIM_TOKEN = undefined;
				world.env.KLH_CLAIM_EPOCH = undefined;
				const work = (args: string[], cwd = world.repo) =>
					runCli(BIN, args, { cwd, env: world.env });
				const add = work(["add", "benchmark manual completion provenance"]);
				expect(add.code, add.err).toBe(0);
				const id = add.out.match(/W\d+/)?.[0] ?? "";
				const taken = work(["take", id, "--as", "manual-owner"]);
				expect(taken.code, taken.err).toBe(0);
				const tree = taken.out.match(/worktree: (.+)/)?.[1] ?? "";
				const token = taken.out.match(/claim token: ([a-f0-9]{48})/)?.[1] ?? "";
				const git = (...args: string[]) => {
					const p = Bun.spawnSync(
						[
							"git",
							"-C",
							tree,
							"-c",
							"user.name=Fixture",
							"-c",
							"user.email=fixture@example.invalid",
							...args,
						],
						{ env: world.env, stdout: "pipe", stderr: "pipe" },
					);
					expect(p.exitCode, p.stderr.toString()).toBe(0);
					return p.stdout.toString().trim();
				};
				const base = git("rev-parse", "HEAD");
				for (const path of ["benchmarks.md", "doesnt_work.md", "product.ts"])
					writeFileSync(join(tree, path), "initial evidence\n");
				git("add", ".");
				git("commit", "-qm", "record product and ledgers");
				writeFileSync(
					join(tree, "product.ts"),
					"export const completed = true;\n",
				);
				git("add", "product.ts");
				git("commit", "-qm", "finish product");
				const sha = git("rev-parse", "HEAD");
				if (mode === "missing-receipt") {
					const source =
						"import {openGovernorDb} from " +
						JSON.stringify(
							join(import.meta.dir, "../hooks/lib/govdb/govdb.ts"),
						) +
						'; openGovernorDb().run("DELETE FROM events WHERE kind=\\"work.tree\\" AND work=?",' +
						JSON.stringify(id) +
						");";
					const seeded = runCli("-e", [source], {
						cwd: world.repo,
						env: world.env,
					});
					expect(seeded.code, seeded.err).toBe(0);
				}
				const done = work(
					[
						"done",
						id,
						"--as",
						"manual-owner",
						"--token",
						mode === "stale-token" ? "a".repeat(48) : token,
						"--claim-epoch",
						mode === "stale-epoch" ? "99" : "1",
						"--sha",
						sha,
						"--summary",
						"Implemented the real product across two commits while preserving its original benchmark and negative-results evidence.",
					],
					location === "tree" ? tree : world.repo,
				);
				if (mode !== "ok") {
					expect(done.code, done.err).not.toBe(0);
					if (mode === "missing-receipt")
						expect(done.err).toContain("registered original baseline");
					expect(JSON.parse(work(["show", id, "--json"]).out).state).toBe(
						"CLAIMED",
					);
					return;
				}
				expect(done.code, done.err).toBe(0);
				const shown = JSON.parse(work(["show", id, "--json"]).out);
				expect(shown.completion.baseline_sha).toBe(base);
				expect(shown.completion.commit_sha).toBe(sha);
			},
		);
