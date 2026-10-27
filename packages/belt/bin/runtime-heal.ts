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
	// W1475: hubs.ts rides @klh package imports — its suspenders closure
	// (+ zai-catalog's buckle guard chain below) ships flat beside the kit.
	{
		from: "packages/suspenders/deploy/openrouter-free.ts",
		to: "openrouter-free.ts",
	},
	{ from: "packages/suspenders/deploy/zai-catalog.ts", to: "zai-catalog.ts" },
	{
		from: "packages/suspenders/hooks/lib/kernel-conf.ts",
		to: "kernel-conf.ts",
	},
	{
		from: "packages/kernel/src/kernel.loopback.module.ts",
		to: "kernel.loopback.module.ts",
	},
	{
		from: "packages/kernel/src/kernel.host-guard.module.ts",
		to: "kernel.host-guard.module.ts",
	},
	{
		from: "packages/kernel/src/kernel.servicemon.module.ts",
		to: "kernel.servicemon.module.ts",
	},
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
		from: "packages/buckle/src/stream-semantics.ts",
		to: "stream-semantics.ts",
	},
	{ from: "packages/buckle/src/error-detail.ts", to: "error-detail.ts" },
	{
		from: "packages/buckle/src/provider-pressure.ts",
		to: "provider-pressure.ts",
	},
	{ from: "packages/buckle/src/outbound-guard.ts", to: "outbound-guard.ts" },
	{ from: "packages/buckle/src/adapters/errors.ts", to: "errors.ts" },
	{ from: "packages/buckle/src/cooldown.ts", to: "cooldown.ts" },
	// W1475: router-shim/router-core/stream-prelude value-import these two
	{ from: "packages/buckle/src/sse.ts", to: "sse.ts" },
	{ from: "packages/buckle/src/resilience.ts", to: "resilience.ts" },
	{
		from: "packages/telemetry/src/http-trace.ts",
		to: "http-trace.ts",
	},
	{
		from: "packages/speedy/src/provider-config.ts",
		to: "provider-config.ts",
	},
	{
		from: "packages/telemetry/src/prefer-header.ts",
		to: "prefer-header.ts",
	},
	// W1471: http-trace.ts + buckle ledger.ts value-import it (1af2fb82) —
	// unshipped, both dangle in the flat home and the probe fails the install.
	{
		from: "packages/telemetry/src/transport-evidence.ts",
		to: "transport-evidence.ts",
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
	[
		/^(\.\.\/)+buckle\/src\/((?:stream-semantics|error-detail|provider-pressure|outbound-guard|sse|resilience)\.ts)$/,
		"./",
	],
	// W1475: outbound-guard's adapters/errors.ts and errors.ts' parent specs
	// flatten beside it (the overlay's flat layout).
	[/^(\.\/adapters\/)(errors\.ts)$/, "./"],
	[/^(\.\.\/)((?:error-detail|cooldown)\.ts)$/, "./"],
	[/^(\.\.\/)+belt\/bin\/(.+)$/, "./"],
	[/^(\.\.\/)+local-llm\/(.+)$/, "./"],
	[/^(\.\.\/)+telemetry\/src\/(.+)$/, "./"],
	// W1471: the flat home has no node_modules — @klh/kernel package imports
	// (model-store's host-guard + servicemon faces) heal to the flat copies.
	[/^(@klh\/kernel\/src\/)(.+)$/, "./"],
	// W1475: hubs.ts imports its hub-profile cluster by package name.
	[/^@klh\/suspenders\/(deploy|hooks\/lib)\/(.+)$/, "./"],
	[/^(\.\.\/)+speedy\/src\/(.+)$/, "./"],
];

const mapSpec = (spec: string): string | undefined => {
	for (const [re, to] of REWRITE) {
		const m = spec.match(re);
		if (m?.[2] !== undefined) return `${to}${m[2]}`;
	}
	return undefined;
};

const scanImports = (src: string): string[] => {
	// W1294.2.1: `import type` is erased at transpile — it can never break a
	// runtime closure (stack-config.ts's GatewayPolicy rides a checkout
	// path), so the rewriter and the probe both skip it.
	const typeOnly = new Set<string>();
	for (const m of src.matchAll(
		/import\s+type\s+[\s\S]*?from\s+["']([^"']+)["']/g,
	))
		typeOnly.add(m[1]);
	return [...src.matchAll(/from\s+["']([^"']+)["']/g)]
		.map((m) => m[1])
		.filter(
			(s) =>
				s.endsWith(".ts") &&
				(s.startsWith(".") || s.startsWith("@klh/")) &&
				!typeOnly.has(s),
		);
};

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
 *  that resolves OUTSIDE the prefix (checkout leftover), an unhealed @klh/
 *  package import (the flat home has no node_modules) or a missing module
 *  is a failure. Other bare/external specs ignored. */
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
			if (spec.startsWith("@klh/")) {
				errs.add(`unhealed package import in ${rel}: ${spec}`);
				continue;
			}
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
