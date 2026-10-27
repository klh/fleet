// W1295 law-guard: agent-rules is the ONE source of truth for role rules.
// Unknown roles fail loudly, every rules file parses as markdown with a
// title + EXTENDS line, the tag/title map is pinned, and the installer
// ships the dir. The brief-injection contract rides a fixture brief.
import { expect, test } from "./pw";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_ROLES,
	AGENT_RULES_BASE,
	AGENT_RULES_DIR,
	loadAgentRules,
	ROLE_SELECTORS,
	resolveRoleName,
	selectAgentRole,
} from "../scripts/lib/agent-rules.ts";
import { composeBrief } from "../scripts/lib/brief.ts";
import { sourcePaths } from "../scripts/sync-harness.ts";

const mdFiles = () =>
	readdirSync(AGENT_RULES_DIR).filter(
		(f) => f.endsWith(".md") && f !== "README.md",
	);

const show = (title: string, tags = "fleet"): string =>
	`◐ W1 CLAIMED ${title}\nowner_sid: s\ntags: ${tags}\nalloc_reason: manual take\n`;

const BRIEF_FIXTURE = {
	item: "W1295",
	showOut: show("playwright-only corpus wave", "fleet,playwright-only"),
	sid: "autow-fixture",
	branch: "suspenders/W1295",
	worktree: "/tmp/w1295-fixture",
	capsule: null,
};

test("the registry covers every rules file in agent-rules/", () => {
	expect(new Set(mdFiles())).toEqual(
		new Set([...AGENT_ROLES, AGENT_RULES_BASE]),
	);
});

test("unknown role names fail loudly", () => {
	expect(() => resolveRoleName("bogus.agent.md")).toThrow(
		/unknown agent-rules role/,
	);
	expect(() => loadAgentRules("bogus")).toThrow(/unknown agent-rules role/);
	expect(() => selectAgentRole(show("x"), "bogus")).toThrow(
		/unknown agent-rules role/,
	);
});

test("every rules file parses as markdown: title + role line", () => {
	for (const f of mdFiles()) {
		const text = readFileSync(join(AGENT_RULES_DIR, f), "utf8");
		const [title = ""] = text.split("\n");
		expect([f, title.startsWith("# ")]).toEqual([f, true]);
		if (f === AGENT_RULES_BASE) {
			expect(text).toContain(`# ${AGENT_RULES_BASE}`);
		} else {
			expect(text).toContain("EXTENDS: agent.base.rules.md");
		}
	}
});

test("the tag/title map is pinned (priority order)", () => {
	expect(ROLE_SELECTORS.map((s) => s.role)).toEqual([
		"test.agent.md",
		"reviewer.rules.md",
		"deploy.agent.md",
		"doc.agent.md",
		"component.agent.md",
	]);
	expect([...AGENT_ROLES]).toEqual([
		"code.agent.md",
		"test.agent.md",
		"component.agent.md",
		"deploy.agent.md",
		"doc.agent.md",
		"reviewer.rules.md",
		"supervisor.rules.md",
		"governor.rules.md",
	]);
});

test("selection vectors: tags and titles pick the role", () => {
	expect(selectAgentRole(show("migrate corpus", "fleet,playwright-only"))).toBe(
		"test.agent.md",
	);
	expect(selectAgentRole(show("work.review of W99"))).toBe("reviewer.rules.md");
	expect(selectAgentRole(show("hubctl deploy hardening"))).toBe(
		"deploy.agent.md",
	);
	expect(selectAgentRole(show("docs roll", "fleet,docs"))).toBe("doc.agent.md");
	expect(selectAgentRole(show("board-html token cleanup"))).toBe(
		"component.agent.md",
	);
	expect(selectAgentRole(show("plain implementation lane"))).toBe(
		"code.agent.md",
	);
	expect(selectAgentRole(show("migrate board tests to playwright-only"))).toBe(
		"test.agent.md",
	);
	expect(
		selectAgentRole(show("migrate corpus", "fleet,playwright-only"), "doc"),
	).toBe("doc.agent.md");
});

test("a dispatched brief carries base, then role, then the brief", () => {
	const brief = composeBrief(BRIEF_FIXTURE);
	const iBase = brief.indexOf(`# ${AGENT_RULES_BASE}`);
	const iRole = brief.indexOf("# test.agent.md");
	const iOpen = brief.indexOf("You are lane");
	expect(iBase).toBeGreaterThanOrEqual(0);
	expect(iRole).toBeGreaterThan(iBase);
	expect(iOpen).toBeGreaterThan(iRole);
	expect(brief).toContain("MISSION");
});

test("role:null keeps the legacy no-rules brief shape", () => {
	const brief = composeBrief({ ...BRIEF_FIXTURE, role: null });
	expect(brief).not.toContain(AGENT_RULES_BASE);
	expect(brief).toContain("You are lane");
});

test("a --role override wins over the tag selection", () => {
	const brief = composeBrief({ ...BRIEF_FIXTURE, role: "deploy" });
	expect(brief).toContain("# deploy.agent.md");
	expect(brief).not.toContain("# test.agent.md");
});

test("install ships agent-rules (the computed payload closure)", async () => {
	// W1466: no hand list — lib/agent-rules.ts's import.meta.dir asset edge
	// is what puts the dir in the payload a sync archives.
	expect(await sourcePaths(import.meta.dir)).toContain(
		"packages/suspenders/agent-rules",
	);
});
