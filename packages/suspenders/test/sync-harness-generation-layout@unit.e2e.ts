// test/sync-harness-generation-layout@unit.e2e.ts — W2857.3: pins the
// installed-generation-layout contract the W2857.2 reviewer kept asking
// about (C501 disposition: bounded contract-pinning, not a cap raise).
//
// Contract source (packages/suspenders/scripts/sync-harness.ts, main
// ab568d63): generation-cut naming `${prefix}.generation-<rev12>-<uuid>`
// (:534) with pointer `${prefix}.next-<uuid>` (:541) under the exclusive
// `${prefix}.sync-lock` dir lock (:531,:542); broken-prefix-symlink refusal
// (:523-527); W2546.3 reuse (:550-568) — verified-equivalent bytes are the
// ONLY skip key, pointer + generation dir + receipt retained, no new
// generation UUID, only shim wrappers heal; repair path (:756-771):
// harness-receipt.json 0600, stage→generation rename, real-dir backup,
// symlink at pointer then atomic publish pointer→prefix; rollback
// (:783-792) restores oldLink/backup, removes stage+generation; finally
// (:793-796) removes pointer+lock.
//
// Sibling coverage: test/sync-harness.test.ts (grandfathered W1294 corpus)
// pins rollback-on-pointer-failure (:436), shim rollback (:450), no
// snapshot nesting (:471), the exclusive lock (:672/:687), revision pinning
// (:696) and prune (:746). THIS file pins the LAYOUT semantics that corpus
// does not: generation naming, atomic symlink flip, reuse retention, the
// broken-symlink refusal, and the old-generation-remains external-cleanup
// law.
import { expect, test } from "@playwright/test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncHarness } from "../scripts/sync-harness.ts";
import type { StepContext } from "../scripts/install/install-run.ts";

const roots: string[] = [];
test.afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

// Payload closure mirrors the grandfathered sibling fixture
// (test/sync-harness.test.ts:35-205, W1256.1/W1466 closure entries) — the
// ship list is the computed closure of these exact edges, so the fixture
// files are payload-shaped, not kit-derivable (the kit owns isolation, not
// fleet payload graphs).
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fleet-sync-layout-"));
	roots.push(root);
	const source = join(root, "source");
	mkdirSync(source);
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", source, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		return result.stdout.toString().trim();
	};
	const put = (relative: string, value: string) => {
		const file = join(source, relative);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, value);
	};
	// scoped names match the real payload packages (@klh/*) — the stage
	// workspaces glob (W2308) resolves member names as shipped.
	for (const [dir, name] of [
		["suspenders", "@klh/suspenders"],
		["belt", "@klh/belt"],
		["local-llm", "@klh/local-llm"],
		["blam", "@klh/blam"],
		["buckle", "@klh/buckle"],
		["telemetry", "@klh/telemetry"],
	] as const)
		put(
			`packages/${dir}/package.json`,
			JSON.stringify({
				name,
				version: "1.0.0",
				type: "module",
				dependencies: dir === "suspenders" ? { blam: "workspace:*" } : {},
			}),
		);
	for (const name of [
		"bin",
		"lib",
		"board-html",
		"coord",
		"board",
		"gates",
		"launchd",
		"rules",
	])
		put(
			`packages/suspenders/hooks/${name}/fixture.ts`,
			"export const value = 1;",
		);
	put("packages/suspenders/agent-rules/fixture.ts", "export const value = 1;");
	for (const file of [
		"gate.ts",
		"session-start.ts",
		"subagent-start.ts",
		"session-end.ts",
		"pre-compact.ts",
		"statusline.ts",
		"subagent-statusline.ts",
		"bin/coord.ts",
		"bin/work.ts",
		"bin/oracle.ts",
		"bin/fleet-loop.ts",
		"bin/fleet-tracker.ts",
		"bin/fleet-watch.ts",
		"bin/fleet-board.ts",
		"bin/morph.ts",
		"bin/llm-keepwarm.ts",
		"bin/fallback-drill.ts",
		"bin/soak.ts",
		"bin/review-reconcile.ts",
		"lib/morph.ts",
		"board/prompt-transform.ts",
	])
		put(`packages/suspenders/hooks/${file}`, "export const value = 1;");
	for (const file of ["dispatch-next.ts", "supervise.ts"])
		put(`packages/suspenders/scripts/${file}`, "export const value = 1;");
	put("packages/telemetry/src/http-trace.ts", "export const trace = 1;");
	put(
		"packages/buckle/src/server.ts",
		'export { trace } from "../../telemetry/src/http-trace.ts";',
	);
	put("packages/buckle/routing-policy.json", "{}");
	put("packages/buckle/repo-policy.json", "{}");
	put("packages/suspenders/hooks/knowledgeworker.md", "fixture");
	put("packages/suspenders/deploy/services.yaml", "services: []");
	put(
		".githooks/pre-commit",
		'#!/bin/sh\nexec bun "$P/hooks/bin/scrub-gate.ts" hook commit\n',
	);
	put(
		".githooks/pre-push",
		'#!/bin/sh\nexec bun "$P/hooks/bin/scrub-gate.ts" hook push\n',
	);
	put("packages/suspenders/scripts/lib/shared.ts", "export const value = 1;");
	put(
		"packages/suspenders/hooks/bin/work.ts",
		'export { value } from "../../scripts/lib/shared.ts";',
	);
	for (const file of ["router-shim.ts", "supervisor.ts", "dashboard.ts"])
		put(`packages/belt/bin/${file}`, "export const value = 1;");
	put(
		"packages/belt/bin/fixture.ts",
		'export { value } from "../../local-llm/fixture.ts";',
	);
	put(
		"packages/buckle/src/policy.ts",
		[
			'export const upstreams = new URL("../upstreams.json", import.meta.url);',
			'export const routing = new URL("../routing-policy.json", import.meta.url);',
			'export const repoPolicy = new URL("../repo-policy.json", import.meta.url);',
			'export { value } from "@klh/blam/src/fixture.ts";',
		].join("\n"),
	);
	put(
		"packages/suspenders/scripts/lib/agent-rules.ts",
		'import { resolve } from "node:path";\nexport const dir = resolve(import.meta.dir, "../../agent-rules");',
	);
	put("packages/buckle/upstreams.json", '{"groups":{"reviewed-default":[]}}');
	put("packages/local-llm/fixture.ts", "export const value = 1;");
	put("packages/blam/src/fixture.ts", "export const value = 1;");
	put("packages/blam/bench/paired/fixture.ts", "export const value = 1;");
	put("packages/blam/bench/improve/fixture.ts", "export const value = 1;");
	put(
		"packages/suspenders/install.sh",
		`#!/bin/sh\ntouch ${join(root, "service-called")}\n`,
	);
	git("init");
	git("add", ".");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"reviewed fixture",
	);
	const ctx: StepContext = {
		repo: join(source, "packages/suspenders"),
		prefix: join(root, "state/harness"),
		shimBin: join(root, "shims"),
		llmHome: join(root, "models"),
		home: join(root, "home"),
		dryRun: false,
		yes: true,
		json: true,
		verbose: true,
	};
	mkdirSync(ctx.prefix, { recursive: true });
	writeFileSync(join(ctx.prefix, "operator.env"), "private-preserved", {
		mode: 0o600,
	});
	writeFileSync(join(ctx.prefix, "old-code.ts"), "export const old = true;");
	return { root, source, ctx, git, put };
}

// the generation directories are SIBLINGS of the prefix in its parent dir
// (`${prefix}.generation-<rev12>-<uuid>`), named after the prefix basename.
function generationDirs(prefix: string): string[] {
	const parent = join(prefix, "..");
	return readdirSync(parent).filter((n) => n.startsWith("harness.generation-"));
}

function receiptOf(prefix: string): { revision: string } {
	return JSON.parse(
		readFileSync(join(prefix, "harness-receipt.json"), "utf8"),
	) as { revision: string };
}

test.describe("@unit W2857.3 installed-generation-layout contract", () => {
	test("post-sync layout: prefix is a symlink into generation-<rev12>-<uuid>, no pointer or lock residue", async () => {
		const f = fixture();
		const result = await syncHarness(f.ctx);
		expect(result.status).toBe("ok");
		expect(lstatSync(f.ctx.prefix).isSymbolicLink()).toBe(true);
		const target = readlinkSync(f.ctx.prefix);
		const receipt = receiptOf(f.ctx.prefix);
		const rev12 = receipt.revision.slice(0, 12);
		expect(target.startsWith(`${f.ctx.prefix}.generation-${rev12}-`)).toBe(
			true,
		);
		// pointer + lock are teardown'd in the syncHarness finally block
		const parent = join(f.ctx.prefix, "..");
		expect(
			readdirSync(parent).filter((n) => n.startsWith("harness.next-")),
		).toEqual([]);
		expect(
			readdirSync(parent).filter((n) => n.startsWith("harness.sync-lock")),
		).toEqual([]);
	});

	test("W2546.3 reuse: verified-equivalent bytes retain publication — no new generation, UUID stable", async () => {
		const f = fixture();
		await syncHarness(f.ctx);
		const target1 = readlinkSync(f.ctx.prefix);
		const before = generationDirs(f.ctx.prefix);
		expect(before).toHaveLength(1);
		const result = await syncHarness(f.ctx);
		expect(result.status).toBe("ok");
		expect(result.note).toContain("publication retained");
		expect(readlinkSync(f.ctx.prefix)).toBe(target1);
		expect(generationDirs(f.ctx.prefix)).toEqual(before);
	});

	test("changed payload cuts a NEW generation: prefix flips atomically, old generation remains for external cleanup", async () => {
		const f = fixture();
		await syncHarness(f.ctx);
		const target1 = readlinkSync(f.ctx.prefix);
		f.put("packages/suspenders/hooks/gate.ts", "export const unreviewed = 2;");
		f.git("add", ".");
		f.git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"changed payload",
		);
		const result = await syncHarness(f.ctx);
		expect(result.status).toBe("ok");
		const target2 = readlinkSync(f.ctx.prefix);
		expect(target2).not.toBe(target1);
		const rev12 = receiptOf(f.ctx.prefix).revision.slice(0, 12);
		expect(target2.startsWith(`${f.ctx.prefix}.generation-${rev12}-`)).toBe(
			true,
		);
		// old generation dir stays on disk — cleanup is external (rogue-reap
		// prunes merged-and-clean trees; the sync never deletes a live
		// generation itself)
		expect(existsSync(target1)).toBe(true);
		expect(generationDirs(f.ctx.prefix)).toHaveLength(2);
	});

	test("dangling prefix symlink is refused before any publication (repair-first law)", async () => {
		const f = fixture();
		// simulate the broken state: prefix points at a removed generation
		lstatSync(f.ctx.prefix); // real dir from fixture setup
		rmSync(f.ctx.prefix, { recursive: true, force: true });
		symlinkSync(join(f.ctx.prefix, "gone"), f.ctx.prefix);
		await expect(syncHarness(f.ctx)).rejects.toThrow(
			"Installed prefix symlink is broken; repair before sync",
		);
		// the refusal is pre-publication: the prefix symlink is untouched
		expect(lstatSync(f.ctx.prefix).isSymbolicLink()).toBe(true);
	});
});
