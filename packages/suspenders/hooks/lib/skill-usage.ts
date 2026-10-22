// hooks/lib/skill-usage.ts — W1144: live skill-invocation instrumentation.
// The 2026-09-03 parking cleanup proved the fleet could retire 30 skills on
// retroactive `skillUsage` evidence alone; this is that evidence, LIVE. A
// PreToolUse gate (gates/skill-log.ts, matcher Skill) appends one NDJSON
// line per invocation to ~/.claude-insights/skill-invocations.ndjson; the
// report face (bin/skill-usage.ts) aggregates per-skill counts, last-used
// and the never-triggered set against the installed catalog. Streams law:
// append-only NDJSON, fire-and-forget — a logging failure NEVER blocks the
// tool call (same advisory law as the denied-calls audit, hookio.ts).
import { existsSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveFleetLane } from "./fleetlane.ts";
import type { HookInput } from "./hookio.ts";

export const SKILL_LOG_BASENAME = "skill-invocations.ndjson";

export function skillUsagePath(home = process.env.HOME ?? ""): string {
	return `${home}/.claude-insights/${SKILL_LOG_BASENAME}`;
}

// off-knob: SUSPENDERS_SKILL_LOG=0 silences the append (advisory, like
// SUSPENDERS_PUSH_TAIL) — the report face still reads whatever was logged
export function shouldLogSkill(): boolean {
	return process.env.SUSPENDERS_SKILL_LOG !== "0";
}

// one line per Skill-tool call; `skill` is the invoked name, `args` the
// free-text argument slice (truncated), lane attributes to the fleet sid
export type SkillInvocation = {
	at: string;
	skill: string;
	args: string;
	cwd: string;
	lane: string;
};

// fire-and-forget append — mirrors auditLine() in hookio.ts: mkdir -p the
// insights dir, truncate the arg slice, swallow every failure
export function appendSkillInvocation(hook: HookInput, home?: string): void {
	try {
		const skill = String(hook.tool_input?.skill ?? "").slice(0, 120);
		const file = skillUsagePath(home);
		mkdirSync(dirname(file), { recursive: true });
		const line: SkillInvocation = {
			at: new Date().toISOString(),
			skill,
			args: String(hook.tool_input?.args ?? "").slice(0, 200),
			cwd: process.cwd(),
			lane: resolveFleetLane(hook.cwd ?? process.cwd())?.sid ?? "",
		};
		appendFileSync(file, `${JSON.stringify(line)}\n`);
	} catch {
		// advisory: never block the Skill call on a logging failure
	}
}

// parse NDJSON log text → invocations, skipping corrupt lines honestly
export function parseSkillLog(text: string): SkillInvocation[] {
	const out: SkillInvocation[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as SkillInvocation;
			if (typeof row.skill === "string" && typeof row.at === "string")
				out.push(row);
		} catch {
			// corrupt line: skip, keep the rest
		}
	}
	return out;
}

// pure aggregator: per-skill invocation counts, newest last-used timestamp
export function summarizeSkillUsage(rows: SkillInvocation[]): {
	counts: Map<string, number>;
	lastAt: Map<string, string>;
	total: number;
} {
	const counts = new Map<string, number>();
	const lastAt = new Map<string, string>();
	for (const r of rows) {
		counts.set(r.skill, (counts.get(r.skill) ?? 0) + 1);
		const prev = lastAt.get(r.skill);
		if (!prev || prev < r.at) lastAt.set(r.skill, r.at);
	}
	return { counts, lastAt, total: rows.length };
}

// the never-triggered set: catalog names minus names seen in the log
export function neverInvoked(
	catalog: string[],
	rows: SkillInvocation[],
): string[] {
	const seen = new Set(rows.map((r) => r.skill));
	return catalog.filter((name) => !seen.has(name));
}

// scan dirs (repo skills/, ~/.claude/skills, ...) for SKILL.md subdirs
export function installedCatalog(dirs: string[]): string[] {
	const names = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const e of readdirSync(dir, { withFileTypes: true }))
				if (e.isDirectory() && existsSync(`${dir}/${e.name}/SKILL.md`))
					names.add(e.name);
		} catch {
			// unreadable dir: skip it
		}
	}
	return [...names].sort();
}

// render the usage report: per-skill counts, never-triggered, total
export function renderUsageReport(
	catalog: string[],
	rows: SkillInvocation[],
): string {
	const { counts, lastAt, total } = summarizeSkillUsage(rows);
	const lines: string[] = [];
	lines.push(`skill invocations: ${total}`);
	if (catalog.length > 0) lines.push(`catalog size: ${catalog.length}`);
	const used = catalog.filter((n) => counts.has(n));
	for (const name of used)
		lines.push(
			`  ${name.padEnd(20)} ${String(counts.get(name) ?? 0).padStart(4)}  last ${lastAt.get(name) ?? "?"}`,
		);
	const never = neverInvoked(catalog, rows);
	if (never.length > 0)
		lines.push(`never triggered (${never.length}): ${never.join(", ")}`);
	return lines.join("\n");
}
