#!/usr/bin/env bun
/**
 * UserPromptSubmit hook: lessons/API recall without re-learning.
 *
 * 1) Semantic fast-path: local context-rag index (Qwen3-Embedding via mlx on
 *    :8907 + sqlite FTS5, RRF-fused). Only used when the index exists AND the
 *    embed server is already warm — hooks never spawn the model.
 * 2) Keyword fallback: same corpus files, line-level keyword overlap.
 *
 * Zero output when nothing matches — zero token cost.
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const RAG = `${homedir()}/.claude/context-rag`;

const input = JSON.parse(await Bun.stdin.text());
const prompt: string = typeof input?.prompt === "string" ? input.prompt : "";
if (prompt.length < 12) process.exit(0);

const inject = (lines: string[]) => {
	if (lines.length === 0) process.exit(0);
	console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: `Recall (matching local lessons/API corpus — skim before re-deriving):\n${lines.join("\n")}`,
			},
		}),
	);
	process.exit(0);
};

// ---------- 1) semantic ----------
try {
	if (existsSync(`${RAG}/rag.db`)) {
		const health = await fetch("http://127.0.0.1:8907/health", {
			signal: AbortSignal.timeout(300),
		});
		const h = (await health.json()) as { model?: string };
		if (
			health.ok &&
			typeof h.model === "string" &&
			h.model.includes("Qwen3-Embedding")
		) {
			const p = Bun.spawnSync(
				["bun", `${RAG}/index.ts`, "search", prompt, "-k", "3", "--json"],
				{
					timeout: 6_000,
				},
			);
			if (p.success) {
				const hits = JSON.parse(p.stdout.toString().trim()) as {
					source: string;
					title: string;
					text: string;
				}[];
				inject(
					hits.map(
						(x) =>
							`- [${x.title || x.source.split("/").pop()}] ${x.text.slice(0, 180).replace(/\s+/g, " ")}`,
					),
				);
			}
		}
	}
} catch {
	// fall through to keyword path
}

// ---------- 2) keyword fallback ----------
const CORPUS = [
	`${homedir()}/.claude-insights/APPLIED.md`,
	`${homedir()}/.claude/docs/llm-routing.md`,
	`${homedir()}/.claude/docs/cli-auth-interaction-lessons.md`,
];

const stop = new Set([
	"this",
	"that",
	"with",
	"have",
	"does",
	"could",
	"should",
	"would",
	"there",
	"their",
	"about",
	"from",
	"what",
	"when",
	"your",
	"into",
	"just",
	"like",
	"make",
	"need",
	"want",
	"hvordan",
	"skal",
	"kan",
	"det",
	"til",
]);
const tokens = new Set(
	prompt
		.toLowerCase()
		.split(/[^a-z0-9æøå]+/)
		.filter((t) => t.length > 3 && !stop.has(t)),
);
if (tokens.size === 0) process.exit(0);

const lines: string[] = [];
for (const path of CORPUS) {
	if (!existsSync(path)) continue;
	for (const raw of (await Bun.file(path).text()).split("\n")) {
		const line = raw.trim();
		if (line.length < 20 || line.startsWith("#")) continue;
		let score = 0;
		for (const t of tokens) if (line.toLowerCase().includes(t)) score++;
		if (score >= 2) lines.push(`- ${line.slice(0, 200)}`);
	}
}
inject(lines.slice(0, 5));
