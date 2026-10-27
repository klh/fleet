// test/install-wire-dedupe.test.ts — W904: the per-event hooks merge must
// treat the $HOME-form and the absolute-prefix-form of the same gate command
// as the same group. W893 install e2e found ~/.claude/settings.json
// UserPromptSubmit carrying BOTH — the per-event merge compared literal
// strings, so re-wires appended duplicates and the ask gate ran twice per
// prompt. groupSignature now expands $HOME before folding the prefix, and
// the merge collapses existing signature-duplicates keep-first, so the next
// wire run heals the live settings too.
import { afterEach, describe, expect, test } from "bun:test";
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
	type StepContext,
	wireSettings,
} from "../scripts/install/install-run.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// fixture — a repo holding a $HOME-form settings.example.json plus a wire
// target whose .claude/settings.json starts from the given hooks. The prefix
// mirrors the real install: <home>/.claude/hooks/suspenders. buildHooks
// receives the prefix so the absolute-form entries can embed it.
function fixture(buildHooks: (prefix: string) => unknown): {
	ctx: StepContext;
	prefix: string;
	target: string;
} {
	const repo = mkdtempSync(join(tmpdir(), "w904-repo-"));
	const home = mkdtempSync(join(tmpdir(), "w904-home-"));
	dirs.push(repo, home);
	const prefix = join(home, ".claude", "hooks", "suspenders");
	writeFileSync(
		join(repo, "settings.example.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{
								type: "command",
								command: "bun $HOME/.claude/hooks/suspenders/gate.ts ask",
								timeout: 15,
							},
						],
					},
				],
			},
		}),
	);
	const target = join(home, ".claude", "settings.json");
	mkdirAndWrite(target, buildHooks(prefix));
	const ctx: StepContext = {
		dryRun: false,
		yes: true,
		json: true,
		verbose: false,
		repo,
		prefix,
		shimBin: join(home, "bin"),
		llmHome: join(home, "llm"),
		home,
		wireRepo: home,
	};
	return { ctx, prefix, target };
}

function mkdirAndWrite(path: string, hooks: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ hooks }, null, 2)}\n`);
}

function readHooks(target: string): unknown[] {
	const doc = JSON.parse(readFileSync(target, "utf8")) as {
		hooks?: Record<string, unknown>;
	};
	const cur = doc.hooks?.UserPromptSubmit;
	return Array.isArray(cur) ? cur : [];
}

describe("W904 wireSettings dedupe (W893 finding)", () => {
	test("absolute-form settings + $HOME-form example converge, no duplicate", async () => {
		const { ctx, target } = fixture((prefix) => ({
			UserPromptSubmit: [
				{
					hooks: [
						{
							type: "command",
							command: `bun ${prefix}/gate.ts ask`,
							timeout: 15,
						},
					],
				},
			],
		}));
		const res = await wireSettings(ctx);
		expect(res.status).toBe("ok");
		expect(res.note).toContain("0 new hook entries");
		expect(readHooks(target)).toHaveLength(1);
	});

	test("dual-form duplicates already in settings collapse keep-first", async () => {
		const { ctx, target } = fixture((prefix) => ({
			UserPromptSubmit: [
				{
					hooks: [
						{
							type: "command",
							command: `bun ${prefix}/gate.ts ask`,
							timeout: 15,
						},
					],
				},
				{
					hooks: [
						{
							type: "command",
							command: "bun $HOME/.claude/hooks/suspenders/gate.ts ask",
							timeout: 15,
						},
					],
				},
			],
		}));
		const res = await wireSettings(ctx);
		expect(res.status).toBe("ok");
		expect(res.note).toContain("collapsed 1 duplicate group");
		expect(readHooks(target)).toHaveLength(1);
	});

	test("a fresh event still gains its entry (rewritten to the prefix)", async () => {
		const { ctx, prefix, target } = fixture(() => ({}));
		const res = await wireSettings(ctx);
		expect(res.status).toBe("ok");
		expect(res.note).toContain("1 new hook entries");
		const hooks = readHooks(target);
		expect(hooks).toHaveLength(1);
		expect(JSON.stringify(hooks)).toContain(`bun ${prefix}/gate.ts ask`);
	});
});
