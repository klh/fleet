// tests/helpers/p1-contract-small.ts — helpers for p1-package-contract-small.e2e.ts
// (playwright --bun spec-shape law: the spec file keeps imports + plain-JS
// test bodies only; declarations and TS types live here).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// repo root from this file, never cwd — the CLI may run from tests/ or root
export const ROOT = join(import.meta.dir, "..", "..");
export const EXACT = /^\d+\.\d+\.\d+$/;
export const PACKAGES = ["kernel", "local-llm", "local", "speedy", "blam"];
export const DEP_GROUPS = ["dependencies", "devDependencies", "peerDependencies"];

export const readManifest = (p: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(ROOT, "packages", p, "package.json"), "utf8"));

/** A manifest field as a string map (absent = empty). */
export const field = (
	manifest: Record<string, unknown>,
	key: string,
): Record<string, string> => (manifest[key] ?? {}) as Record<string, string>;

/** A manifest field as a string list (absent = empty). */
export const list = (manifest: Record<string, unknown>, key: string): string[] =>
	(manifest[key] ?? []) as string[];

/** Name-based @klh/<pkg>/... specifiers used by any file under packages/ + tests/. */
export function crossPackageSpecifiers(pkg: string): string[] {
	const found = new Set<string>();
	const specifiers = new RegExp(`["']@klh/${pkg}/([^"']+)["']`, "g");
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				if (entry === "node_modules" || entry === ".harness") continue;
				walk(path);
			} else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
				for (const m of readFileSync(path, "utf8").matchAll(specifiers))
					// placeholder literals ("@klh/blam/...") in fixtures are not specifiers
					if (/[a-z0-9]/i.test(m[1] ?? "")) found.add(m[1] ?? "");
			}
		}
	};
	walk(join(ROOT, "packages"));
	walk(join(ROOT, "tests"));
	return [...found];
}

export const covered = (sub: string, patterns: string[]): boolean =>
	patterns.some((raw) => {
		const pattern = raw.replace("./", "");
		if (!pattern.includes("*")) return sub === pattern;
		const star = pattern.indexOf("*");
		const head = pattern.slice(0, star);
		const tail = pattern.slice(star + 1);
		return (
			sub.startsWith(head) &&
			sub.endsWith(tail) &&
			sub.length >= head.length + tail.length
		);
	});

export const RUNNABLES: Record<string, string[]> = {
	kernel: [],
	"local-llm": ["lane-load-bench"],
	local: ["klh-local", "dashboard"],
	speedy: ["install-fleet", "quiet-output"],
	blam: ["blam-label"],
};
