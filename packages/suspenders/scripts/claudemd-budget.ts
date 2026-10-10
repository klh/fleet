#!/usr/bin/env bun
// scripts/claudemd-budget.ts — CLAUDE.md/AGENTS.md instruction-budget audit
// (oh-my-claude research L7, the claudemd_health rubric): instruction
// capacity is real — a bloated root file taxes every session forever.
// Rubric: root budget 150 lines / 150 instructions; nested 80/80; hardcoded
// machine paths (staleness risk) are counted; children never repeat parents.
// Report tool, not a gate: exit 0 always; --strict exits 1 when any file is
// over budget so CI/wiring can escalate later.
// usage: bun scripts/claudemd-budget.ts [repoRoot] [--strict]
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type FileAudit = {
	file: string;
	lines: number;
	instructions: number;
	stalePaths: number;
	verdict: "ok" | "over-lines" | "over-instructions" | "stale-paths";
};

export const ROOT_BUDGET = { lines: 150, instructions: 120 };
export const NESTED_BUDGET = { lines: 80, instructions: 60 };
// instruction budget sits BELOW the line ceiling on purpose: instructions
// (list items + table rows) are the leading indicator — a file hits the
// instruction budget first, the line ceiling is the hard stop

// instruction estimate: list items + markdown table rows + bold law lines —
// each is one directive a session must obey
export const countInstructions = (text: string): number =>
	text.split("\n").filter((l) => /^\s*(?:[-*+]\s|\d+\.\s|\|)/.test(l)).length;

// hardcoded machine paths: /Users/, /Volumes/, /home/ — staleness risk
// (tilde paths are config pointers by fleet law and exempt)
export const countStalePaths = (text: string): number =>
	text.split("\n").filter((l) => /\/(Users|Volumes|home)\//.test(l)).length;

export function auditText(
	file: string,
	text: string,
	isRoot: boolean,
): FileAudit {
	const b = isRoot ? ROOT_BUDGET : NESTED_BUDGET;
	const lines = text.split("\n").length;
	const instructions = countInstructions(text);
	const stalePaths = countStalePaths(text);
	let verdict: FileAudit["verdict"] = "ok";
	if (stalePaths > 0) verdict = "stale-paths";
	if (instructions > b.instructions) verdict = "over-instructions";
	if (lines > b.lines) verdict = "over-lines";
	return { file, lines, instructions, stalePaths, verdict };
}

const SKIP = /^(node_modules|\.worktrees|\.git|\.fleet|vendor|dist|build)$/;

export function auditRepo(root: string): FileAudit[] {
	const out: FileAudit[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP.test(e.name)) walk(p, depth + 1);
			} else if (e.name === "CLAUDE.md" || e.name === "AGENTS.md") {
				out.push(
					auditText(
						relative(root, p) || e.name,
						readFileSync(p, "utf8"),
						dir === root,
					),
				);
			}
		}
	};
	walk(root, 0);
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

// ---- CLI ----
const argv = process.argv.slice(2);
const root = argv.find((a) => !a.startsWith("--")) ?? ".";
const rows = auditRepo(root);
const pad = (s: string, n: number) =>
	s.length >= n ? s : s + " ".repeat(n - s.length);
console.log(
	`${pad("FILE", 44)}${pad("LINES", 7)}${pad("INSTR", 7)}PATHS  VERDICT`,
);
for (const r of rows) {
	console.log(
		`${pad(r.file, 44)}${pad(String(r.lines), 7)}${pad(String(r.instructions), 7)}${pad(String(r.stalePaths), 6)}  ${r.verdict}`,
	);
}
const bad = rows.filter((r) => r.verdict !== "ok");
console.log(
	`\n${rows.length} files, ${bad.length} over budget${
		bad.length ? `: ${bad.map((r) => r.file).join(", ")}` : ""
	}`,
);
if (argv.includes("--strict") && bad.length > 0) process.exit(1);
