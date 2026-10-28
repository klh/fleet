#!/usr/bin/env bun
// W2178 fail-closed guard: every tracked *.e2e.ts must be collected by some
// playwright config (effective testDir + testMatch per project). A spec no
// config matches never runs anywhere — "No tests found" by omission.
// Mirrors Playwright's file matcher: a slash-free string pattern matches at
// any depth (`**/` prefix), relative to the project's testDir.
import { dirname, relative, resolve } from "node:path";

type Matcher = string | RegExp | Array<string | RegExp>;
type Proj = { testDir?: string; testMatch?: Matcher };
type Conf = Proj & { projects?: Proj[] };

const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
	stdout: "pipe",
}).stdout.toString().trim();
const ls = (glob: string) =>
	Bun.spawnSync(["git", "ls-files", glob], { cwd: root, stdout: "pipe" })
		.stdout.toString()
		.split("\n")
		.filter(Boolean)
		.map((f) => resolve(root, f));

const hits = (m: Matcher, rel: string, abs: string): boolean => {
	if (Array.isArray(m)) return m.some((x) => hits(x, rel, abs));
	if (m instanceof RegExp) return m.test(abs);
	const glob = m.includes("/") ? m : `**/${m}`;
	return new Bun.Glob(glob).match(rel);
};

const scopes: Array<{ dir: string; match: Matcher }> = [];
for (const cfgPath of ls("*playwright.config.ts")) {
	const cfg = ((await import(cfgPath)) as { default: Conf }).default;
	const base = dirname(cfgPath);
	for (const p of cfg.projects?.length ? cfg.projects : [{}]) {
		const dir = resolve(base, p.testDir ?? cfg.testDir ?? ".");
		scopes.push({ dir, match: p.testMatch ?? cfg.testMatch ?? "**/*.@(spec|test).?(c|m)[jt]s?(x)" });
	}
}

const orphans = ls("*.e2e.ts").filter(
	(abs) =>
		!scopes.some(({ dir, match }) => {
			const rel = relative(dir, abs);
			return !rel.startsWith("..") && !rel.includes("node_modules") && hits(match, rel, abs);
		}),
);
if (orphans.length) {
	console.error(`playwright coverage: ${orphans.length} *.e2e.ts matched by no config:`);
	for (const o of orphans) console.error(`  ${relative(root, o)}`);
	process.exit(1);
}
console.log(`playwright coverage: ${ls("*.e2e.ts").length} specs, all collected`);
