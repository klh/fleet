#!/usr/bin/env bun
// scripts/check-versions.ts — W1303.1.6: the P1 version-guard verb (PaaS
// standard §Enforcement). Read-only over the release core (lib/release-
// version.ts): exact MAJOR.MINOR.PATCH versions and dep specs everywhere
// (including @klh/* siblings), workspaces agree on the one version, the
// root manifest declares no dependencies, and every directory the
// workspaces globs cover holds a manifest. Exit 0 = green, 1 = findings.
//   bun scripts/check-versions.ts                     # whole repo
//   bun scripts/check-versions.ts check <package>     # one package (dir
//                                                     #  or @klh/<name>)
//   bun scripts/check-versions.ts --json              # machine findings
import { join } from "node:path";
import { defineVerb, runCli } from "../hooks/lib/verb-kit.ts";
import { checkVersions } from "./lib/check-versions.ts";

const repo = join(import.meta.dir, "..", "..", "..");

const check = defineVerb({
	name: "check",
	usage: "usage: check-versions check [<package>] [--json]",
	minPos: 0,
	flags: [],
	switches: ["--json"],
	run: (p) => {
		const pkg = p.pos[0];
		const report = checkVersions(repo, pkg);
		if (p.flag("--json") !== null) {
			console.log(JSON.stringify(report, null, "\t"));
			return report.ok ? 0 : 1;
		}
		const head = pkg
			? `check-versions: package ${pkg} — ${report.manifests} manifest(s) scanned, ${report.findings.length} finding(s)`
			: `check-versions: ${report.manifests} manifest(s) scanned, ${report.findings.length} finding(s)`;
		console.log(
			[
				head,
				...report.findings.map((f) => `  ${f.file}: ${f.message}`),
				report.ok ? "versions: OK" : "versions: FAILED",
			].join("\n"),
		);
		return report.ok ? 0 : 1;
	},
});

await runCli({
	prog: "check-versions",
	about: "P1 version guard: exact pins + one-version agreement",
	verbs: [check],
	defaultVerb: "check",
});
