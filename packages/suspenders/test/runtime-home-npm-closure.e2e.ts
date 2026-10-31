// test/runtime-home-npm-closure.e2e.ts — W2343: the 2026-10-23/24 incident
// pinned as a law. W1253-A removed `from "yaml"` (and the dep) from the
// checkout's stack-config.ts, but the runtime home
// (~/.claude/local-llm/stack-config.ts) kept the old bytes and the belt
// supervisor crash-looped 791× on "Cannot find package 'yaml'" until the
// next install's refreshFlatHome healed the closure. The flat home rides
// the PREFIX's node_modules (W778) — so every bare npm specifier in the
// shipped closure (belt/bin entries + members + cross-package externals)
// must be a PROD dependency of the installed package: a devDep-only or
// undeclared import ships as a dark import in the runtime home. This spec
// re-walks the real repo closure at test time — a new bare import that
// prod deps don't cover fails HERE, at the change, not at the next boot.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { beltBinClosure, flatExternals } from "../scripts/belt-bin-overlay.ts";

const PKG_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");

/** The entries install seeds + heals into the runtime home (W284/W661):
 *  the swarm supervisor and the :4000 router. */
const CLOSURE_ENTRIES = [
	join(REPO_ROOT, "packages", "belt", "bin", "swarm.ts"),
	join(REPO_ROOT, "packages", "belt", "bin", "router-shim.ts"),
] as const;

/** Every file refreshFlatHome materializes into the flat home for the
 *  entries above: the entry, its belt/bin closure members, and the
 *  cross-package externals flattened to sibling basenames. */
async function flatClosureFiles(): Promise<string[]> {
	const files = new Set<string>();
	for (const entry of CLOSURE_ENTRIES) {
		const root = dirname(entry);
		files.add(resolve(entry));
		for (const rel of await beltBinClosure(entry, root))
			files.add(resolve(root, rel));
		for (const external of (await flatExternals(entry, root)).keys())
			files.add(external);
	}
	return [...files];
}

/** Bare (non-relative, non-`node:`, non-@klh) package specifiers — the
 *  imports that resolve against the runtime home's node_modules symlink. */
function bareSpecifiers(source: string): string[] {
	const specs = new Set<string>();
	const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;
	for (const match of source.matchAll(pattern)) {
		const spec = match[1];
		if (
			spec.startsWith(".") ||
			spec.startsWith("node:") ||
			spec.startsWith("bun:") ||
			spec.startsWith("@klh/")
		)
			continue;
		specs.add(spec);
	}
	return [...specs];
}

test("every bare npm import in the flat-home closure is a prod dep @unit", async () => {
	const prod = new Set(
		Object.keys(
			JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"))
				.dependencies ?? {},
		),
	);
	const missing: string[] = [];
	for (const file of await flatClosureFiles()) {
		for (const spec of bareSpecifiers(readFileSync(file, "utf8"))) {
			if (!prod.has(spec))
				missing.push(`${file.replace(`${REPO_ROOT}/`, "")} → "${spec}"`);
		}
	}
	expect(
		missing,
		[
			"bare npm imports the installed package does not ship as a PROD dep",
			"(W2343: the runtime home resolves these against the prefix",
			"node_modules — a devDep/undeclared import is dark at boot):",
			...missing,
		].join("\n"),
	).toEqual([]);
});

test("the flat-home closure never imports the retired yaml package @unit", async () => {
	const offenders: string[] = [];
	for (const file of await flatClosureFiles()) {
		if (bareSpecifiers(readFileSync(file, "utf8")).includes("yaml"))
			offenders.push(file.replace(`${REPO_ROOT}/`, ""));
	}
	expect(
		offenders,
		[
			"closure files importing the retired yaml package",
			"(W1253-A: fleet config is JSON — JSON.parse is the ONE parser;",
			"a yaml import here crash-looped the belt supervisor 791×,",
			"W2343):",
			...offenders,
		].join("\n"),
	).toEqual([]);
});
