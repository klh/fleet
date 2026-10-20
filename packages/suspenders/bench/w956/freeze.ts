// bench/w956 — FROZEN pre-bench corpus (W956 round-2 protocol).
// Snapshots the transcript sources the bench reads (claude projects +
// codex) into a private snapshot tree, keeping ONLY files last written
// before the freeze instant, then seals the freeze with a manifest.
// Excluded: (1) everything written after the freeze — incl. this lane's
// own live transcript (bench and judge read ONLY the snapshot);
// (2) the W949/W956 bench-lane transcript dirs — the round-1 self-echo
// and fact-echo era — excluded regardless of mtime. Secrets (auth,
// credentials, .env, keys/pems) are never copied.
// Verify: bun freeze.ts (idempotent re-runs re-walk; use a fresh
// snapshot dir per freeze) && cat results/corpus-manifest.json
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const SNAPSHOT = "/tmp/w956-frozen-corpus2";
const HOME = process.env.HOME ?? "";
const FREEZE_AT = new Date();
// Bench-lane transcript dirs (claude munged-cwd layout) — always out.
const BENCH_DIRS = /worktrees-W9(49|56)(-|\/|$)/;
// Never copied: auth, credentials, env files, key material.
const SECRET =
	/(^|\/)(auth\.json|\.credentials[^/]*|\.env[^/]*|[^/]*\.env|[^/]*\.(pem|key))$/i;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

interface Entry {
	rel: string;
	bytes: number;
	mtime: string;
}

async function walk(
	root: string,
	base: string,
	keep: Entry[],
	skipped: { postFreeze: number; bench: number; secret: number },
): Promise<void> {
	let names;
	try {
		names = await readdir(root, { withFileTypes: true });
	} catch {
		return; // source vanished mid-walk: fine, corpus is best-effort
	}
	for (const name of names) {
		const p = join(root, name.name);
		const rel = relative(base, p);
		if (BENCH_DIRS.test(rel)) {
			skipped.bench += name.isDirectory()
				? await countTree(p)
				: 1;
			continue;
		}
		if (name.isDirectory()) {
			if (SKIP_DIRS.has(name.name)) continue;
			await walk(p, base, keep, skipped);
			continue;
		}
		if (!name.isFile() || SECRET.test(rel)) {
			if (name.isFile()) skipped.secret += 1;
			continue;
		}
		const st = await stat(p);
		if (st.mtimeMs > FREEZE_AT.getTime()) {
			skipped.postFreeze += 1;
			continue;
		}
		keep.push({ rel, bytes: st.size, mtime: st.mtime.toISOString() });
	}
}

async function countTree(root: string): Promise<number> {
	let n = 0;
	let names;
	try {
		names = await readdir(root, { withFileTypes: true });
	} catch {
		return n;
	}
	for (const name of names) {
		if (name.isDirectory()) {
			if (SKIP_DIRS.has(name.name)) continue;
			n += await countTree(join(root, name.name));
		} else if (name.isFile()) n += 1;
	}
	return n;
}

async function copy(key: string, keep: Entry[], srcRoot: string): Promise<void> {
	for (const e of keep) {
		// Per-source subdir: <snapshot>/<key>/<rel> — keeps the two source
		// namespaces disjoint for decant's per-source discovery.
		const dest = join(SNAPSHOT, key, e.rel);
		if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(join(srcRoot, e.rel), dest);
		utimesSync(dest, new Date(), new Date(e.mtime));
	}
}

// Post-copy audit: the snapshot must contain no bench-era path and no
// file newer than the freeze instant (+60s slack for copy rounding).
async function audit(expected: Record<string, number>): Promise<void> {
	let benchHits = 0;
	let postFreeze = 0;
	let counted = 0;
	async function scan(root: string): Promise<void> {
		let names;
		try {
			names = await readdir(root, { withFileTypes: true });
		} catch {
			return;
		}
		for (const name of names) {
			const p = join(root, name.name);
			const rel = relative(SNAPSHOT, p);
			if (BENCH_DIRS.test(rel)) {
				benchHits += 1;
				continue;
			}
			if (name.isDirectory()) {
				await scan(p);
				continue;
			}
			if (name.isFile()) {
				counted += 1;
				if ((await stat(p)).mtimeMs > FREEZE_AT.getTime() + 60_000) postFreeze += 1;
			}
		}
	}
	await scan(SNAPSHOT);
	for (const [key, n] of Object.entries(expected)) {
		counted = 0;
		await scan(join(SNAPSHOT, key));
		if (counted !== n) {
			console.error(`FREEZE AUDIT FAILED ${key}: counted ${counted}, manifest says ${n}`);
			process.exit(1);
		}
	}
	if (benchHits > 0 || postFreeze > 0) {
		console.error(`FREEZE AUDIT FAILED benchHits=${benchHits} postFreeze=${postFreeze}`);
		process.exit(1);
	}
}

const sources: Record<string, { files: number; bytes: number; skipped: Record<string, number> }> =
	{};
for (const key of ["claude-projects", "codex"]) {
	const root = key === "codex" ? join(HOME, ".codex") : join(HOME, ".claude/projects");
	const keep: Entry[] = [];
	const skipped = { postFreeze: 0, bench: 0, secret: 0 };
	await walk(root, root, keep, skipped);
	const bytes = keep.reduce((s, e) => s + e.bytes, 0);
	sources[key] = {
		files: keep.length,
		bytes,
		skipped: {
			postFreeze: skipped.postFreeze,
			benchDirs: skipped.bench,
			secrets: skipped.secret,
		},
	};
	await copy(key, keep, root);
	await Bun.write(
		join(SNAPSHOT, `manifest-${key}.json`),
		JSON.stringify({ key, entries: keep }, null, 1),
	);
}
const seal = createHash("sha256")
	.update(JSON.stringify(sources))
	.update(FREEZE_AT.toISOString())
	.digest("hex");
const manifest = {
	cutoff: FREEZE_AT.toISOString(),
	snapshot: SNAPSHOT,
	sources,
	seal,
};
await Bun.write(
	join(import.meta.dir, "results/corpus-manifest.json"),
	JSON.stringify(manifest, null, 1),
);
await audit(Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.files])));
console.log(
	`frozen ${FREEZE_AT.toISOString()} seal=${seal.slice(0, 12)} ` +
		Object.entries(sources)
			.map(([k, v]) => `${k}=${v.files}f/${(v.bytes / 1e9).toFixed(2)}GB`)
			.join(" "),
);
