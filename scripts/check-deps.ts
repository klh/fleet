#!/usr/bin/env bun
// scripts/check-deps.ts — W1303.1.7 P1 dependency guard: one CLI over the
// W1249 import-graph scanner (tests/helpers/fleet.import-graph.lib.ts —
// the same single scan the guard tests derive every law from). Finding
// surfaces, all failure-shaped and rendered with file:package detail:
//   phantom  — an import with no declaration (runtime ⇒ "dependencies",
//              test/content ⇒ deps or devDeps; the W649 position classes)
//   unused   — a declared @klh/* dep the package never imports
//   reachin  — a relative import leaving its workspace, outside the pinned
//              shrink-only ratchet (tests/helpers/fleet.import-ratchet.pin.ts)
//   kernel   — kernel importing anything in fleet (direction law; vacuous
//              until packages/kernel exists — the guard fixture has teeth)
//   parse    — a file the transpiler could not scan (never silently skipped)
// The tool reports; it never edits manifests and never re-pins — fixes land
// in code, or (deliberately, in the same landing) in the pin file.
import { resolve } from "node:path";
import { defineVerb, runCli } from "../packages/suspenders/hooks/lib/verb-kit.ts";
import {
	edgeKey,
	kernelViolations,
	phantoms,
	reachIns,
	scanFleet,
	unusedDeclaredKlh,
} from "../tests/helpers/fleet.import-graph.lib.ts";
import { REACH_IN_PIN } from "../tests/helpers/fleet.import-ratchet.pin.ts";

export type DepFindingKind =
	| "phantom"
	| "unused"
	| "reachin"
	| "kernel"
	| "parse";

export interface DepFinding {
	kind: DepFindingKind;
	/** source package of the finding (kernel rows carry "kernel") */
	pkg: string;
	detail: string;
}

export interface DepsReport {
	root: string;
	packageName?: string;
	findings: DepFinding[];
}

/** The dependency law over one scan. packageName scopes every detector to
 *  that package's rows; undefined = the whole fleet. */
export async function checkDeps(
	root: string,
	packageName?: string,
): Promise<DepsReport> {
	const fleet = await scanFleet(resolve(root));
	const want = (pkg: string) => !packageName || pkg === packageName;
	const findings: DepFinding[] = [];
	for (const [pkg, scan] of fleet.scans)
		for (const f of scan.parseFails)
			if (want(pkg))
				findings.push({
					kind: "parse",
					pkg,
					detail: `${pkg}/${f} does not parse — the file rides NO scan-derived check`,
				});
	for (const p of phantoms(fleet))
		if (want(p.pkg))
			findings.push({
				kind: "phantom",
				pkg: p.pkg,
				detail: `${p.pkg}: ${p.name} imported but undeclared (${
					p.runtime ? "runtime → dependencies" : "test → deps or devDeps"
				}) — ${p.files.join(", ")}`,
			});
	for (const u of unusedDeclaredKlh(fleet))
		if (want(u.pkg))
			findings.push({
				kind: "unused",
				pkg: u.pkg,
				detail: `${u.pkg} declares ${u.name} but never imports it`,
			});
	const pinned = new Set(REACH_IN_PIN.trim().split("\n"));
	for (const e of reachIns(fleet))
		if (want(e.sourcePkg) && !pinned.has(edgeKey(e)))
			findings.push({
				kind: "reachin",
				pkg: e.sourcePkg,
				detail: `new reach-in edge ${edgeKey(e)} — import package names (@klh/*), never relative reach-ins, or re-pin deliberately in the landing that adds it`,
			});
	for (const e of kernelViolations(fleet))
		if (want(e.sourcePkg))
			findings.push({
				kind: "kernel",
				pkg: e.sourcePkg,
				detail: `kernel imports fleet: ${edgeKey(e)}`,
			});
	findings.sort(
		(a, b) =>
			a.kind.localeCompare(b.kind) ||
			a.pkg.localeCompare(b.pkg) ||
			a.detail.localeCompare(b.detail),
	);
	return { root: fleet.root, packageName, findings };
}

const check = defineVerb({
	name: "check",
	usage:
		"check [--root <dir>] [--package <name>] — scan declared imports + workspace boundaries",
	flags: ["--root", "--package"],
	run: async (p) => {
		const root = p.flag("--root") ?? resolve(import.meta.dir, "..");
		const pkg = p.flag("--package");
		const report = await checkDeps(root, pkg ?? undefined);
		const scope = report.packageName ? ` (${report.packageName})` : "";
		if (report.findings.length) {
			for (const f of report.findings) console.log(`${f.kind}\t${f.detail}`);
			console.error(
				`check-deps: ${report.findings.length} finding(s) — ${report.root}${scope}`,
			);
			return 1;
		}
		console.log(`check-deps: clean — ${report.root}${scope}`);
		return 0;
	},
});

if (import.meta.main)
	await runCli({
		prog: "check-deps",
		about: "P1 dependency guard: declared imports + workspace boundaries",
		verbs: [check],
		defaultVerb: "check",
	});
