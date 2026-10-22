#!/usr/bin/env bun
// hooks/bin/skill-usage.ts — W1144 thin face: reads the live Skill-invocation
// log (~/.claude-insights/skill-invocations.ndjson, fed by the pre-skill
// gate) and renders per-skill counts + the never-triggered set against the
// installed catalog. The 2026-09-03 parking cleanup ran on retroactive
// `skillUsage` evidence; this face is the same verdict, continuous.
//   bun hooks/bin/skill-usage.ts [--log FILE] [--catalog DIR ...]
// Empty log = an honest empty report, exit 0.
import { existsSync, readFileSync } from "node:fs";
import {
	installedCatalog,
	parseSkillLog,
	renderUsageReport,
	skillUsagePath,
} from "../lib/skill-usage.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

if (import.meta.main) {
	const outcome = parseVerb(
		defineVerb({
			name: "skill-usage",
			usage:
				"bun hooks/bin/skill-usage.ts [--log FILE] [--catalog DIR ...] [--home DIR]",
			flags: ["--log", "--catalog", "--home"],
			lax: true,
		}),
		process.argv.slice(2),
	);
	if (!outcome.ok) {
		console.error(outcome.message || "bun hooks/bin/skill-usage.ts --help");
		process.exit(2);
	}
	const home = outcome.parsed.flag("--home") ?? undefined;
	const logFile = outcome.parsed.flag("--log") ?? skillUsagePath(home);
	const catalogDirs = [
		...(outcome.parsed.flag("--catalog")
			? [outcome.parsed.flag("--catalog") as string]
			: []),
		`${home ?? process.env.HOME ?? ""}/.claude/skills`,
	];
	const catalog = installedCatalog(catalogDirs);
	const rows = existsSync(logFile)
		? parseSkillLog(readFileSync(logFile, "utf8"))
		: [];
	console.log(renderUsageReport(catalog, rows));
}
