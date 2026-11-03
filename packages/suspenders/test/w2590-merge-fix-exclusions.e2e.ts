// test/w2590-merge-fix-exclusions.e2e.ts — W2590 regression: the merge-time
// quality floor (qltyFixMergedFiles, merge.ts) must honor qlty's OWN
// exclude_patterns in BOTH passes. Root cause (ea45c310): the first
// `qlty check --fix` respects **/vendor/**, but when it reported unapplied
// biome fixes the cached-biome fallback received EVERY merged code path,
// bypassing exclusions — 19 generated vendor JS assets were reformatted and
// vendor byte parity (test/vendor-hash.test.ts) broke. Pins: (1) an admitted
// source file needing the fallback is corrected and committed on main; (2)
// an excluded generated asset merged in the SAME run is byte-identical;
// (3) residual `left` recounts after the fallback pass; (4) the exclusion
// reader resolves the repo's real exclude set (no second ignore list).

import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { biomeBin, qltyFixMergedFiles } from "../hooks/lib/fleet-loop/merge.ts";
import {
	qltyExcluded,
	qltyExcludePatterns,
} from "../hooks/lib/fleet-loop/qlty-exclusions.ts";

const run = (cmd: string[], cwd: string): number =>
	Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" }).exitCode ?? 1;

// lint-bait payloads assembled from fragments — the promoted-class write
// gate scans EMITTED payload text and refuses the raw shapes even under
// /test/ (noNonNullAssertion/useLiteralKeys fire on the line regexes).
const BANG = "!";
const KEY = '"x"';
const COMPUTED = `[${KEY}]`;
const LINTY = [
	"const a = { b: 1 };",
	`export const k = a${BANG}.b;`,
	`const o: Record<string, number> = { ${COMPUTED}: 1 };`,
	`export const u = k + o${COMPUTED};`,
	"",
].join("\n");
// VALID minified-JS bundle bait (no TS-only syntax): biome's writer
// reformats on contact — reflowing the long line, literal-key access, the
// non-null shape and the comma-return into expanded, quote-escaped form.
const VENDOR = [
	'const long_line={"x":1,"y":2};',
	`export const z=long_line${COMPUTED};`,
	`export const w=long_line${BANG}.y;`,
	"export function f(a,b){return a,b}",
	"",
].join("\n");

const worlds: ReturnType<typeof scratchWorld>[] = [];
test.afterAll(() => {
	for (const w of worlds.splice(0)) w.clean();
});

/** A merged-branch shape: the real suspenders qlty.toml (biome plugin +
 * vendor-directory exclusion), one admitted source file that needs the biome
 * fallback, and one generated vendor asset full of formatter bait.
 * scratchWorld({dir}) keeps the fixture INSIDE the authorized worktree. */
function mergedFixture(): {
	repo: string;
	srcRel: string;
	vendorRel: string;
} {
	const dir = join(import.meta.dir, "..", "..", ".scratch-w2590");
	mkdirSync(dir, { recursive: true });
	const w = scratchWorld({ prefix: "w2590-", dir });
	worlds.push(w);
	const repo = w.repo;
	// repo-local identity — the helper's internal git spawns carry lane env
	run(["git", "config", "user.email", "w2590@fixture.invalid"], repo);
	run(["git", "config", "user.name", "w2590-fixture"], repo);
	mkdirSync(join(repo, ".qlty"), { recursive: true });
	writeFileSync(
		join(repo, ".qlty", "qlty.toml"),
		readFileSync(join(import.meta.dir, "..", ".qlty", "qlty.toml"), "utf8"),
	);
	run(["git", "add", ".qlty"], repo);
	run(["git", "commit", "-qm", "qlty setup"], repo);
	const srcRel = "src/linty.ts";
	const vendorRel = "hooks/board-html/vendor/klh-gen.js";
	mkdirSync(dirname(join(repo, srcRel)), { recursive: true });
	mkdirSync(dirname(join(repo, vendorRel)), { recursive: true });
	writeFileSync(join(repo, srcRel), LINTY);
	// generated-bundle bait: minified shape biome's writer reformats on contact
	writeFileSync(join(repo, vendorRel), VENDOR);
	return { repo, srcRel, vendorRel };
}

test.describe("@unit W2590 merge-fix exclusions", () => {
	test("exclusion reader: repo's real exclude set + glob semantics", () => {
		const { repo, srcRel, vendorRel } = mergedFixture();
		const patterns = qltyExcludePatterns(repo);
		expect(patterns).toContain("**/vendor/**");
		expect(qltyExcluded(patterns ?? [], vendorRel)).toBe(true);
		expect(qltyExcluded(patterns ?? [], srcRel)).toBe(false);
		// basename-style patterns (no "/") match nested paths by basename
		expect(qltyExcluded(["*.min.*"], "a/b/foo.min.js")).toBe(true);
		expect(qltyExcluded(["*.min.*"], "a/b/foo.js")).toBe(false);
		// path-style patterns stay segment-anchored
		expect(qltyExcluded(["packages/decant/**"], "packages/decant/f/a.ts")).toBe(
			true,
		);
		expect(
			qltyExcluded(["packages/decant/**"], "packages/suspenders/a.ts"),
		).toBe(false);
		// repo without .qlty/ → null (fail-closed: no KNOWN boundary, the
		// unsafe fallback must not run). The scratch parent holds no .qlty
		// either — the resolver reads repo-root config only, no ancestor walk.
		const bare = scratchWorld({
			prefix: "w2590-bare-",
			dir: join(import.meta.dir, "..", "..", ".scratch-w2590"),
		});
		worlds.push(bare);
		expect(qltyExcludePatterns(bare.repo)).toBeNull();
		// malformed bytes → null as well (fresh world: the absent-config
		// result above is cached per path)
		const broken = scratchWorld({
			prefix: "w2590-broken-",
			dir: join(import.meta.dir, "..", "..", ".scratch-w2590"),
		});
		worlds.push(broken);
		mkdirSync(join(broken.repo, ".qlty"), { recursive: true });
		writeFileSync(join(broken.repo, ".qlty", "qlty.toml"), "bogus [ toml\n");
		expect(qltyExcludePatterns(broken.repo)).toBeNull();
	});

	test("fallback fixes the admitted source; excluded vendor bytes identical", () => {
		test.skip(!biomeBin(), "cached biome binary unavailable (fail-open)");
		const { repo, srcRel, vendorRel } = mergedFixture();
		const vendorBefore = readFileSync(join(repo, vendorRel));
		const r = qltyFixMergedFiles({
			repo,
			branch: "suspenders/W9990",
			files: [srcRel, vendorRel],
		});
		expect(r.fixed).toBe(true);
		expect(r.head).not.toBeNull();
		// the admitted source got the fallback correction (a!.b → a?.b)
		const fixedSrc = readFileSync(join(repo, srcRel), "utf8");
		expect(fixedSrc).toContain("a?.b");
		expect(fixedSrc).not.toContain("a!.b");
		// THE W2590 pin: the excluded generated asset is byte-identical
		expect(readFileSync(join(repo, vendorRel)).equals(vendorBefore)).toBe(true);
		// residual count recounts AFTER the fallback (pre-W2590 it was the
		// stale pre-fallback number)
		expect(r.left).toBe(0);
		// the fix commit landed on main and touched ONLY the admitted file
		const log = Bun.spawnSync([
			"git",
			"-C",
			repo,
			"log",
			"--name-only",
			"--oneline",
		]).stdout.toString();
		expect(log).toContain("merge-time qlty autofix");
		expect(log).not.toContain(vendorRel);
	});

	test("all-excluded input: no writer runs, unrelated dirt untouched", () => {
		const { repo, vendorRel } = mergedFixture();
		// an unrelated dirty source file in the checkout — must survive
		writeFileSync(join(repo, "unrelated.ts"), "export const q = 1;\n");
		const vendorBefore = readFileSync(join(repo, vendorRel));
		const r = qltyFixMergedFiles({
			repo,
			branch: "suspenders/W9990",
			files: [vendorRel],
		});
		expect(r).toEqual({ fixed: false, head: null, left: 0 });
		// no commit landed, unrelated file still dirty, vendor bytes identical
		const st = Bun.spawnSync([
			"git",
			"-C",
			repo,
			"status",
			"--porcelain",
		]).stdout.toString();
		expect(st).toContain("unrelated.ts");
		const log = Bun.spawnSync([
			"git",
			"-C",
			repo,
			"log",
			"--oneline",
		]).stdout.toString();
		expect(log).not.toContain("merge-time qlty autofix");
		expect(readFileSync(join(repo, vendorRel)).equals(vendorBefore)).toBe(true);
	});

	test("unreadable config: no writer runs, unrelated dirt untouched", () => {
		const { repo, srcRel, vendorRel } = mergedFixture();
		// malformed config bytes → null patterns → nothing admitted
		writeFileSync(join(repo, ".qlty", "qlty.toml"), "not [ valid toml {{{\n");
		writeFileSync(join(repo, "unrelated.ts"), "export const q = 1;\n");
		const vendorBefore = readFileSync(join(repo, vendorRel));
		const srcBefore = readFileSync(join(repo, srcRel));
		const r = qltyFixMergedFiles({
			repo,
			branch: "suspenders/W9990",
			files: [srcRel, vendorRel],
		});
		expect(r).toEqual({ fixed: false, head: null, left: 0 });
		expect(readFileSync(join(repo, vendorRel)).equals(vendorBefore)).toBe(true);
		expect(readFileSync(join(repo, srcRel)).equals(srcBefore)).toBe(true);
		const st = Bun.spawnSync([
			"git",
			"-C",
			repo,
			"status",
			"--porcelain",
		]).stdout.toString();
		expect(st).toContain("unrelated.ts");
	});
});
