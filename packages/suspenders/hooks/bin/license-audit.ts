#!/usr/bin/env bun
// hooks/bin/license-audit.ts — CLI face of the W828 license audit
// (hooks/lib/license-audit.ts): the PolyForm noncommercial perimeter.
// Composes the report (node_modules walk + vendored banners + model
// weights + external adopt-protocol map), writes the artifact json the
// W822 pulse reads, lands finding.license-audit, and exits 1 when
// violations exist that the machine-local accepted baseline doesn't
// cover. `--accept` folds today's violations into that baseline.
//
//   bun hooks/bin/license-audit.ts [--json] [--accept] [--repo <dir>]
//        [--no-emit]
//
// The audit is read-only by nature; --accept is the only mutation. The
// fleet-loop maintenance registry (W779) fires it daily. Exit 1 =
// unaccepted violations (a human should notice).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	composeLicenseReport,
	type LicenseReport,
	loadAccepted,
	licenseArtifactPath,
	parseModelIds,
	saveAccepted,
	violationKey,
} from "../lib/license-audit.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const FACT_KEY = "finding.license-audit";

const SPEC = defineVerb({
	name: "license-audit",
	usage:
		"usage: bun license-audit.ts [--json] [--accept] [--repo <dir>] [--no-emit]",
	flags: ["--repo"],
	switches: ["--json", "--accept", "--no-emit"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("license-audit")(outcome.message || (SPEC.usage ?? ""));
const json = outcome.parsed.flag("--json") === "true";
const accept = outcome.parsed.flag("--accept") === "true";
const noEmit = outcome.parsed.flag("--no-emit") === "true";
const repo = outcome.parsed.flag("--repo") ?? process.cwd();

// fact child — 30s cap, failures logged never thrown (advisory surface)
function emitFact(text: string): boolean {
	const coord = join(import.meta.dir, "coord.ts");
	try {
		const p = Bun.spawnSync(
			[
				process.execPath,
				coord,
				"fact",
				"set",
				FACT_KEY,
				"--text",
				text,
				"--source",
				"fleet-loop",
			],
			{ stdout: "pipe", stderr: "pipe", timeout: 30_000 },
		);
		return p.exitCode === 0;
	} catch {
		return false;
	}
}

function digest(r: LicenseReport): string {
	return (
		`license-audit: ${r.totals.packages} pkgs · ${r.totals.violations} violation(s) · ` +
		`vendored ${r.totals.vendor.present}/${r.totals.vendor.total} · ` +
		`models ${r.totals.models.flagged}/${r.totals.models.total} flagged nc-only`
	);
}

async function loadModels(): Promise<ReturnType<typeof parseModelIds>> {
	const registryPath = join(repo, "packages", "belt", "bin", "registry.ts");
	try {
		return parseModelIds(await Bun.file(registryPath).text());
	} catch {
		return [];
	}
}

async function main(): Promise<void> {
	const modelRows = await loadModels();
	const report = composeLicenseReport({
		repo,
		models: () => modelRows,
	});
	const path = licenseArtifactPath();
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		await Bun.write(path, `${JSON.stringify(report, null, "\t")}\n`);
	} catch (e) {
		console.error(
			`license-audit: artifact write failed: ${e instanceof Error ? e.message : e}`,
		);
	}

	if (accept) {
		const keys = new Set(loadAccepted());
		for (const v of report.violations) keys.add(violationKey(v));
		saveAccepted(keys);
		console.log(
			`license-audit: baseline now ${keys.size} accepted violation key(s)`,
		);
	}

	console.log(digest(report));
	for (const v of report.violations.slice(0, 10))
		console.log(
			`  ${v.cls}: ${v.name}@${v.version} (${v.license}) — ${v.reason}`,
		);
	for (const m of report.models.filter((x) => x.commercial === false))
		console.log(`  nc-only model :${m.port} ${m.model} (${m.license})`);

	if (!noEmit && !emitFact(digest(report)))
		console.error("license-audit: coord fact set failed (non-fatal)");

	if (json) console.log(JSON.stringify(report, null, 2));

	// exit 1 only on violations the accepted baseline does not cover
	const accepted = loadAccepted();
	const fresh = report.violations.filter((v) => !accepted.has(violationKey(v)));
	process.exit(fresh.length > 0 ? 1 : 0);
}

await main();
