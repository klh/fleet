// runtime-heal.ts — W790: the belt installer flat-copies bin/* into the
// runtime home; files whose imports point at the checkout layout
// (../../<pkg>/...) break there — the 2026-10-17 outage had the swarm
// supervisor crash-looping on hubs.ts and :4000 dark while two Writes
// raced a stale gate view. The healer (1) copies the known cross-package
// dep closure into the runtime home, (2) rewrites checkout-relative
// imports to runtime-local equivalents when the target exists, and (3)
// probes the supervised closure by TRANSITIVE STATIC RESOLUTION (never
// executes a module) — a broken runtime import fails the install loudly
// instead of crash-looping at boot.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** cross-package deps the runtime home needs (flat beside the kit; gov/
 *  files keep their own relative imports — ../ledger.ts resolves to the
 *  prefix root where ledger.ts is shipped). */
const DEPS: Array<{ from: string; to: string }> = [
	{ from: "packages/suspenders/deploy/hub-remote.ts", to: "hub-remote.ts" },
	{
		from: "packages/suspenders/hooks/lib/stack-config.ts",
		to: "stack-config.ts",
	},
	{
		from: "packages/suspenders/hooks/lib/host-guard.ts",
		to: "host-guard.ts",
	},
	{ from: "packages/suspenders/hooks/lib/servicemon.ts", to: "servicemon.ts" },
	{ from: "packages/buckle/src/gov/keys.ts", to: "gov/keys.ts" },
	{ from: "packages/buckle/src/gov/audit-chain.ts", to: "gov/audit-chain.ts" },
	{ from: "packages/buckle/src/gov/scopes.ts", to: "gov/scopes.ts" },
	{
		from: "packages/buckle/src/gov/store-auth.ts",
		to: "gov/store-auth.ts",
	},
	{ from: "packages/buckle/src/ledger.ts", to: "ledger.ts" },
	{ from: "packages/buckle/src/hop.ts", to: "hop.ts" },
	{ from: "packages/buckle/src/usage.ts", to: "usage.ts" },
	{
		from: "packages/telemetry/src/http-trace.ts",
		to: "http-trace.ts",
	},
	{
		from: "packages/telemetry/src/prefer-header.ts",
		to: "prefer-header.ts",
	},
	{
		from: "packages/local-llm/models.catalog.ts",
		to: "models.catalog.ts",
	},
];

/** checkout-relative spec prefixes → runtime-local prefixes. */
const REWRITE: Array<[RegExp, string]> = [
	[/^(\.\.\/)+suspenders\/deploy\/(.+)$/, "./"],
	[/^(\.\.\/)+suspenders\/hooks\/lib\/(.+)$/, "./"],
	[/^(\.\.\/)+hooks\/lib\/(.+)$/, "./"],
	[/^(\.\.\/)+buckle\/src\/gov\/(.+)$/, "./gov/"],
	[/^(\.\.\/)+belt\/bin\/(.+)$/, "./"],
	[/^(\.\.\/)+local-llm\/(.+)$/, "./"],
	[/^(\.\.\/)+telemetry\/src\/(.+)$/, "./"],
];

const mapSpec = (spec: string): string | undefined => {
	for (const [re, to] of REWRITE) {
		const m = spec.match(re);
		if (m?.[2] !== undefined) return `${to}${m[2]}`;
	}
	return undefined;
};

const scanImports = (src: string): string[] =>
	[...src.matchAll(/from\s+["']([^"']+)["']/g)]
		.map((m) => m[1])
		.filter((s) => s.endsWith(".ts") && s.startsWith("."));

/** Copy cross-package deps from the repo. Runtime imports must match the
 * installed release, including when a previous install left stale copies. */
export const copyDeps = (repoRoot: string, prefix: string): string[] => {
	const done: string[] = [];
	for (const d of DEPS) {
		const from = join(repoRoot, d.from);
		const to = join(prefix, d.to);
		if (!existsSync(from)) continue;
		if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
		mkdirSync(dirname(to), { recursive: true });
		writeFileSync(to, readFileSync(from));
		done.push(d.to);
	}
	return done;
};

/** Rewrite checkout-relative imports to runtime-local equivalents when the
 *  mapped target exists in the prefix. Top-level kit files only. */
export const healImports = (prefix: string): string[] => {
	const done: string[] = [];
	for (const f of readdirSync(prefix)) {
		if (!f.endsWith(".ts")) continue;
		const p = join(prefix, f);
		const src = readFileSync(p, "utf8");
		let out = src;
		for (const spec of scanImports(src)) {
			const mapped = mapSpec(spec);
			if (
				!mapped ||
				join(prefix, mapped.replace(/^\.\//, "")) === p ||
				!existsSync(join(prefix, mapped.replace(/^\.\//, "")))
			)
				continue;
			for (const q of ['"', "'"]) {
				out = out.split(`${q}${spec}${q}`).join(`${q}${mapped}${q}`);
			}
			done.push(`${f}: ${spec} -> ${mapped}`);
		}
		if (
			f === "remotes.ts" &&
			existsSync(join(prefix, "bonjour-service.bundle.js"))
		) {
			const next = out.replace(
				'from "bonjour-service"',
				'from "./bonjour-service.bundle.js"',
			);
			if (next !== out)
				done.push("remotes.ts: bonjour-service -> runtime bundle");
			out = next;
		}
		if (out !== src) writeFileSync(p, out);
	}
	return done;
};

/** Transitive static resolution from the probe entries; a relative import
 *  that resolves OUTSIDE the prefix (checkout leftover) or a missing module
 *  is a failure. Bare/external specs ignored. */
export const probeClosure = (
	prefix: string,
	entries: string[] = [
		"swarm.ts",
		"supervisor.ts",
		"router-shim.ts",
		"hubs.ts",
		"memory-policy.ts",
		"model-store.ts",
		"model-store-lib.ts",
	],
): string[] => {
	const seen = new Set<string>();
	const errs = new Set<string>();
	const walk = (rel: string, depth = 0): void => {
		if (depth > 12 || seen.has(rel)) return;
		seen.add(rel);
		let src: string;
		try {
			src = readFileSync(join(prefix, rel), "utf8");
		} catch {
			errs.add(`missing module: ${rel}`);
			return;
		}
		for (const spec of scanImports(src)) {
			const resolved = join(dirname(rel), spec);
			if (resolved.startsWith("..")) {
				errs.add(`unhealed checkout import in ${rel}: ${spec}`);
				continue;
			}
			walk(resolved, depth + 1);
		}
	};
	for (const e of entries) walk(e);
	return [...errs];
};

const main = async (): Promise<number> => {
	const prefix =
		process.argv[2] ?? join(process.env.HOME ?? "", ".claude/local-llm");
	const repoRoot = process.argv[3] ?? process.cwd();
	// The flat runtime home has no package-level node_modules. Bundle the
	// installed, version-pinned mDNS package before rewriting remotes.ts.
	const mdnsEntry = join(
		repoRoot,
		"packages/belt/node_modules/bonjour-service/dist/index.js",
	);
	if (!existsSync(mdnsEntry)) {
		console.error(
			"runtime-heal: bonjour-service missing; run bun install in Fleet",
		);
		return 1;
	}
	const bundle = await Bun.build({
		entrypoints: [mdnsEntry],
		outdir: prefix,
		naming: "bonjour-service.bundle.js",
		target: "bun",
	});
	if (!bundle.success) {
		console.error("runtime-heal: bonjour-service bundle failed");
		return 1;
	}
	// The kit's memory-policy.ts is a checkout wrapper. A flat copy would
	// otherwise rewrite its re-export to itself and crash the dashboard.
	const memoryPolicy = join(repoRoot, "packages/local-llm/memory-policy.ts");
	if (!existsSync(memoryPolicy)) {
		console.error("runtime-heal: canonical memory-policy.ts missing");
		return 1;
	}
	writeFileSync(join(prefix, "memory-policy.ts"), readFileSync(memoryPolicy));
	const copied = copyDeps(repoRoot, prefix);
	if (copied.length > 0)
		console.log(`runtime-heal: deps copied ${copied.join(", ")}`);
	const healed = healImports(prefix);
	if (healed.length > 0)
		console.log(`runtime-heal: rewrote ${healed.length} cross-package imports`);
	const errs = probeClosure(prefix);
	if (errs.length > 0) {
		console.error(`runtime-heal: BROKEN runtime imports (${errs.length}):`);
		for (const e of errs) console.error(`  ${e}`);
		return 1;
	}
	console.log("runtime-heal: supervised closure resolves clean");
	return 0;
};

if (import.meta.main) process.exit(await main());
