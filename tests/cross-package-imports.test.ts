// W649 cross-package import guard: every `from "@klh/<pkg>"` (static or
// dynamic) under packages/X must be a DECLARED dependency of X
// (package.json "dependencies"). The installed artifact links only the
// declared graph — an undeclared cross-package import installs clean and
// dies at first run on the hub, so this guard fails the build instead.
// Also pins the known edge set so the scan cannot silently rot to zero
// coverage (a broken regex must fail here, not in production).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PACKAGES = join(ROOT, "packages");

/** Declared @klh/* dependencies of a package, runtime OR dev (empty when
 *  no manifest). Dev-only is legal for checkout-only tooling (blam/tools
 *  benches) — the installed artifact never ships those paths; the shipped
 *  graph itself is proven by the CI artifact-roundtrip job. */
function declared(pkg: string): Set<string> {
	const manifest = join(PACKAGES, pkg, "package.json");
	if (!existsSync(manifest)) return new Set();
	const pkgJson = JSON.parse(readFileSync(manifest, "utf8"));
	return new Set(
		Object.keys({
			...pkgJson.dependencies,
			...pkgJson.devDependencies,
		}).filter((d) => d.startsWith("@klh/")),
	);
}

/** All package-local .ts files, node_modules workspace links excluded. */
function sources(pkg: string): string[] {
	return [
		...new Bun.Glob("**/*.ts").scanSync({
			cwd: join(PACKAGES, pkg),
			onlyFiles: true,
		}),
	].filter((f) => !f.includes("node_modules"));
}

/** @klh/* specifiers imported by a package's own sources. */
function imported(pkg: string): Set<string> {
	const found = new Set<string>();
	for (const file of sources(pkg)) {
		const src = readFileSync(join(PACKAGES, pkg, file), "utf8");
		for (const m of src.matchAll(
			/(?:from|import)\s*\(?\s*["'](@klh\/[a-z-]+)/g,
		)) {
			found.add(m[1]);
		}
	}
	return found;
}

test("every cross-package @klh import is declared by the importing package", () => {
	for (const pkg of readdirSync(PACKAGES).sort()) {
		if (!existsSync(join(PACKAGES, pkg, "package.json"))) continue;
		const deps = declared(pkg);
		for (const name of imported(pkg)) {
			expect(
				deps.has(name),
				`packages/${pkg} imports ${name} without declaring it in package.json`,
			).toBe(true);
		}
	}
});

test("every declared @klh dependency exists as a package", () => {
	for (const pkg of readdirSync(PACKAGES).sort()) {
		for (const dep of declared(pkg)) {
			const name = dep.slice("@klh/".length);
			expect(
				existsSync(join(PACKAGES, name, "package.json")),
				`packages/${pkg} declares ${dep} but packages/${name} has no manifest`,
			).toBe(true);
		}
	}
});

test("the guard has teeth: the known cross-package edges are detected", () => {
	// Subset, not equality — new edges may land; a zero or broken scan may not.
	const known: [string, string][] = [
		["belt", "blam"],
		["blam", "belt"],
		["blam", "suspenders"],
		["buckle", "blam"],
		["suspenders", "blam"],
	];
	for (const [pkg, dep] of known) {
		expect(
			imported(pkg).has(`@klh/${dep}`),
			`scan lost the known edge ${pkg} -> ${dep}; the import regex rotted`,
		).toBe(true);
	}
});

// W1238.3 relative-import guard: production .ts reaches into another
// package by relative path ONLY through the pinned allowlist below
// (file -> reached packages, equality-checked). A new cross-package
// relative import must either land here RELATIVE_CROSS_PACKAGE_ALLOWLIST or
// convert to a named @klh/<pkg> import with the edge declared in
// package.json (checked by the guard above). The remaining edges are the
// recorded deviation (docs/decision-w1238.3-strict-install-conformance.md):
// the harness payload preserves the packages/ layout under .harness/, so
// the relative depth is an install invariant — proven every CI run by the
// artifact-roundtrip job, which builds every installed entrypoint.
const RELATIVE_CROSS_PACKAGE_ALLOWLIST: Record<string, string[]> = {
	"belt/bench/arena/review-pipeline.ts": ["suspenders"],
	"belt/bench/arena/transforms.ts": ["blam"],
	"belt/bin/dashboard.ts": ["telemetry"],
	"belt/bin/escalate.ts": ["telemetry"],
	"belt/bin/health.ts": ["telemetry"],
	"belt/bin/http-citizenship.ts": ["telemetry"],
	"belt/bin/hubs.ts": ["suspenders"],
	"belt/bin/memory-policy.ts": ["local-llm"],
	"belt/bin/model-store-lib.ts": ["local-llm"],
	"belt/bin/model-store.ts": ["buckle", "local-llm", "suspenders"],
	"belt/bin/observation.ts": ["local-llm"],
	"belt/bin/router-core.ts": ["buckle", "telemetry"],
	"belt/bin/router-shim.ts": ["telemetry"],
	"belt/bin/stream-prelude.ts": ["buckle"],
	"blam/bench/improve/loop.ts": ["suspenders"],
	"buckle/src/citizenship.ts": ["telemetry"],
	"buckle/src/forced-failover-drill.ts": ["telemetry"],
	"buckle/src/handlers.ts": ["telemetry"],
	"buckle/src/ledger.ts": ["telemetry"],
	"buckle/src/router.ts": ["telemetry"],
	"buckle/src/wire.ts": ["telemetry"],
	"decant/fleet/after-sync.ts": ["suspenders"],
	"decant/fleet/registry.ts": ["suspenders"],
	"local-llm/litellm-target.ts": ["belt"],
	"local-llm/models.catalog.ts": ["belt"],
	"local-llm/registry.ts": ["belt"],
	"local-llm/spawner.ts": ["belt"],
	"local/bin/observation.ts": ["local-llm"],
	"suspenders/deploy/hub-metrics.ts": ["buckle"],
	"suspenders/deploy/hub-policy.ts": ["buckle"],
	"suspenders/deploy/trace-tunnel.ts": ["telemetry"],
	"suspenders/deploy/zai-catalog.ts": ["belt", "buckle"],
	"suspenders/e2e/console-network-hours.spec.ts": ["buckle"],
	"suspenders/e2e/ent-fixture-module.ts": ["hooks"],
	"suspenders/hooks/bin/fallback-drill.ts": ["buckle"],
	"suspenders/hooks/bin/prefix-keepwarm.ts": ["buckle"],
	"suspenders/hooks/board/buckle-observation-relay.ts": ["buckle"],
	"suspenders/hooks/board/network-overview.ts": ["buckle"],
	"suspenders/hooks/board/prompt-transform.ts": ["belt"],
	"suspenders/hooks/board/routes-observations.ts": ["buckle"],
	"suspenders/hooks/board/suggest.ts": ["local-llm"],
	"suspenders/hooks/lib/inventory-probe.ts": ["belt"],
	"suspenders/hooks/lib/observation.ts": ["local-llm"],
	"suspenders/hooks/lib/oracle-legs.ts": ["belt"],
	"suspenders/hooks/lib/service-inventory.ts": ["belt"],
	"suspenders/scripts/dispatch-watchdog.ts": ["belt"],
	"suspenders/scripts/install-llm-steps.ts": ["belt"],
	"suspenders/scripts/lib/lane-settings.ts": ["telemetry"],
	"suspenders/scripts/lib/watchdog-memory.ts": ["belt", "local-llm"],
	"suspenders/scripts/prompt-bench.ts": ["belt"],
	"suspenders/scripts/route-preflight.ts": ["belt", "buckle"],
	"suspenders/sim/ikea-pilot.ts": ["buckle"],
};

test("cross-package relative imports stay within the pinned allowlist", () => {
	const seen = new Map<string, Set<string>>();
	for (const pkg of readdirSync(PACKAGES).sort()) {
		const files = [
			...new Bun.Glob("**/*.ts").scanSync({
				cwd: join(PACKAGES, pkg),
				onlyFiles: true,
			}),
		].filter((f) => !f.includes("node_modules") && !f.endsWith(".test.ts"));
		for (const file of files) {
			const src = readFileSync(join(PACKAGES, pkg, file), "utf8");
			for (const m of src.matchAll(
				/(?:from|import)\s*\(?\s*["']([.][/.][^"']+)["']/g,
			)) {
				// join() normalizes the ../ segments; the first segment under
				// packages/ names the package reached into (".." escapes above)
				const target = join(join(PACKAGES, pkg, file), "..", m[1]);
				const reached = target.startsWith(`${PACKAGES}/`)
					? target.slice(PACKAGES.length + 1).split("/")[0]
					: "..";
				if (reached === pkg) continue;
				const set = seen.get(`${pkg}/${file}`) ?? new Set<string>();
				set.add(reached);
				seen.set(`${pkg}/${file}`, set);
			}
		}
	}
	// equality, not subset: a missing allowlist row means the scan rotted;
	// an unexpected row means a NEW undeclared cross-package relative edge —
	// convert it to a named @klh/<pkg> import or pin it here consciously
	const seenRows: Record<string, string[]> = {};
	for (const [file, set] of [...seen].sort((a, b) => a[0].localeCompare(b[0])))
		seenRows[file] = [...set].sort();
	expect(
		Object.keys(RELATIVE_CROSS_PACKAGE_ALLOWLIST).length,
		"allowlist rotted to zero rows; the scan regex broke",
	).toBeGreaterThanOrEqual(40);
	expect(seenRows).toEqual(RELATIVE_CROSS_PACKAGE_ALLOWLIST);
});
