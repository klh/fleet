#!/usr/bin/env bun
// check-pack — the W1303.1 scratch-install guard: what a tarball of each
// fleet package actually installs is what consumers get. For every package
// (vendored decant exempt): `bun pm pack`, install the tarball into a
// FRESH scratch dir (private @klh/* siblings resolved via root overrides
// pointing at sibling tarballs — bun has no workspace context in scratch),
// then prove the INSTALL, not the checkout:
//   imports — every shipped .ts/.js is scanned (Bun.Transpiler.scanImports,
//     dynamic imports included) and every import must resolve inside the
//     install: relative specs that escape the package root are the hidden
//     parent-path deps this guard exists to catch (they resolve in the
//     monorepo, break in every real install); bare specs must resolve from
//     the importing file (declared deps install, undeclared ones do not);
//   exports — every manifest exports entry maps to a file/dir that shipped;
//   bins — every bin runs `--help` and exits without a module-resolution
//     error (a bin that cannot load its graph is broken for consumers).
// Missing manifest fields are NOTES, not findings (manifest repair is the
// W1303.1.9 lane; this guard proves what the manifest declares).
// Findings → exit 1; --json emits one NDJSON report object per package.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export type Finding = { kind: string; detail: string };
export type BinResult = { name: string; pass: boolean; note: string };
export type PackReport = {
	pkg: string;
	packed: boolean;
	installed: boolean;
	filesScanned: number;
	findings: Finding[];
	notes: string[];
	bins: BinResult[];
};

// Shrink-only skip pin: these belt bins ignore --help and start serving
// (they never exit under the flag). Remove an entry when its bin learns
// --help; never add one without a recorded reason — the default proof is
// every bin, every run.
export const BIN_SKIP: Readonly<Record<string, readonly string[]>> = {
	belt: ["m365-serve", "llm-stack"],
};

const MODULE_ERR = /Module not found|Cannot find module|ModuleNotFound/;

export const binPass = (
	exitCode: number | null,
	output: string,
): { pass: boolean; note: string } => {
	if (exitCode === null) return { pass: false, note: "timed out under --help" };
	if (MODULE_ERR.test(output))
		return { pass: false, note: "module resolution error" };
	return { pass: true, note: `exit ${exitCode}` };
};

// Candidate specifiers a relative import may denote (extensionless,
// extension-swapped, directory index) — explicit list so resolution never
// depends on resolver ambient behavior.
const relCandidates = (fromDir: string, spec: string): string[] => {
	const base = resolve(fromDir, spec);
	const exts = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs"];
	const out: string[] = [];
	for (const e of exts) {
		out.push(base + e);
		out.push(join(base, `index${e}`));
	}
	return out;
};

const importLoader = (file: string): "ts" | "js" | null =>
	file.endsWith(".ts") || file.endsWith(".tsx")
		? "ts"
		: /\.(js|mjs|cjs)$/.test(file)
			? "js"
			: null;

export const walkCode = (root: string): string[] => {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
			const p = join(dir, ent.name);
			if (ent.isDirectory()) walk(p);
			else if (ent.isFile() && importLoader(p)) out.push(p);
		}
	};
	walk(root);
	return out;
};

// THE proof: scan every shipped file's import graph against an install
// root. Relative specs must land inside the package; bare specs must
// resolve (builtins excepted). `resolveBare` is injected so tests can run
// this against synthetic trees without a real node_modules.
export const checkInstallGraph = (
	installRoot: string,
	pkgRoot: string,
	files: readonly string[],
	resolveBare: (spec: string, fromDir: string) => string,
): Finding[] => {
	const findings: Finding[] = [];
	for (const file of files) {
		let code: string;
		try {
			code = readFileSync(file, "utf8");
		} catch {
			continue; // unreadable file is not an import-graph defect
		}
		let specs: { path: string }[];
		try {
			specs = new Bun.Transpiler({
				loader: importLoader(file) ?? "ts",
			}).scanImports(code);
		} catch {
			continue; // unparseable non-code is out of scope here
		}
		for (const { path: spec } of specs) {
			const rel = relative(installRoot, file);
			if (spec.startsWith(".")) {
				const hit = relCandidates(dirname(file), spec).find((c) =>
					existsSync(c),
				);
				if (!hit) {
					findings.push({
						kind: "broken-import",
						detail: `${rel}: "${spec}" resolves to nothing in the install`,
					});
					continue;
				}
				if (!hit.startsWith(pkgRoot)) {
					findings.push({
						kind: "parent-path-escape",
						detail: `${rel}: "${spec}" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout`,
					});
				}
			} else if (
				!spec.startsWith("node:") &&
				spec !== "bun" &&
				!spec.startsWith("bun:")
			) {
				try {
					resolveBare(spec, dirname(file));
				} catch (err) {
					findings.push({
						kind: "unresolved-dep",
						detail: `${rel}: "${spec}" does not resolve from the install (${String(err).split("\n")[0]})`,
					});
				}
			}
		}
	}
	return findings;
};

// Exports-entry proof: literal entries must ship; pattern/dir entries must
// have at least one concrete match inside the install.
export const checkExportsMap = (
	pkgRoot: string,
	exportsMap: Record<string, unknown>,
): Finding[] => {
	const findings: Finding[] = [];
	for (const [entry, target] of Object.entries(exportsMap)) {
		if (typeof target !== "string") {
			findings.push({
				kind: "exports-shape",
				detail: `exports "${entry}" is not a plain string mapping`,
			});
			continue;
		}
		if (entry.endsWith("*") || target.endsWith("*")) {
			const dir = resolve(pkgRoot, dirname(target));
			if (!existsSync(dir)) {
				findings.push({
					kind: "exports-missing",
					detail: `exports "${entry}" pattern base ${dirname(target)} did not ship`,
				});
			}
			continue;
		}
		if (!existsSync(resolve(pkgRoot, target))) {
			findings.push({
				kind: "exports-missing",
				detail: `exports "${entry}" → "${target}" did not ship`,
			});
		}
	}
	return findings;
};

// Stray sweep: pack output left inside the repo (bun writes the tarball to
// the package CWD regardless of --pack-destination) is repo dirt AND proof
// pollution — every run must leave the tree as it found it.
export const findStrayTarballs = (
	pkgDirs: readonly { dir: string; path: string }[],
	repoRoot: string,
): Finding[] => {
	const findings: Finding[] = [];
	for (const { dir, path } of pkgDirs) {
		for (const f of readdirSync(path)) {
			if (f.endsWith(".tgz")) {
				findings.push({
					kind: "stray-tarball",
					detail: `${dir}/${f} left behind by a pack run`,
				});
			}
		}
	}
	for (const f of readdirSync(repoRoot)) {
		if (f.endsWith(".tgz")) {
			findings.push({
				kind: "stray-tarball",
				detail: `${f} at the repo root — an accidental root-dir pack (the whole repo tarred)`,
			});
		}
	}
	return findings;
};

const dec = (s: Uint8Array | undefined): string =>
	new TextDecoder().decode(s ?? new Uint8Array());

const run = (
	cmd: string[],
	opts: { cwd: string; timeout: number },
): { exitCode: number | null; output: string } => {
	const o = Bun.spawnSync(cmd, {
		cwd: opts.cwd,
		timeout: opts.timeout,
		env: { ...process.env },
	});
	return { exitCode: o.exitCode, output: `${dec(o.stdout)}${dec(o.stderr)}` };
};

const PACK_TIMEOUT_MS = 60_000;
export const INSTALL_TIMEOUT_MS = 120_000;
export const BIN_TIMEOUT_MS = 15_000;
const VENDORED = new Set(["decant"]);
export const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PACKAGES_ROOT = join(REPO_ROOT, "packages");

type Manifest = {
	name?: string;
	dependencies?: Record<string, string>;
	exports?: Record<string, unknown>;
	bin?: Record<string, string> | string;
};

const readManifest = (path: string): Manifest =>
	JSON.parse(readFileSync(join(path, "package.json"), "utf8"));

export const fleetPackages = (): { dir: string; path: string }[] =>
	readdirSync(PACKAGES_ROOT, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !VENDORED.has(e.name))
		.map((e) => ({ dir: e.name, path: join(PACKAGES_ROOT, e.name) }))
		.filter(({ path }) => existsSync(join(path, "package.json")));

// Pack one package, return the tarball filename (parsed from pack output —
// bun writes it into the package CWD) or null.
const packOne = (path: string): string | null => {
	const { exitCode, output } = run(["bun", "pm", "pack"], {
		cwd: path,
		timeout: PACK_TIMEOUT_MS,
	});
	if (exitCode !== 0) return null;
	const names = [...output.matchAll(/(\S+\.tgz)/g)].map((m) => m[1]);
	return names.length ? names[names.length - 1] : null;
};

// BFS over @klh/* deps: every private sibling that must ride the scratch
// install as a file: override (transitives included).
export const siblingClosure = (
	entries: readonly { dir: string; path: string }[],
): { dir: string; path: string; name: string }[] => {
	const byName = new Map<string, { dir: string; path: string }>();
	for (const e of entries) {
		const m = readManifest(e.path);
		if (m.name) byName.set(m.name, e);
	}
	const out: { dir: string; path: string; name: string }[] = [];
	const seen = new Set<string>();
	const queue = entries.slice();
	while (queue.length) {
		const e = queue.shift();
		if (!e || seen.has(e.dir)) continue;
		seen.add(e.dir);
		const m = readManifest(e.path);
		if (!m.name) continue;
		out.push({ ...e, name: m.name });
		for (const dep of Object.keys(m.dependencies ?? {})) {
			const sib = byName.get(dep);
			if (sib && !seen.has(sib.dir)) queue.push(sib);
		}
	}
	return out;
};

// Pack the entry + every closure sibling, stage tarballs scratch-side.
// bun writes each tarball into the package CWD (it ignores
// --pack-destination), so every pack is followed by an inline move —
// nothing may survive in the repo.
const stageClosure = (
	entry: { dir: string; path: string },
	m: Manifest,
	siblings: readonly { dir: string; path: string; name: string }[],
	scratch: string,
	report: PackReport,
): Record<string, string> | null => {
	const closure = [
		{ dir: entry.dir, path: entry.path, name: m.name ?? entry.dir },
		...siblings.filter((s) => s.dir !== entry.dir),
	];
	const tarballs: Record<string, string> = {};
	for (const c of closure) {
		const tgz = packOne(c.path);
		if (!tgz) {
			report.findings.push({
				kind: "pack-failed",
				detail: `${c.dir}: bun pm pack exited nonzero`,
			});
			return null;
		}
		copyFileSync(join(c.path, tgz), join(scratch, `${c.dir}.tgz`));
		rmSync(join(c.path, tgz));
		tarballs[c.name] = `file:../${c.dir}.tgz`;
	}
	return tarballs;
};

// The scratch app manifest: root deps ride the entry tarball; overrides
// pin every private sibling to its tarball (no workspace context there).
const scratchAppManifest = (
	pkgName: string,
	tarballs: Record<string, string>,
): string =>
	`${JSON.stringify(
		{
			name: "check-pack-scratch",
			private: true,
			dependencies: { [pkgName]: tarballs[pkgName] },
			overrides: Object.fromEntries(
				Object.entries(tarballs).filter(([n]) => n !== pkgName),
			),
		},
		null,
		"\t",
	)}\n`;

// Scratch install leg: install the tarball set, return the installed
// package root (findings pushed on failure).
const scratchInstall = (
	pkgName: string,
	report: PackReport,
	scratch: string,
	tarballs: Record<string, string>,
): string | null => {
	mkdirSync(join(scratch, "app"), { recursive: true });
	writeFileSync(
		join(scratch, "app", "package.json"),
		scratchAppManifest(pkgName, tarballs),
	);
	const install = run(["bun", "install"], {
		cwd: join(scratch, "app"),
		timeout: INSTALL_TIMEOUT_MS,
	});
	if (install.exitCode !== 0) {
		report.findings.push({
			kind: "install-failed",
			detail: `tarball install failed in scratch: ${install.output.split("\n").filter(Boolean).slice(0, 4).join(" | ").slice(0, 400)}`,
		});
		return null;
	}
	report.installed = true;
	const appRoot = join(scratch, "app");
	const pkgRoot = join(appRoot, "node_modules", pkgName);
	if (!existsSync(pkgRoot)) {
		report.findings.push({
			kind: "install-failed",
			detail: "installed package dir not found after bun install",
		});
		return null;
	}
	return pkgRoot;
};

// One package through the full chain: pack → scratch install → import,
// exports, and bin proofs over the INSTALLED tree.
export const checkOne = (
	entry: { dir: string; path: string },
	siblings: readonly { dir: string; path: string; name: string }[],
): PackReport => {
	const m = readManifest(entry.path);
	const report: PackReport = {
		pkg: m.name ?? entry.dir,
		packed: false,
		installed: false,
		filesScanned: 0,
		findings: [],
		notes: [],
		bins: [],
	};
	if (!m.exports) report.notes.push("no exports map (manifest repair lane)");
	if (!m.bin) report.notes.push("no bin (no runnables declared)");

	// pack the entry + its sibling closure, staging tarballs scratch-side
	const scratch = mkdtempSync(join(tmpdir(), "check-pack-"));
	try {
		const tarballs = stageClosure(entry, m, siblings, scratch, report);
		if (!tarballs) return report;
		report.packed = true;
		const pkgName = m.name ?? entry.dir;
		const pkgRoot = scratchInstall(pkgName, report, scratch, tarballs);
		if (!pkgRoot) return report;
		return proveInstalled(entry, m, report, scratch, pkgRoot);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
};

// The three proofs, all against the INSTALLED tree.
const proveInstalled = (
	entry: { dir: string; path: string },
	m: Manifest,
	report: PackReport,
	scratch: string,
	pkgRoot: string,
): PackReport => {
	const appRoot = join(scratch, "app");
	// imports proof: full shipped-graph scan against the install
	const files = walkCode(pkgRoot);
	report.filesScanned = files.length;
	report.findings.push(
		...checkInstallGraph(appRoot, pkgRoot, files, (spec, fromDir) =>
			Bun.resolveSync(spec, fromDir),
		),
	);
	if (m.exports) report.findings.push(...checkExportsMap(pkgRoot, m.exports));
	return proveBins(entry, m, report, appRoot, pkgRoot);
};

// One bin through the --help proof; pushes verdict + finding to the report.
const proveOneBin = (
	name: string,
	relPath: string,
	appRoot: string,
	pkgRoot: string,
	report: PackReport,
): void => {
	if (!existsSync(join(pkgRoot, relPath))) {
		report.findings.push({
			kind: "bin-missing",
			detail: `bin "${name}" → "${relPath}" did not ship`,
		});
		return;
	}
	const r = run(["bun", join(pkgRoot, relPath), "--help"], {
		cwd: appRoot,
		timeout: BIN_TIMEOUT_MS,
	});
	const verdict = binPass(r.exitCode, r.output);
	report.bins.push({ name, ...verdict });
	if (!verdict.pass)
		report.findings.push({
			kind: "bin-broken",
			detail: `bin "${name}" failed --help proof (${verdict.note})`,
		});
};

// Bin proof loop over the manifest bin map. Pinned skips are belt bins
// that ignore --help and serve (shrink-only pin at BIN_SKIP).
const proveBins = (
	entry: { dir: string; path: string },
	m: Manifest,
	report: PackReport,
	appRoot: string,
	pkgRoot: string,
): PackReport => {
	const pkgName = m.name ?? entry.dir;
	const binMap = typeof m.bin === "string" ? { [pkgName]: m.bin } : m.bin;
	if (!binMap) return report;
	const skips = BIN_SKIP[entry.dir] ?? [];
	for (const [name, relPath] of Object.entries(binMap)) {
		if (skips.includes(name)) {
			report.bins.push({
				name,
				pass: true,
				note: "skipped (pinned: ignores --help and serves)",
			});
			continue;
		}
		proveOneBin(name, relPath, appRoot, pkgRoot, report);
	}
	return report;
};

const main = (argv: string[]): number => {
	const asJson = argv.includes("--json");
	// --only <dir>[,<dir>...] scopes the run (spec legs, quick re-checks);
	// the default is every package, every run.
	const onlyIdx = argv.indexOf("--only");
	const only =
		onlyIdx >= 0 && argv[onlyIdx + 1]
			? new Set(argv[onlyIdx + 1].split(","))
			: null;
	const entries = fleetPackages().filter((e) => !only || only.has(e.dir));
	const closure = siblingClosure(fleetPackages());
	const reports: PackReport[] = [];
	for (const e of entries) reports.push(checkOne(e, closure));

	// stray sweep AFTER the run: this run's tarballs were removed inline, so
	// anything left is dirt the guard must surface
	const strays = findStrayTarballs(entries, REPO_ROOT);
	let failed = strays.length > 0;
	for (const s of strays) console.error(`  ${s.kind}: ${s.detail}`);

	for (const r of reports) {
		failed = failed || r.findings.length > 0;
		if (asJson) {
			console.log(JSON.stringify(r));
			continue;
		}
		console.log(
			`check-pack ${r.pkg}: ${r.findings.length ? "FAIL" : "ok"} (${r.filesScanned} files scanned, ${r.bins.filter((b) => b.pass).length}/${r.bins.length} bins proved)`,
		);
		for (const n of r.notes) console.log(`  note: ${n}`);
		for (const f of r.findings) console.log(`  ${f.kind}: ${f.detail}`);
	}
	if (failed)
		console.error(
			"check-pack: findings above — the tarball install does not satisfy the package contract",
		);
	return failed ? 1 : 0;
};

if (import.meta.main) process.exit(main(process.argv.slice(2)));
