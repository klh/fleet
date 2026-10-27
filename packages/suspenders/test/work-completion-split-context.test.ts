import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	drainCleanup,
	fixture,
	summary,
} from "./helpers/work-completion-fixtures.ts";

afterEach(() => drainCleanup());

test("kept split child completes under the splitter's parent-bound context (W652.1)", () => {
	const f = fixture();
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", f.repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	expect(
		f.work(
			"split",
			f.id,
			"kept child work",
			"sibling scope",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		).code,
	).toBe(0);
	// W628: split rebinds the keeping lane's context transactionally — restore
	// the PRE-FIX parent binding here so this test keeps exercising the
	// W652.1 fallback the rebind was built on top of.
	writeFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "completion-lane",
			item: f.id,
			baseline: f.baseline,
			launchedAt: Date.now(),
		}),
	);
	const child = `${f.id}.1`;
	writeFileSync(join(f.repo, "product.ts"), "export const keptChild = true;\n");
	expect(git("add", "product.ts").exitCode).toBe(0);
	expect(git("commit", "-m", "kept child work").exitCode).toBe(0);
	const sha2 = git("rev-parse", "HEAD").stdout.toString().trim();
	const done = f.work(
		"done",
		child,
		"--as",
		"completion-lane",
		"--sha",
		sha2,
		"--summary",
		`${summary} kept-child variant.`,
	);
	expect(done.code).toBe(0);
	expect(done.err).toContain("warning: lane context still names");
	expect(JSON.parse(f.work("show", child, "--json").out).state).toBe("DONE");
	// parent stays SHATTERED while the READY sibling holds roll-up open
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe(
		"SHATTERED",
	);
});

test("split's transactional rebind closes the kept child without the parent binding (W628)", () => {
	const f = fixture();
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", f.repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	expect(
		f.work(
			"split",
			f.id,
			"kept child work",
			"sibling scope",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		).code,
	).toBe(0);
	// the rebind landed: context names the kept child, baseline preserved
	const rebound = JSON.parse(
		readFileSync(join(f.repo, ".fleet", "lane-context.json"), "utf8"),
	);
	expect(rebound.item).toBe(`${f.id}.1`);
	expect(rebound.baseline).toBe(f.baseline);
	writeFileSync(join(f.repo, "product.ts"), "export const keptChild = true;\n");
	expect(git("add", "product.ts").exitCode).toBe(0);
	expect(git("commit", "-m", "kept child work").exitCode).toBe(0);
	const sha2 = git("rev-parse", "HEAD").stdout.toString().trim();
	const done = f.work(
		"done",
		`${f.id}.1`,
		"--as",
		"completion-lane",
		"--sha",
		sha2,
		"--summary",
		`${summary} rebound-context variant.`,
	);
	expect(done.code).toBe(0);
	expect(done.err).not.toContain("warning: lane context still names");
	expect(JSON.parse(f.work("show", `${f.id}.1`, "--json").out).state).toBe(
		"DONE",
	);
});

test("a context bound to an unrelated item still cannot complete a split child", () => {
	const f = fixture();
	expect(
		f.work(
			"split",
			f.id,
			"kept child work",
			"sibling scope",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		).code,
	).toBe(0);
	writeFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		JSON.stringify({
			sid: "completion-lane",
			item: "W88888",
			baseline: f.baseline,
			launchedAt: Date.now(),
		}),
	);
	const done = f.work(
		"done",
		`${f.id}.1`,
		"--as",
		"completion-lane",
		"--sha",
		f.sha,
		"--summary",
		`${summary} kept-child negative.`,
	);
	expect(done.code).toBe(2);
	expect(done.err).toContain("does not match this item and owner");
});
