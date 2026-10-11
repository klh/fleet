// W661: the belt/bin overlay must ship router-shim's FULL import closure and
// prove it. 2026-10-11 incident: a hardcoded overlay list shipped
// router-shim.ts without ./audio.ts + ./escalate.ts — :4000 died on every
// spawn and launchd revived it ~95 times over 4h. Three verbs:
//   closure  print the transitively-closed set of belt/bin files
//   overlay  copy missing closure files into the runtime home (never clobber)
//   smoke    spawn the FLATTENED runtime on a scratch port and require
//            /health 200 — a missing module fails the install loudly here
//            instead of looping the launchd revive on :4000
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

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
	if (verb === "closure") {
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
			`usage: bun belt-bin-overlay.ts <closure|overlay|smoke> [--runtime <dir>] [--entry <file>]`,
		);
		process.exit(2);
	}
}
