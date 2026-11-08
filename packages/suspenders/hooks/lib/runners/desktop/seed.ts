// seed.ts — W2869.3: the desktop runner's immutable seed bundle.
// seedDigest = sha256 over the canonical seed file set (paths + per-file
// digests, order noise eliminated); policyDigest = sha256 over the
// canonical policy bytes; runtimeImage is digest-pinned at bundle build
// (refused otherwise). Active runs retain their behavior: the seed is
// materialized copy-on-admit into the run workspace and hashed THERE —
// a newer seed root only backs runs admitted after the swap, and a
// materialized snapshot must re-hash exactly to the spec's digest or
// start refuses (no silent fallback).
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digestOf } from "../control/control-state.ts";

export interface SeedFile {
	path: string;
	bytes: Uint8Array;
}

export interface SeedBundle {
	seedDigest: string;
	policyDigest: string;
	runtimeImage: string;
	files: SeedFile[];
}

const SEED_MAX_FILES = 2_000;
const SEED_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_PIN = /@sha256:[a-f0-9]{64}$/;

/** Canonical seed digest: entries sorted by path, each file reduced to
 *  its own sha256 — stable across mtime/dir-listing noise. */
export const canonicalSeedDigest = (files: readonly SeedFile[]): string => {
	const entries = files
		.map((f) => ({ path: f.path, digest: digestOf(f.bytes) }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((e) => `${e.path} ${e.digest}`);
	return digestOf(entries.join("\n"));
};

/** Walk the seed root recursively; symlinks skipped, caps fail loud. */
export const scanSeedDir = async (root: string): Promise<SeedFile[]> => {
	const files: SeedFile[] = [];
	let total = 0;
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		const sorted = [...entries].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const entry of sorted) {
			if (entry.isSymbolicLink()) continue;
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(abs, rel);
				continue;
			}
			const bytes = await readFile(abs);
			total += bytes.byteLength;
			if (files.length >= SEED_MAX_FILES || total > SEED_MAX_BYTES) {
				throw new Error(
					`desktop-runner: seed exceeds caps (${SEED_MAX_FILES} files / ${SEED_MAX_BYTES} bytes) — refusing`,
				);
			}
			files.push({ path: rel, bytes });
		}
	};
	await walk(root, "");
	if (files.length === 0) {
		throw new Error(`desktop-runner: seed root ${root} has no files`);
	}
	return files;
};

/** Copy-on-admit: the run's private seed snapshot, materialized once and
 *  never re-read from the (mutable) seed root afterwards. */
export const materializeSnapshot = async (
	files: readonly SeedFile[],
	destDir: string,
): Promise<void> => {
	await mkdir(destDir, { recursive: true });
	for (const f of files) {
		const abs = join(destDir, f.path);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, f.bytes);
	}
};

/** Re-hash a materialized snapshot directory. */
export const snapshotDigest = async (seedDir: string): Promise<string> =>
	canonicalSeedDigest(await scanSeedDir(seedDir));

/** Refuse drift loudly: a materialized snapshot must re-hash exactly to
 *  the spec's seedDigest or the run cannot start. */
export const verifySnapshotDigest = async (
	seedDir: string,
	expected: string,
): Promise<void> => {
	const actual = await snapshotDigest(seedDir);
	if (actual !== expected) {
		throw new Error(
			`desktop-runner: seed snapshot drift — snapshot ${actual} does not re-hash to spec ${expected} — refusing`,
		);
	}
};

/** Build the bundle for the CURRENT seed root + policy + pinned image. */
export const buildSeedBundle = async (deps: {
	seedRoot: string;
	policyJson: string;
	runtimeImage: string;
}): Promise<SeedBundle> => {
	if (!IMAGE_PIN.test(deps.runtimeImage) || deps.runtimeImage.length === 0) {
		throw new Error(
			`desktop-runner: runtime image must be digest-pinned (@sha256:...) — got ${deps.runtimeImage}`,
		);
	}
	const files = await scanSeedDir(deps.seedRoot);
	return {
		seedDigest: canonicalSeedDigest(files),
		policyDigest: digestOf(deps.policyJson),
		runtimeImage: deps.runtimeImage,
		files,
	};
};
