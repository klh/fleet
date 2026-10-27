// scripts/lib/check-versions.ts — W1303.1.6: the P1 version guard (PaaS
// standard §Enforcement `tools/src/check-versions.ts`, fleet-adapted).
// READ-ONLY over the release core (release-version.ts) — never edits a
// manifest. Fails when:
//   · any version or dependency spec is not plain MAJOR.MINOR.PATCH
//     (including @klh/* siblings — no ranges, no workspace:* protocol)
//   · the workspaces disagree on the repo version
//   · the root manifest declares dependencies
//   · a directory under the workspaces globs has no package.json
// Pure plan surface: returns explicit findings; tests drive scratch repos.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	agreement,
	DEP_MAPS,
	discoverManifests,
	SEMVER_RE,
	workspaceDirsAll,
} from "./release-version.ts";

export type VersionFindingCode =
	| "root-deps"
	| "missing-manifest"
	| "bad-version"
	| "bad-dep-spec"
	| "drift"
	| "no-such-package";

export interface VersionFinding {
	code: VersionFindingCode;
	/** repo-relative manifest path the finding names */
	file: string;
	message: string;
}

export interface VersionsReport {
	ok: boolean;
	findings: VersionFinding[];
	/** manifests scanned (root + workspace manifests; scoped runs: in-scope only) */
	manifests: number;
}

/** [dep map kind, name, spec] across every map the guard checks. */
const depEntries = (
	json: Record<string, unknown>,
): [map: string, name: string, spec: string][] => {
	const out: [string, string, string][] = [];
	for (const m of DEP_MAPS) {
		const map = json[m];
		if (map === undefined || map === null || typeof map !== "object") continue;
		for (const [name, spec] of Object.entries(map as Record<string, string>))
			out.push([m, name, spec]);
	}
	return out;
};

export function checkVersions(
	root: string,
	packageName?: string,
): VersionsReport {
	const findings: VersionFinding[] = [];
	const rootPath = join(root, "package.json");
	if (!existsSync(rootPath))
		throw new Error(`check-versions: no root package.json under ${root}`);
	const rootJson = JSON.parse(readFileSync(rootPath, "utf8")) as {
		name?: string;
		version?: string;
		workspaces?: string[] | string;
	};
	// scope: a package dir name or manifest name, with or without @klh/
	const scoped =
		packageName === undefined ? null : packageName.replace(/^@klh\//, "");
	const inScope = (rel: string, pkgName?: string): boolean => {
		if (scoped === null) return true;
		const segs = rel.split("/");
		const dir = segs.length >= 2 ? segs[segs.length - 2] : "";
		if (dir === scoped) return true;
		return pkgName !== undefined && pkgName.replace(/^@klh\//, "") === scoped;
	};

	// 1 · the root manifest is not a package: no dependency maps
	if (inScope("package.json", rootJson.name)) {
		for (const m of DEP_MAPS) {
			const map = rootJson[m];
			if (
				map === undefined ||
				map === null ||
				typeof map !== "object" ||
				Object.keys(map as Record<string, string>).length === 0
			)
				continue;
			findings.push({
				code: "root-deps",
				file: "package.json",
				message: `root manifest declares ${m} — the repo root is not a package`,
			});
		}
	}

	// 2 · every directory the workspaces globs cover holds a manifest
	const patterns = Array.isArray(rootJson.workspaces)
		? rootJson.workspaces
		: typeof rootJson.workspaces === "string"
			? [rootJson.workspaces]
			: [];
	for (const d of workspaceDirsAll(root, patterns)) {
		if (existsSync(join(root, d, "package.json"))) continue;
		if (!inScope(`${d}/package.json`)) continue;
		findings.push({
			code: "missing-manifest",
			file: `${d}/package.json`,
			message: `workspaces globs cover ${d}/ but it has no package.json`,
		});
	}

	// 3 · the one-version set: exact manifest versions + exact dep specs
	let scanned = 0;
	for (const ref of discoverManifests(root)) {
		const json = JSON.parse(readFileSync(ref.path, "utf8")) as Record<
			string,
			unknown
		>;
		const name = typeof json.name === "string" ? json.name : undefined;
		if (!inScope(ref.rel, name)) continue;
		scanned++;
		if (!SEMVER_RE.test(ref.version))
			findings.push({
				code: "bad-version",
				file: ref.rel,
				message: `version ${
					ref.version === "" ? "(absent)" : ref.version
				} is not plain MAJOR.MINOR.PATCH`,
			});
		for (const [map, dep, spec] of depEntries(json))
			if (!SEMVER_RE.test(spec))
				findings.push({
					code: "bad-dep-spec",
					file: ref.rel,
					message: `${map}: ${dep}@${spec} is not pinned exact MAJOR.MINOR.PATCH`,
				});
	}

	// 4 · the workspaces agree on ONE version (drift rows outside a scoped
	// run's package are not that package's findings)
	const agr = agreement(root);
	for (const d of agr.drift)
		if (inScope(d.rel))
			findings.push({
				code: "drift",
				file: d.rel,
				message: `version ${
					d.version === "" ? "(absent)" : d.version
				} disagrees with the repo version ${agr.current ?? "(none)"}`,
			});

	if (scoped !== null && scanned === 0)
		findings.push({
			code: "no-such-package",
			file: `packages/${scoped}`,
			message: `no workspace manifest matches package ${packageName}`,
		});

	findings.sort(
		(a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code),
	);
	return { ok: findings.length === 0, findings, manifests: scanned };
}
