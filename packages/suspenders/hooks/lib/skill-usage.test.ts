// hooks/lib/skill-usage.test.ts — W1144: unit legs for the live Skill
// invocation instrumentation — append/parse round-trip into a fixture HOME,
// the pure aggregator, the never-triggered set, catalog scan, and the
// SUSPENDERS_SKILL_LOG off-knob. The gate face itself (log + allow) is
// deliberately trivial; its wiring is proven by any live Skill call.
import { describe, expect, test } from "bun:test";
import {
	appendFileSync,
	chmodSync,
	statSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSkillInvocation,
	installedCatalog,
	neverInvoked,
	parseSkillLog,
	renderUsageReport,
	skillUsagePath,
	shouldLogSkill,
	summarizeSkillUsage,
} from "./skill-usage.ts";

function fixtureHome(): string {
	return mkdtempSync(join(tmpdir(), "w1144-skill-usage-"));
}
function inv(skill: string, at = "t0") {
	return { at, skill, lane: "" };
}

describe("skill-usage", () => {
	test("append + parse round-trip through a fixture HOME", () => {
		const home = fixtureHome();
		appendSkillInvocation(
			{
				tool_name: "Skill",
				tool_input: { skill: "review", args: "focus correctness" },
				cwd: "/tmp",
			},
			home,
		);
		appendSkillInvocation(
			{ tool_name: "Skill", tool_input: { skill: "review" }, cwd: "/tmp" },
			home,
		);
		const rows = parseSkillLog(readFileSync(skillUsagePath(home), "utf8"));
		expect(rows).toHaveLength(2);
		expect(rows[0]?.skill).toBe("review");
		expect(rows[0]).not.toHaveProperty("args");
		expect(rows[0]).not.toHaveProperty("cwd");
		rmSync(home, { recursive: true, force: true });
	});

	test("private metadata excludes synthetic secrets and paths and tightens existing logs", () => {
		const home = fixtureHome();
		const hook = {
			tool_input: { skill: "review", args: "SYNTHETIC_PRIVATE_ARGUMENT_734" },
			cwd: "/synthetic/private/project",
		};
		appendSkillInvocation(hook, home);
		const file = skillUsagePath(home);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		chmodSync(file, 0o644);
		appendSkillInvocation(hook, home);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const raw = readFileSync(file, "utf8");
		expect(raw).not.toContain("SYNTHETIC_PRIVATE_ARGUMENT_734");
		expect(raw).not.toContain("/synthetic/private/project");
		for (const row of parseSkillLog(raw))
			expect(Object.keys(row).sort()).toEqual(["at", "lane", "skill"]);
		rmSync(home, { recursive: true, force: true });
	});

	test("corrupt lines are skipped, valid rows survive", () => {
		const home = fixtureHome();
		appendSkillInvocation(
			{ tool_name: "Skill", tool_input: { skill: "plan" }, cwd: "/tmp" },
			home,
		);
		const file = skillUsagePath(home);
		appendFileSync(file, "{broken json\n");
		appendSkillInvocation(
			{ tool_name: "Skill", tool_input: { skill: "ship" }, cwd: "/tmp" },
			home,
		);
		const rows = parseSkillLog(readFileSync(file, "utf8"));
		expect(rows.map((r) => r.skill)).toEqual(["plan", "ship"]);
		rmSync(home, { recursive: true, force: true });
	});

	test("aggregator counts and lastAt track invocations", () => {
		const rows = [
			inv("review", "2026-10-22T10:00:00Z"),
			inv("review", "2026-10-22T11:00:00Z"),
			inv("ship", "2026-10-22T09:00:00Z"),
		];
		const { counts, lastAt, total } = summarizeSkillUsage(rows);
		expect(counts.get("review")).toBe(2);
		expect(counts.get("ship")).toBe(1);
		expect(lastAt.get("review")).toBe("2026-10-22T11:00:00Z");
		expect(total).toBe(3);
	});

	test("neverInvoked subtracts the seen set from the catalog", () => {
		const catalog = ["review", "ship", "plan"];
		const rows = [inv("review"), inv("ship")];
		expect(neverInvoked(catalog, rows)).toEqual(["plan"]);
		expect(neverInvoked(catalog, [])).toEqual(catalog);
	});

	test("installedCatalog scans dirs for SKILL.md subdirs", () => {
		const dir = fixtureHome();
		mkdirSync(`${dir}/alpha`, { recursive: true });
		writeFileSync(`${dir}/alpha/SKILL.md`, "---\nname: alpha\n---\n");
		mkdirSync(`${dir}/beta`);
		// beta has no SKILL.md → not in catalog
		expect(installedCatalog([dir])).toEqual(["alpha"]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("renderUsageReport names never-triggered skills", () => {
		const report = renderUsageReport(["review", "ghost"], [inv("review")]);
		expect(report).toContain("skill invocations: 1");
		expect(report).toContain("never triggered (1): ghost");
	});

	test("shouldLogSkill honors the SUSPENDERS_SKILL_LOG off-knob", () => {
		const prev = process.env.SUSPENDERS_SKILL_LOG;
		process.env.SUSPENDERS_SKILL_LOG = "0";
		expect(shouldLogSkill()).toBe(false);
		process.env.SUSPENDERS_SKILL_LOG = "";
		expect(shouldLogSkill()).toBe(true);
		if (prev === undefined) delete process.env.SUSPENDERS_SKILL_LOG;
		else process.env.SUSPENDERS_SKILL_LOG = prev;
	});
});
