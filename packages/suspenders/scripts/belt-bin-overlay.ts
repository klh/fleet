// W661: the belt/bin overlay must ship router-shim's FULL import closure and
// prove it. 2026-10-11 incident: a hardcoded overlay list shipped
// router-shim.ts without ./audio.ts + ./escalate.ts — :4000 died on every
// spawn and launchd revived it ~95 times over 4h. Three verbs:
//   closure  print the transitively-closed set of belt/bin files
//   overlay  copy missing closure files into the runtime home (never clobber)
//   smoke    spawn the FLATTENED runtime on a scratch port and require
//            /health 200 — a missing module fails the install loudly here
//            instead of looping the launchd revive on :4000
import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

/** `./`-relative specifiers from static/dynamic import + re-export lines. */
export function relativeImports(source: string): string[] {
	const specs: string[] = [];
	const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.\/[^"']+)["']/g;
	for (const match of source.matchAll(pattern)) specs.push(match[1]);
	return [...new Set(specs)];
}

/**
 * BFS over the entry's `./`-relative imports, staying inside root. Files are
 * included only when they exist — a commented-out or type-dangling specifier
 * fails open (copy an extra file) instead of stranding the closure.
 */
export async function beltBinClosure(
	entry: string,
	root = dirname(entry),
): Promise<string[]> {
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		let source: string;
		try {
			source = await Bun.file(current).text();
		} catch {
			continue; // vanished between readdir and read: skip, smoke still guards
		}
		for (const spec of relativeImports(source)) {
			const resolved = join(dirname(current), spec.split("?")[0]);
			const rel = relative(root, resolved);
			if (rel.startsWith("..") || seen.has(resolved)) continue;
			if (!(await Bun.file(resolved).exists())) continue;
			seen.add(resolved);
			queue.push(resolved);
		}
	}
	seen.delete(entry);
	return [...seen].sort().map((file) => relative(root, file));
}

/** True when child sits at or below dir (no `..` in the relative path). */
function isWithin(child: string, dir: string): boolean {
	return !relative(dir, child).startsWith("..");
}

/** All relative `./`+`../` specifiers of a text, resolved against fromDir. */
export function relativeSpecs(text: string, fromDir: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(["'])((?:\.\.?\/)[^"']+)\1/g)) {
		out.push(resolve(fromDir, m[2].split("?")[0]));
	}
	return out;
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

function assertNoFlatCollision(
	memberBase: Set<string>,
	externals: Map<string, string>,
): void {
	for (const base of memberBase) {
		if ([...externals.values()].includes(base))
			throw new Error(
				`flat home basename collision: a closure member shares the basename ${base} with a cross-package external`,
			);
	}
}
// splice chunk-B1 before `export interface OverlayReport {` — belt-bin-overlay.ts
export async function flatExternals(
	entry: string,
	root = dirname(entry),
): Promise<Map<string, string>> {
	const repoRoot = resolve(root, "..", "..");
	const externals = new Map<string, string>(); // resolved abs → flat basename
	const memberBase = new Set<string>([basename(entry)]);
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
		for (const spec of relativeSpecs(text, dirname(current))) {
			if (!(await Bun.file(spec).exists())) continue;
			if (isWithin(spec, root)) memberBase.add(basename(spec));
			else if (isWithin(spec, repoRoot))
				noteExternal(spec, repoRoot, externals);
			if (!seen.has(spec)) queue.push(spec);
		}
	}
	assertNoFlatCollision(memberBase, externals);
	return externals;
}

// splice chunk-B2 before `export interface OverlayReport {` — belt-bin-overlay.ts
/** Rewrite mapped cross-package `../` specifiers to flat `./<basename>`. */
export function rewriteExternalSpecs(
	text: string,
	fromDir: string,
	externals: Map<string, string>,
): string {
	return text.replace(/(["'])((?:\.\.?\/)[^"']+)\1/g, (full, q, spec) => {
		const resolved = resolve(fromDir, spec.split("?")[0]);
		const base = externals.get(resolved);
		return base === undefined ? full : `${q}./${base}${q}`;
	});
}

export interface OverlayReport {
	copied: string[];
	kept: string[];
}

/** Copy missing closure files into the runtime home; never clobber. */
export async function overlayBeltBin(
	runtime: string,
	entry: string,
	root = dirname(entry),
	log: (line: string) => void = console.log,
): Promise<OverlayReport> {
	const report: OverlayReport = { copied: [], kept: [] };
	for (const rel of await beltBinClosure(entry, root)) {
		const target = join(runtime, rel);
		if (await Bun.file(target).exists()) {
			report.kept.push(rel);
			log(`= ${target} kept (runtime copy is source of truth)`);
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(root, rel), target);
		report.copied.push(rel);
		log(`+ ${target} (from belt/bin)`);
	}
	return report;
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
			const wantText = rewriteExternalSpecs(
				await Bun.file(source).text(),
				dirname(source),
				externals,
			);
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
			const wantText = rewriteExternalSpecs(
				await Bun.file(file).text(),
				dirname(file),
				externals,
			);
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
	} else if (verb === "overlay") {
		await overlayBeltBin(runtime, entry);
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
			`usage: bun belt-bin-overlay.ts <closure|overlay|refresh|smoke> [--runtime <dir>] [--entry <file>]`,
		);
		process.exit(2);
	}
}
