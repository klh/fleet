// vendor-hash.test.ts — W292 (W278 review finding #9): the committed vendored
// Lit bundles must byte-match a fresh production build (drift alarm), ship
// WITHOUT the dev-mode runtime ("Lit is in dev mode"), and share ONE lit copy
// via a lit-shared.js chunk instead of inlining lit per bundle. The fresh
// build reuses the package.json `build:vendor` line verbatim (shell-quote
// parsed, outdir swapped for a tmpdir) so the flags have one source of truth;
// the repo's vendor/ dir is never written by this test.
import { describe, expect, test } from "bun:test";
import { readdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "shell-quote";

const ROOT = join(import.meta.dir, "..");
const VENDOR = join(ROOT, "hooks/board-html/vendor");

function sha256(b: Buffer): string {
	return createHash("sha256").update(b).digest("hex");
}

// "bun build <entries…> --flags… --outdir <dir>" — parsed, never mirrored;
// the outdir value is swapped for a throwaway tmpdir so the test never
// writes the repo's vendor/ dir.
function freshBuild(): Map<string, string> {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const argv = parse(pkg.scripts["build:vendor"]) as string[];
	expect(argv[0]).toBe("bun");
	expect(argv[1]).toBe("build");
	const i = argv.indexOf("--outdir");
	expect(i).toBeGreaterThan(-1);
	const out = mkdtempSync(join(tmpdir(), "w292-vendor-"));
	argv[i + 1] = out;
	try {
		const p = Bun.spawnSync(argv, {
			cwd: ROOT,
			// bun's minifier names symbols differently per NODE_ENV class
			// (unset/production vs test/development) — pin the child so a
			// `bun test` run (NODE_ENV=test) still byte-matches committed
			// artifacts built the plain `bun run build:vendor` way.
			env: { ...process.env, NODE_ENV: "production" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
		const hashes = new Map<string, string>();
		for (const f of readdirSync(out).sort())
			hashes.set(f, sha256(readFileSync(join(out, f))));
		return hashes;
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

describe("vendor-hash (W292)", () => {
	test("build:vendor stays a production split build with a named lit chunk", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		const script: string = pkg.scripts["build:vendor"];
		expect(script).toBeDefined();
		for (const token of [
			"--minify",
			"--production",
			"--splitting",
			"--chunk-naming",
			"lit-shared.[ext]",
			"hooks/board-html/klh-components.ts",
			"hooks/board-html/klh-service-row.ts",
		])
			expect(script).toContain(token);
	});

	test("committed vendor artifacts byte-match a fresh production build", () => {
		const fresh = freshBuild();
		const committed = new Map<string, string>();
		for (const f of readdirSync(VENDOR).sort())
			committed.set(f, sha256(readFileSync(join(VENDOR, f))));
		expect([...fresh.keys()].filter((f) => !f.endsWith(".js"))).toEqual([]);
		expect([...fresh.keys()]).toEqual([...committed.keys()]);
		const drifted = [...fresh].filter(([f, h]) => committed.get(f) !== h);
		expect(drifted.map(([f]) => f)).toEqual([]);
	});

	test("artifacts ship production lit — no dev-mode runtime anywhere", () => {
		for (const f of readdirSync(VENDOR)) {
			const s = readFileSync(join(VENDOR, f), "utf8");
			expect(s).not.toContain("Lit is in dev mode");
		}
	});

	test("one shared lit chunk; both entries import that same chunk", () => {
		const files = readdirSync(VENDOR).filter((f) => f.endsWith(".js"));
		const chunks = files.filter((f) => f === "lit-shared.js");
		expect(chunks).toHaveLength(1);
		const chunk = chunks[0] ?? "";
		for (const entry of ["klh-components.js", "klh-service-row.js"])
			expect(readFileSync(join(VENDOR, entry), "utf8")).toContain(`./${chunk}`);
	});
});
