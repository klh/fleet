// W661: the belt/bin overlay must ship router-shim's FULL import closure and
// prove it. 2026-10-11 incident: a hardcoded overlay list shipped
// router-shim.ts without ./audio.ts + ./escalate.ts — :4000 died on every
// spawn and launchd revived it ~95 times over 4h. W1250: the never-clobber
// overlay verb is retired — a runtime copy kept over a diverged artifact is
// a second mutable source of truth; the ONLY reconciliation is the refresh
// verb (verified reconciliation against the pinned artifact face). Verbs:
//   closure  print the transitively-closed set of belt/bin files
//   refresh  reconcile the flat home to the pinned face (missing AND
//            diverged), then prove resolution
//   smoke    spawn the FLATTENED runtime on a scratch port and require
//            /health 200 — a missing module fails the install loudly here
//            instead of looping the launchd revive on :4000
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

/** `./`-relative specifiers from static/dynamic import + re-export lines. */
export function relativeImports(source: string): string[] {
	const specs: string[] = [];
	const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.\/[^"']+)["']/g;
	for (const match of source.matchAll(pattern)) specs.push(match[1]);
	return [...new Set(specs)];
}

/**
 * BFS over the entry's imports and their cross-package dependencies. A module
 * outside belt/bin can import back into belt/bin; that member must also ride
 * the flat runtime closure. Only existing belt/bin files are returned.
 */
export async function beltBinClosure(
	entry: string,
	root = dirname(entry),
): Promise<string[]> {
	const repoRoot = resolve(root, "..", "..");
	const seen = new Set<string>();
	const members = new Set<string>();
	const queue = [resolve(entry)];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		if (seen.has(current)) continue;
		seen.add(current);
		let source: string;
		try {
			source = await Bun.file(current).text();
		} catch {
			continue; // vanished between readdir and read: skip, smoke still guards
		}
		const fromDir = dirname(current);
		for (const resolved of [
			...relativeSpecs(source, fromDir),
			...klhSpecs(source, fromDir),
		]) {
			if (!isWithin(resolved, repoRoot) || seen.has(resolved)) continue;
			if (!(await Bun.file(resolved).exists())) continue;
			if (isWithin(resolved, root) && resolved !== resolve(entry))
				members.add(resolved);
			queue.push(resolved);
		}
	}
	return [...members].sort().map((file) => relative(root, file));
}

/** True when child sits at or below dir (no `..` in the relative path). */
function isWithin(child: string, dir: string): boolean {
	return !relative(dir, child).startsWith("..");
}

/** Static, dynamic, and side-effect relative imports resolved against fromDir. */
export function relativeSpecs(text: string, fromDir: string): string[] {
	const out: string[] = [];
	const pattern =
		/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.\.?\/[^"']+)["']/g;
	for (const m of text.matchAll(pattern)) {
		out.push(resolve(fromDir, m[1].split("?")[0]));
	}
	return out;
}

/** W1475: an `@klh/<pkg>/<path>` package spec → its workspace file
 *  (`<packages>/<pkg>/<path>`, from fromDir's nearest `packages` ancestor).
 *  The flat home has no @klh node_modules, so these flatten like `../`. */
function klhSpecPath(spec: string, fromDir: string): string | undefined {
	const m = spec.split("?")[0].match(/^@klh\/([^/]+\/.+)$/);
	if (!m) return undefined;
	let dir = fromDir;
	while (basename(dir) !== "packages") {
		if (dirname(dir) === dir) return undefined;
		dir = dirname(dir);
	}
	return resolve(dir, m[1]);
}

/** Static, dynamic, and side-effect `@klh/<pkg>/<path>` imports, resolved. */
export function klhSpecs(text: string, fromDir: string): string[] {
	const pattern =
		/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](@klh\/[^"']+)["']/g;
	return [...text.matchAll(pattern)].flatMap(
		(m) => klhSpecPath(m[1], fromDir) ?? [],
	);
}

// splice chunk-A before `export interface OverlayReport {` — belt-bin-overlay.ts
function noteExternal(
	resolved: string,
	repoRoot: string,
	externals: Map<string, string>,
): void {
	const base = basename(resolved);
	if (externals.has(resolved)) return;
	for (const [prevPath, prevBase] of externals) {
		if (prevBase === base)
			throw new Error(
				`flat home basename collision: ${relative(repoRoot, prevPath)} and ${relative(repoRoot, resolved)} both map to ${base}`,
			);
	}
	externals.set(resolved, base);
}

// splice chunk-B1 before `export interface OverlayReport {` — belt-bin-overlay.ts
export async function flatExternals(
	entry: string,
	root = dirname(entry),
): Promise<Map<string, string>> {
	const repoRoot = resolve(root, "..", "..");
	const externals = new Map<string, string>(); // resolved abs → flat basename
	const memberBase = new Map<string, string>([
		[basename(entry), resolve(entry)],
	]);
	const seen = new Set<string>();
	const queue = [resolve(entry)];
	while (queue.length > 0) {
		const current = queue.pop() as string;
		if (seen.has(current)) continue;
		seen.add(current);
		const text = await Bun.file(current)
			.text()
			.catch(() => "");
		if (text === "") continue;
		const fromDir = dirname(current);
		for (const spec of [
			...relativeSpecs(text, fromDir),
			...klhSpecs(text, fromDir),
		]) {
			if (!(await Bun.file(spec).exists())) continue;
			if (isWithin(spec, root)) memberBase.set(basename(spec), spec);
			else if (isWithin(spec, repoRoot))
				noteExternal(spec, repoRoot, externals);
			if (!seen.has(spec)) queue.push(spec);
		}
	}
	// member↔external sharing a basename is legal ONLY for the pure-shim
	// pair (the shim's real module collapses into one home file); anything
	// else collides and fails closed
	for (const [base, member] of memberBase) {
		const extPath = [...externals.keys()].find((p) => basename(p) === base);
		if (extPath === undefined) continue;
		const memberText = await Bun.file(member)
			.text()
			.catch(() => "");
		if (isPureReexportShim(memberText)) continue;
		throw new Error(
			`flat home basename collision: a closure member shares the basename ${base} with a cross-package external`,
		);
	}
	return externals;
}

// splice chunk-B2 before `export interface OverlayReport {` — belt-bin-overlay.ts
/** Rewrite mapped cross-package `../` (and W1475 `@klh/<pkg>/<path>`)
 *  specifiers to flat `./<basename>`. */
export function rewriteExternalSpecs(
	text: string,
	fromDir: string,
	externals: Map<string, string>,
	memberRoot?: string,
): string {
	const specs = /(["'])((?:\.\.?\/|@klh\/)[^"']+)\1/g;
	return text.replace(specs, (full, q, spec) => {
		const resolved = spec.startsWith("@klh/")
			? klhSpecPath(spec, fromDir)
			: resolve(fromDir, spec.split("?")[0]);
		if (resolved === undefined) return full;
		const base =
			externals.get(resolved) ??
			(memberRoot && isWithin(resolved, memberRoot)
				? basename(resolved)
				: undefined);
		return base === undefined ? full : `${q}./${base}${q}`;
	});
}

/**
 * The pinned artifact face of one flat-home file: the real module over a
 * re-export shim, with cross-package specifiers rewritten to flat sibling
 * basenames — byte-for-byte what refreshFlatHome materializes. The one
 * comparison face for drift probes (W1250: drift is measured against the
 * pinned artifact, never against raw checkout text).
 */
export async function pinnedFaceText(
	sourceFile: string,
	externals: Map<string, string>,
	memberRoot: string,
): Promise<string> {
	return rewriteExternalSpecs(
		await Bun.file(sourceFile).text(),
		dirname(sourceFile),
		externals,
		memberRoot,
	);
}

/** Strip comments and blank lines — the drift-tripwire normalization. */
export function normalizeSource(src: string): string {
	return src
		.split("\n")
		.map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1").trimEnd())
		.filter((line) => line.trim().length > 0)
		.join("\n");
}

/**
 * A belt/bin closure file that is a PURE RE-EXPORT shim for the flat runtime
 * home is swapped for its REAL module (e.g. memory-policy.ts ->
 * ../../local-llm/memory-policy.ts) — a flat copy of the shim strands the
 * supervisor import graph (lesson.flat-home-overlay-hazard). Real code that
 * merely imports cross-package (hubs.ts -> ../../suspenders/... since
 * W351/W371) is NOT a shim: the old any-`..`-import test copied the
 * dependency OVER the runtime file and stranded the home.
 */
export function isPureReexportShim(source: string): boolean {
	const body = normalizeSource(source);
	if (body === "") return false;
	if (
		/(^|\n)\s*(?:export\s+)?(?:default\s+|async\s+)*(?:function|const|let|var|class|enum)\b/.test(
			body,
		)
	)
		return false;
	// `export type X =` / `export interface X` declare; `export type { X }`
	// re-exports and stays shim-legal
	if (/(^|\n)\s*export\s+(?:type|interface)\s+[A-Za-z_$]/.test(body))
		return false;
	// a shim re-exports from OUTSIDE only — any `./` specifier means the file
	// is real code with kit siblings (entries with side effects included)
	const specs = [...source.matchAll(/(["'])((?:\.\.?\/)[^"']+)\1/g)].map(
		(m) => m[2],
	);
	if (specs.length === 0 || specs.some((s) => !s.startsWith("..")))
		return false;
	return true;
}

export async function shimRealSource(
	root: string,
	rel: string,
): Promise<string | null> {
	const file = join(root, rel);
	const source = await Bun.file(file).text();
	if (!isPureReexportShim(source)) return null;
	for (const match of source.matchAll(/["'](\.\.[^"']+)["']/g)) {
		const resolved = resolve(dirname(file), match[1]);
		if (relative(root, resolved).startsWith("..")) return resolved;
	}
	return null;
}

/** The flat-home source of truth for a closure file: real module over shim. */
export async function flatHomeSource(
	root: string,
	rel: string,
): Promise<string> {
	return (await shimRealSource(root, rel)) ?? join(root, rel);
}

/** W1468: a kit twin and the belt/bin artifact the runtime home heals from. */
export interface RuntimeTwin {
	kit: string;
	artifact: string;
}

/** The dual-home twin set (packages/local-llm AGENTS.md shim list). */
export const RUNTIME_TWINS: readonly RuntimeTwin[] = [
	{
		kit: "packages/local-llm/registry.ts",
		artifact: "packages/belt/bin/registry.ts",
	},
	{
		kit: "packages/local-llm/spawner.ts",
		artifact: "packages/belt/bin/spawner.ts",
	},
	{
		kit: "packages/local-llm/litellm-target.ts",
		artifact: "packages/belt/bin/litellm-target.ts",
	},
];

/** The one allowlisted twin delta: a FULL re-export of the pinned artifact. */
export function twinShimSource(twin: RuntimeTwin): string {
	return `export * from "${relative(dirname(twin.kit), twin.artifact)}";`;
}

/**
 * Drift verdicts for every twin under root (the repo or a staged payload);
 * empty = each kit twin carries the pinned face. A narrowed re-export hides
 * artifact exports; a byte copy is a second module instance (spawner's
 * single-flight map splits) whose `./` imports resolve against kit siblings.
 * A kit absent from root has no second variant to drift.
 */
export function twinDrift(
	root: string,
	twins: readonly RuntimeTwin[] = RUNTIME_TWINS,
): string[] {
	const drift: string[] = [];
	for (const twin of twins) {
		const kit = join(root, twin.kit);
		if (!existsSync(kit)) continue;
		if (!existsSync(join(root, twin.artifact)))
			drift.push(`${twin.kit}: pinned artifact ${twin.artifact} is missing`);
		else if (
			normalizeSource(readFileSync(kit, "utf8")) !== twinShimSource(twin)
		)
			drift.push(`${twin.kit}: not the full re-export of ${twin.artifact}`);
	}
	return drift;
}

/** The W741 refresh report: which home files healed, which already agreed. */
export interface RefreshReport {
	healed: string[];
	kept: string[];
}

/**
 * The drift-tripwire remediation verb (W741): heal the flat runtime home's
 * belt closure — missing AND diverged files, real modules for re-export
 * shims (pure re-exports only), and cross-package externals flattened to
 * sibling basenames with their specifiers rewritten (`../suspenders/...` →
 * `./hub-remote.ts`), resolution proved before the lock releases.
 */
export async function refreshFlatHome(
	runtime: string,
	entry: string,
	root = dirname(entry),
	log: (line: string) => void = console.log,
): Promise<RefreshReport> {
	const lock = join(runtime, ".belt-overlay.lock");
	await mkdir(lock); // fail closed while another refresh owns the runtime
	const report: RefreshReport = { healed: [], kept: [] };
	try {
		const closure = await beltBinClosure(entry, root);
		const externals = await flatExternals(entry, root);
		for (const rel of [relative(root, entry), ...closure]) {
			const source = await flatHomeSource(root, rel);
			const wantText = await pinnedFaceText(source, externals, root);
			const want = normalizeSource(wantText);
			const target = join(runtime, rel);
			const have = (await Bun.file(target).exists())
				? normalizeSource(await Bun.file(target).text())
				: null;
			if (have === want) {
				report.kept.push(rel);
				continue;
			}
			await mkdir(dirname(target), { recursive: true });
			await Bun.write(target, wantText);
			report.healed.push(rel);
			log(`${have === null ? "+" : "~"} ${target} (from ${source})`);
		}
		for (const [file, base] of externals) {
			const target = join(runtime, base);
			const wantText = await pinnedFaceText(file, externals, root);
			const want = normalizeSource(wantText);
			const have = (await Bun.file(target).exists())
				? normalizeSource(await Bun.file(target).text())
				: null;
			if (have === want) {
				report.kept.push(`${base} (external)`);
				continue;
			}
			await mkdir(dirname(target), { recursive: true });
			await Bun.write(target, wantText);
			report.healed.push(`${base} (external)`);
			log(`${have === null ? "+" : "~"} ${target} (from ${file})`);
		}
		await verifyFlatHome(runtime, relative(root, entry));
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
	return report;
}

/**
 * Prove the FLAT home's import graph resolves WITHOUT executing any module
 * code — bun build resolves the closure at build time, while import-exec
 * would run router top-levels (and could bind ports). `--no-bundle` cannot
 * stand in: it transpiles without resolving, so a broken graph still passes.
 */
export async function verifyFlatHome(
	runtime: string,
	entry = "router-shim.ts",
): Promise<void> {
	const child = Bun.spawn(
		[process.execPath, "build", "--target=bun", join(runtime, entry)],
		{
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const stderrText = new Response(child.stderr).text();
	const timer = setTimeout(() => child.kill(), 30_000);
	try {
		const code = await child.exited;
		if (code !== 0) {
			const tail = (await stderrText).trim().split("\n").slice(-8).join("\n");
			throw new Error(`flat-home resolution failed (exit ${code}): ${tail}`);
		}
	} finally {
		clearTimeout(timer);
	}
}

export interface SmokeOptions {
	entry?: string;
	timeoutMs?: number;
}

export interface SmokeResult {
	port: number;
}

/**
 * Spawn the flattened runtime's router on a scratch BELT_ROUTER_PORT and
 * require /health 200 within the deadline. :4000 belongs to the live
 * supervisor — the smoke never binds it.
 */
export async function smokeRouter(
	runtime: string,
	options: SmokeOptions = {},
): Promise<SmokeResult> {
	const entry = options.entry ?? join(runtime, "router-shim.ts");
	const timeoutMs = options.timeoutMs ?? 20_000;
	let lastError = "smoke did not run";
	// Two scratch-port attempts: the free-port probe can lose a race between
	// reserve and spawn — retry on a fresh port before declaring failure.
	for (let attempt = 0; attempt < 2; attempt++) {
		const port = await reservePort();
		const child = Bun.spawn([process.execPath, entry], {
			env: { ...process.env, BELT_ROUTER_PORT: String(port) },
			stdout: "ignore",
			stderr: "pipe",
		});
		// Drain stderr from the start — reading it only after a deadline loses
		// the buffered diagnostics of an early-exited child.
		const stderrText = new Response(child.stderr).text();
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/health`, {
					signal: AbortSignal.timeout(1_000),
				});
				if (res.ok) {
					child.kill();
					await child.exited;
					return { port };
				}
			} catch {
				// not serving yet (or died) — re-checked below
			}
			if (child.exitCode !== null) break; // died mid-deadline
			await Bun.sleep(150);
		}
		child.kill();
		const code = await child.exited;
		const tail = (await stderrText).trim().split("\n").slice(-6).join("\n");
		lastError = `router smoke failed on port ${port} (exit ${code}): ${tail}`;
		if (tail.includes("EADDRINUSE")) continue;
		throw new Error(lastError);
	}
	throw new Error(lastError);
}

async function reservePort(): Promise<number> {
	const probe = Bun.serve({
		port: 0,
		fetch: () => new Response(null),
	});
	const port = probe.port;
	probe.stop(true);
	return port;
}

if (import.meta.main) {
	const verb = process.argv[2] ?? "";
	const flag = (name: string): string | undefined => {
		const i = process.argv.indexOf(name);
		return i >= 0 ? process.argv[i + 1] : undefined;
	};
	const runtime = flag("--runtime") ?? `${process.env.HOME}/.claude/local-llm`;
	const entry =
		flag("--entry") ?? join(import.meta.dir, "../../belt/bin/router-shim.ts");
	if (verb === "refresh") {
		try {
			const report = await refreshFlatHome(runtime, entry);
			console.log(
				`belt closure refresh: ${report.healed.length} healed, ${report.kept.length} kept, resolution verified`,
			);
		} catch (error) {
			console.error(
				`✗ ${error instanceof Error ? error.message : String(error)}`,
			);
			console.error("  install aborted — the flat runtime home is unusable;");
			console.error(
				"  fix the belt/bin closure or the real-module shims above.",
			);
			process.exit(1);
		}
	} else if (verb === "closure") {
		for (const rel of await beltBinClosure(entry)) console.log(rel);
	} else if (verb === "smoke") {
		try {
			const { port } = await smokeRouter(runtime);
			console.log(`router smoke: /health 200 on scratch :${port}`);
		} catch (error) {
			console.error(
				`✗ ${error instanceof Error ? error.message : String(error)}`,
			);
			console.error("  install aborted — fix the runtime overlay above;");
			console.error("  re-run install after correcting the belt/bin closure.");
			process.exit(1);
		}
	} else {
		console.error(
			`usage: bun belt-bin-overlay.ts <closure|refresh|smoke> [--runtime <dir>] [--entry <file>]`,
		);
		process.exit(2);
	}
}
