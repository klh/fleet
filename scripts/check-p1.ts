#!/usr/bin/env bun
// scripts/check-p1.ts — W1303.1.5 P1 completion gate: one pass over the
// three P1 guards (check-versions, check-deps, check-pack), every finding
// matched against the shrink-only pin (tests/helpers/p1-findings.pin.ts);
// unpinned findings fail. The pin lets the gate ride the push hook WITHOUT
// blocking on findings owned by landed-but-unmerged child evidence
// (W1303.1.1/.9): a row is removed when its finding is fixed upstream, so
// the gate only ever tightens. --write-pin re-stamps the pin from the live
// run (deliberate, same landing as the change that adds a finding).
//   bun scripts/check-p1.ts gate                 # all three guards
//   bun scripts/check-p1.ts gate --no-pack       # fast legs only
//   bun scripts/check-p1.ts gate --write-pin     # re-stamp from live run
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkVersions } from "../packages/suspenders/scripts/lib/check-versions.ts";
import {
	checkOne,
	fleetPackages,
	siblingClosure,
	type PackReport,
} from "../packages/suspenders/scripts/check-pack.ts";
import { checkDeps } from "./check-deps.ts";
import {
	defineVerb,
	runCli,
} from "../packages/suspenders/hooks/lib/verb-kit.ts";
import {
	P1_PIN,
	type P1Check,
	type P1PinRow,
} from "../tests/helpers/p1-findings.pin.ts";

const PIN_PATH = resolve(import.meta.dir, "../tests/helpers/p1-findings.pin.ts");

export type { P1Check };

export interface P1Finding {
	check: P1Check;
	/** package the finding is scoped to (dir name, no @klh/ prefix) */
	pkg: string;
	/** stable identity of the finding (pin rows match by startsWith) */
	prefix: `${string}: ${string}`;
}

export interface P1Report {
	ok: boolean;
	/** findings excused by a pin row */
	pinned: number;
	findings: P1Finding[];
}

const pkgOfManifest = (file: string): string => file.split("/")[1] ?? "?";

export const normalizeVersions = (root: string): P1Finding[] =>
	checkVersions(root).findings.map((f) => ({
		check: "versions",
		pkg: pkgOfManifest(f.file),
		prefix: `${f.file}: ${f.message}`,
	}));

export const normalizeDeps = async (root: string): Promise<P1Finding[]> => {
	const report = await checkDeps(root);
	return report.findings.map((f) => ({
		check: "deps",
		pkg: f.pkg,
		prefix: `${f.kind}: ${f.detail}`,
	}));
};

const packFindings = (reports: readonly PackReport[]): P1Finding[] =>
	reports.flatMap((r) =>
		r.findings.map((f) => ({
			check: "pack",
			pkg: r.pkg.replace(/^@klh\//, ""),
			prefix: `${f.kind}: ${f.detail}`,
		})),
	);

export const normalizePack = (): P1Finding[] => {
	const entries = fleetPackages();
	const closure = siblingClosure(entries);
	return packFindings(entries.map((e) => checkOne(e, closure)));
};

/** A pin row excuses a finding when check+pkg match and the finding's
 *  prefix starts with the row's (so pin rows may hold just the stable
 *  head of a detail that carries a run-local tail). */
export const isPinned = (row: P1PinRow, f: P1Finding): boolean =>
	row.check === f.check && row.pkg === f.pkg && f.prefix.startsWith(row.prefix);

export async function checkP1(
	root: string,
	opts: { pack?: boolean } = {},
): Promise<P1Report> {
	const { pack = true } = opts;
	const found: P1Finding[] = [
		...normalizeVersions(root),
		...(await normalizeDeps(root)),
		...(pack ? normalizePack() : []),
	];
	const findings = found.filter((f) => !P1_PIN.some((row) => isPinned(row, f)));
	return { ok: findings.length === 0, pinned: found.length - findings.length, findings };
}

const renderPin = (found: readonly P1Finding[]): string => {
	const rows = [...found]
		.sort(
			(a, b) =>
				a.check.localeCompare(b.check) ||
				a.pkg.localeCompare(b.pkg) ||
				a.prefix.localeCompare(b.prefix),
		)
		.map(
			(f) =>
				`\t{ check: "${f.check}", pkg: "${f.pkg}", prefix: ${JSON.stringify(f.prefix)} },`,
		)
		.join("\n");
	const body = rows.length ? `\n${rows}\n` : "";
	return `// tests/helpers/p1-findings.pin.ts — W1303.1.5: shrink-only pin of the P1
// guards' known findings (check-p1.ts --write-pin re-stamps it from the
// live run). A row excuses ONE finding shape on same check+pkg by prefix
// (startsWith). Remove a row when its finding is fixed upstream; a new
// finding fails the gate until it is either fixed or deliberately
// re-stamped in the landing that adds it.
export type P1Check = "versions" | "deps" | "pack";

export interface P1PinRow {
	check: P1Check;
	/** package the row is scoped to (dir name, no @klh/ prefix) */
	pkg: string;
	/** the excused finding's stable prefix (startsWith match) */
	prefix: string;
}

export const P1_PIN: readonly P1PinRow[] = [${body}];
`;
};

const writePin = async (root: string): Promise<number> => {
	const found: P1Finding[] = [
		...normalizeVersions(root),
		...(await normalizeDeps(root)),
		...normalizePack(),
	];
	writeFileSync(PIN_PATH, renderPin(found));
	console.log(`check-p1: pin re-stamped — ${found.length} row(s) → ${PIN_PATH}`);
	return 0;
};

const gate = defineVerb({
	name: "gate",
	usage: "gate [--no-pack] [--write-pin] — the P1 guards vs the pin",
	flags: [],
	switches: ["--no-pack", "--write-pin", "--json"],
	minPos: 0,
	run: async (p) => {
		const root = resolve(import.meta.dir, "..");
		if (p.flag("--write-pin") !== null) return writePin(root);
		const report = await checkP1(root, { pack: p.flag("--no-pack") === null });
		if (p.flag("--json") !== null) {
			console.log(JSON.stringify(report, null, "\t"));
			return report.ok ? 0 : 1;
		}
		console.log(
			`check-p1: ${report.findings.length} unpinned, ${report.pinned} pinned`,
		);
		for (const f of report.findings)
			console.log(`  ${f.check}/${f.pkg}: ${f.prefix}`);
		console.error(
			report.ok
				? "check-p1: P1 contract holds"
				: "check-p1: unpinned findings — fix or re-stamp the pin in the same landing",
		);
		return report.ok ? 0 : 1;
	},
});

if (import.meta.main)
	await runCli({
		prog: "check-p1",
		about: "P1 completion gate: versions+deps+pack vs the shrink-only pin",
		verbs: [gate],
		defaultVerb: "gate",
	});
