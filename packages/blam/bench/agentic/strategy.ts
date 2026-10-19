#!/usr/bin/env bun
// Execute a comparable single-agent, two-agent review, or three-way split
// treatment for the Relay ledger fixture. BLAM's live paired runner invokes
// this with the same argv in both arms; only Mode in harness guidance differs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command, git, gitRaw, usageFromOutput } from "../paired/live.ts";

type Mode = "solo" | "review" | "split";
type AgentResult = {
	exit: number;
	tokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	timedOut: boolean;
};

const argv = process.argv.slice(2);
const flag = (name: string): string => {
	const at = argv.indexOf(`--${name}`);
	if (at < 0 || !argv[at + 1]) throw new Error(`missing --${name}`);
	return argv[at + 1];
};

async function agent(
	worktree: string,
	model: string,
	prompt: string,
): Promise<AgentResult> {
	const r = await command(
		[
			"codex",
			"exec",
			"--json",
			"--ignore-user-config",
			"--ephemeral",
			"--model",
			model,
			"--cd",
			worktree,
			"--sandbox",
			"workspace-write",
			prompt,
		],
		worktree,
		300_000,
		{ BLAM_LANE_ID: process.env.BLAM_LANE_ID ?? "blam-agent" },
	);
	const usage = usageFromOutput(r.stdout);
	return {
		exit: r.exit,
		timedOut: r.timedOut,
		tokens: usage?.tokens ?? null,
		cacheReadTokens: usage?.cacheReadTokens ?? null,
		cacheWriteTokens: usage?.cacheWriteTokens ?? null,
	};
}

async function split(
	worktree: string,
	model: string,
	prompt: string,
): Promise<AgentResult[]> {
	const modules = ["claim", "cache", "trace"];
	const trees = modules.map((module) => ({
		module,
		path: mkdtempSync(join(tmpdir(), `blam-${module}-`)),
	}));
	try {
		for (const tree of trees)
			git(worktree, "worktree", "add", "--detach", tree.path, "HEAD");
		const results = await Promise.all(
			trees.map((tree) =>
				agent(
					tree.path,
					model,
					`${prompt}\n\nYour sole edit target is src/${tree.module}.ts. Read README.md, solve that module, and do not edit the other two.`,
				),
			),
		);
		for (let i = 0; i < trees.length; i++) {
			const tree = trees[i];
			const changed = git(tree.path, "diff", "--name-only", "HEAD")
				.split("\n")
				.filter(Boolean);
			if (changed.some((name) => name !== `src/${tree.module}.ts`))
				throw new Error(`${tree.module} agent edited outside its module`);
			const patch = gitRaw(tree.path, "diff", "--binary", "HEAD");
			if (patch) {
				const apply = Bun.spawnSync(["git", "-C", worktree, "apply", "-"], {
					stdin: new TextEncoder().encode(patch),
					stdout: "pipe",
					stderr: "pipe",
				});
				if (apply.exitCode !== 0)
					throw new Error(
						`apply ${tree.module}: ${new TextDecoder().decode(apply.stderr)}`,
					);
			}
		}
		return results;
	} finally {
		for (const tree of trees) {
			try {
				git(worktree, "worktree", "remove", "--force", tree.path);
			} catch {
				/* preserve original failure */
			}
			rmSync(tree.path, { recursive: true, force: true });
		}
	}
}

async function main(): Promise<void> {
	const worktree = resolve(flag("worktree"));
	const model = flag("model");
	const prompt = flag("prompt");
	const mode = /^Mode: (solo|review|split)$/m.exec(prompt)?.[1] as
		| Mode
		| undefined;
	if (!mode)
		throw new Error("harness guidance must contain Mode: solo|review|split");
	let results: AgentResult[];
	if (mode === "split") results = await split(worktree, model, prompt);
	else {
		results = [await agent(worktree, model, prompt)];
		if (mode === "review" && results[0].exit === 0)
			results.push(
				await agent(
					worktree,
					model,
					`${prompt}\n\nReview the existing implementation against README.md. Correct any missed contract cases. Do not add unrelated changes.`,
				),
			);
	}
	const sum = (
		key: "tokens" | "cacheReadTokens" | "cacheWriteTokens",
	): number | null =>
		results.every((r) => r[key] !== null)
			? results.reduce((n, r) => n + (r[key] ?? 0), 0)
			: null;
	console.log(
		JSON.stringify({
			usage: {
				total_tokens: sum("tokens"),
				cached_input_tokens: sum("cacheReadTokens"),
				cache_write_input_tokens: sum("cacheWriteTokens"),
			},
			mode,
			agents: results.length,
			agentResults: results,
		}),
	);
	if (results.some((r) => r.exit !== 0 || r.timedOut || r.tokens === null))
		process.exit(1);
}

if (import.meta.main) await main();
