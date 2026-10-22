// scripts/build-vendor.ts — the ONE vendor build face (W1107.2.2): runs the
// pinned production split build into hooks/board-html/vendor, then reconciles
// the dir (prunes chunks the build no longer produces — hash-named lit chunks
// accumulate stale files when sources move) and prepends the BSD-3-Clause
// license banner to the third-party lit-*.js chunks. The first-party
// klh-*/usage-panels outputs stay unbannered — the root Fleet LICENSE covers
// them; license-audit verifies the lit banner marker. package.json's
// build:vendor runs this file verbatim — flags, banner and prune have one
// source of truth; the W292 vendor-hash test reuses the same face with
// --outdir swapped for a tmpdir.
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_OUTDIR = join(ROOT, "hooks/board-html/vendor");
const SOURCES = [
	"hooks/board-html/klh-components.ts",
	"hooks/board-html/klh-service-row.ts",
	"hooks/board-html/klh-recovery.ts",
	"hooks/board-html/klh-hub-admin.ts",
	"hooks/board-html/klh-topbar.ts",
	"hooks/board-html/klh-board-tabs.ts",
	"hooks/board-html/usage-panels.ts",
	"hooks/board-html/klh-console-cards.ts",
	"hooks/board-html/klh-console-forms.ts",
	"hooks/board-html/klh-ent-zone.ts",
] as const;
const FLAGS = [
	"--root",
	"hooks/board-html",
	"--minify",
	"--production",
	"--splitting",
	"--chunk-naming",
	"lit-[hash].[ext]",
] as const;
const BANNER =
	"// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.\n";

export function buildVendorArgv(outdir: string): string[] {
	return ["build", ...SOURCES, ...FLAGS, "--outdir", outdir];
}

// Prepend the banner to the minified third-party lit chunks. Idempotent: an
// already-bannered chunk keeps exactly one banner.
export function bannerLitChunks(outdir: string): string[] {
	const done: string[] = [];
	for (const f of readdirSync(outdir).sort()) {
		if (!f.startsWith("lit-") || !f.endsWith(".js")) continue;
		const p = join(outdir, f);
		const body = readFileSync(p, "utf8");
		if (body.startsWith(BANNER)) continue;
		writeFileSync(p, `${BANNER}${body}`);
		done.push(f);
	}
	return done;
}

// Remove files the build no longer emits (stale hash-named chunks; the
// --chunk-naming template covers only lit-*, so everything else is an entry).
export function pruneStaleArtifacts(
	outdir: string,
	fresh: Set<string>,
): string[] {
	const gone: string[] = [];
	for (const f of readdirSync(outdir).sort()) {
		if (fresh.has(f)) continue;
		rmSync(join(outdir, f));
		gone.push(f);
	}
	return gone;
}

// Build to a staging tmpdir (never the repo dir mid-build), banner, then
// reconcile the outdir to exactly the fresh set. `bun build` does not clean
// the outdir and hash-named chunks accumulate — that drift is what this
// face exists to prevent.
export function buildVendor(outdir: string): {
	pruned: string[];
	bannered: string[];
} {
	const staging = join(tmpdir(), `vendor-build-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	const p = Bun.spawnSync(["bun", ...buildVendorArgv(staging)], {
		cwd: ROOT,
		// bun's minifier names symbols differently per NODE_ENV class — pin
		// production so a `bun test` run byte-matches `bun run build:vendor`.
		env: { ...process.env, NODE_ENV: "production" },
		stdout: "inherit",
		stderr: "inherit",
	});
	if (p.exitCode !== 0)
		throw new Error(`bun build failed with exit ${p.exitCode}`);
	mkdirSync(outdir, { recursive: true });
	const fresh = new Set(readdirSync(staging).sort());
	const bannered = bannerLitChunks(staging);
	for (const f of fresh) {
		const src = readFileSync(join(staging, f));
		writeFileSync(join(outdir, f), src);
	}
	const pruned = pruneStaleArtifacts(outdir, fresh);
	rmSync(staging, { recursive: true, force: true });
	return { pruned, bannered };
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const oi = argv.indexOf("--outdir");
	const outdir =
		oi > -1 && argv[oi + 1] ? resolve(argv[oi + 1]) : DEFAULT_OUTDIR;
	const r = buildVendor(outdir);
	if (r.pruned.length > 0) console.log(`pruned: ${r.pruned.join(" ")}`);
	if (r.bannered.length > 0) console.log(`bannered: ${r.bannered.join(" ")}`);
	console.log(`vendor build → ${outdir}`);
}
