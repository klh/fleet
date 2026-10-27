// scripts/lib/agent-rules.ts — role selection + rules loading for the
// dispatch brief (W1295). packages/suspenders/agent-rules is the ONE source
// of truth for role rules (central-configs law): dispatch injects
// agent.base.rules.md, then the role file, then the item brief — the brief
// wins over the role, the role over the base. The registry and the
// tag/title selectors live here as DATA so the law-guard can pin them.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** agent-rules dir — the repo layout mirrors the installed .harness payload,
 *  so this module-relative walk resolves in both (sync-harness ships the dir). */
export const AGENT_RULES_DIR = resolve(import.meta.dir, "../../agent-rules");

/** the shared contract every role extends (injected FIRST). */
export const AGENT_RULES_BASE = "agent.base.rules.md";

/** role files reachable through --role / selection (README carries the map). */
export const AGENT_ROLES = [
	"code.agent.md",
	"test.agent.md",
	"component.agent.md",
	"deploy.agent.md",
	"doc.agent.md",
	"reviewer.rules.md",
	"supervisor.rules.md",
	"governor.rules.md",
] as const;

export type AgentRoleFile = (typeof AGENT_ROLES)[number];

/** tag/title → role, priority order (first hit wins, default code.agent.md).
 *  Matched against the item's TITLE line + tags line ONLY — mission bodies
 *  quote role names and would self-select. Pinned by the law-guard. */
export const ROLE_SELECTORS: ReadonlyArray<{
	role: AgentRoleFile;
	patterns: RegExp[];
}> = [
	{
		role: "test.agent.md",
		patterns: [
			/\bplaywright[- ]only\b/i,
			/\btest (dry|migration|authoring|wave)\b/i,
		],
	},
	{
		role: "reviewer.rules.md",
		patterns: [/\bwork\.review\b/, /\breview lanes?\b/i],
	},
	{
		role: "deploy.agent.md",
		patterns: [/\bhubctl\b/i, /\blaunchd\b/i, /\bcompose\b/i],
	},
	{
		role: "doc.agent.md",
		patterns: [
			/\bdocs\b/i,
			/\bdocumentation\b/i,
			/\bknowledge (roll|sync|worker)\b/,
			/\bllms\.txt\b/,
		],
	},
	{
		role: "component.agent.md",
		patterns: [
			/\bboard[- ]?html\b/i,
			/\bdesign[- ]tokens?\b/i,
			/\bboards?\b/i,
			/\bdashboard\b/i,
			/\bui\b/i,
		],
	},
];

/** `"supervisor"` or `"supervisor.rules.md"` → the registry file; an unknown
 *  role dies loudly with the registry (fail-loud contract). */
export const resolveRoleName = (name: string): AgentRoleFile => {
	const bare = name.trim().replace(/\.md$/, "").toLowerCase();
	const hit = AGENT_ROLES.find(
		(f) =>
			f.replace(/\.md$/, "") === bare || f.split(".")[0] === bare || f === name,
	);
	if (hit) return hit;
	throw new Error(
		`unknown agent-rules role "${name}" — known roles: ${AGENT_ROLES.join(", ")}`,
	);
};

/** read base + role verbatim (the brief inlines the bytes; authoring stays
 *  referenced-not-copied). Unknown role dies loudly via resolveRoleName. */
export const loadAgentRules = (
	role: string,
): { base: string; roleFile: AgentRoleFile; roleBody: string } => {
	const roleFile = resolveRoleName(role);
	return {
		base: readFileSync(join(AGENT_RULES_DIR, AGENT_RULES_BASE), "utf8"),
		roleFile,
		roleBody: readFileSync(join(AGENT_RULES_DIR, roleFile), "utf8"),
	};
};

/** title line + tags line of a `work show` text — the selection surface. */
const selectText = (showOut: string): string => {
	const [first = ""] = showOut.split("\n");
	const tags = showOut.match(/^tags: (.*)$/m)?.[1] ?? "";
	return `${first}\n${tags}`;
};

/** pick the role file for an item: `roleOverride` wins verbatim, else the
 *  first selector hit on title+tags, else code.agent.md (the default role). */
export const selectAgentRole = (
	showOut: string,
	roleOverride?: string,
): AgentRoleFile => {
	if (roleOverride) return resolveRoleName(roleOverride);
	const text = selectText(showOut);
	for (const { role, patterns } of ROLE_SELECTORS)
		if (patterns.some((p) => p.test(text))) return role;
	return "code.agent.md";
};
