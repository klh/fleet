// model-store-lib.ts — W763: the hub model store's core. Content-addressed
// model blobs: every acquired file lives at <root>/blobs/<sha256>, and
// <root>/index.json maps catalog ids → {repo, revision, files[]} — the
// store's one ledger. syncCatalog diffs loadCatalog() (W754.1 seam) against
// the index and acquires missing artifacts from an Origin chain — a peer hub
// first (owned links beat origin egress), then the public origin (HF) —
// hash-verifying every byte: LFS weights carry their sha256 from origin,
// non-LFS files get hash-on-first-ingest, and every later transfer
// (hub-to-hub, dev pull via /blobs) verifies against the recorded sha.
// Hub-to-hub replication rides the SAME surface: a peer hub is just another
// Origin (its /models index + authed /blobs), never a DHT.
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { CatalogEntry } from "../../local-llm/models.catalog.ts";

// ─── types ───

export interface FileMeta {
	path: string;
	size: number;
	/** Known before download when the origin declares it (LFS, peer index). */
	sha256?: string;
}

export interface Origin {
	listFiles(repo: string, revision: string): Promise<FileMeta[]>;
	fetchFile(repo: string, revision: string, file: FileMeta): Promise<Response>;
}

export interface ModelRecord {
	id: string;
	repo: string;
	revision: string;
	runtime: "mlx" | "gguf";
	quant?: string;
	files: FileMeta[];
}

export interface StoreIndex {
	version: 1;
	models: Record<string, ModelRecord>;
}

export interface SyncReport {
	added: string[];
	verified: string[];
	failed: Array<{ id: string; error: string }>;
}

// ─── index (the store's one ledger) ───

export const blobsDir = (root: string): string => join(root, "blobs");
const blobPath = (root: string, sha256: string): string =>
	join(blobsDir(root), sha256);
export const indexPath = (root: string): string => join(root, "index.json");

export const loadIndex = (root: string): StoreIndex => {
	const file = indexPath(root);
	if (!existsSync(file)) return { version: 1, models: {} };
	return JSON.parse(readFileSync(file, "utf8")) as StoreIndex;
};

export const saveIndex = (root: string, index: StoreIndex): void => {
	// atomic: write sibling tmp then rename — a crash mid-write never strands
	// a half JSON file as THE index.
	mkdirSync(root, { recursive: true });
	const tmp = `${indexPath(root)}.${randomUUID()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(index, null, "\t")}\n`);
	renameSync(tmp, indexPath(root));
};

// ─── blob ingest: stream → hash → verify → atomic commit ───

export interface IngestResult {
	sha256: string;
	size: number;
	/** True when the blob was already on disk (dedupe, no re-download). */
	deduped: boolean;
}

/** Stream one response body to <root>/blobs/<sha256>, hashing on the way.
 *  expectedSha256 (when the origin declares it) is enforced DURING the
 *  transfer — a mismatched download never lands. */
export async function ingestBlob(
	root: string,
	body: ReadableStream<Uint8Array>,
	expectedSha256?: string,
): Promise<IngestResult> {
	const finalPath = expectedSha256 ? blobPath(root, expectedSha256) : null;
	if (finalPath && existsSync(finalPath)) {
		// drain politely; the store already holds these bytes
		try {
			await body.cancel();
		} catch {}
		const st = statSync(finalPath);
		return { sha256: expectedSha256 as string, size: st.size, deduped: true };
	}
	mkdirSync(join(root, "tmp"), { recursive: true });
	const tmpPath = join(root, "tmp", randomUUID());
	const hasher = createHash("sha256");
	const fd = openSync(tmpPath, "wx");
	let size = 0;
	try {
		for await (const chunk of body) {
			size += chunk.byteLength;
			hasher.update(chunk);
			writeSync(fd, chunk);
		}
	} finally {
		closeSync(fd);
	}
	const sha256 = hasher.digest("hex");
	if (expectedSha256 && sha256 !== expectedSha256) {
		rmSync(tmpPath, { force: true });
		throw new Error(
			`sha256 mismatch: got ${sha256}, origin declared ${expectedSha256}`,
		);
	}
	mkdirSync(blobsDir(root), { recursive: true });
	const target = blobPath(root, sha256);
	if (existsSync(target)) {
		rmSync(tmpPath, { force: true });
		return { sha256, size, deduped: true };
	}
	renameSync(tmpPath, target);
	return { sha256, size, deduped: false };
}

// ─── origins ───

/** The public origin (huggingface.co): tree API for the file list — LFS
 *  entries carry their sha256 upfront — resolve endpoint for bytes. */
export function hfOrigin(opts: { token?: string } = {}): Origin {
	const headers: Record<string, string> = opts.token
		? { authorization: `Bearer ${opts.token}` }
		: {};
	return {
		async listFiles(repo, revision) {
			const u = `https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=true`;
			const res = await fetch(u, { headers });
			if (!res.ok)
				throw new Error(`hf tree ${repo}@${revision}: HTTP ${res.status}`);
			const tree = (await res.json()) as Array<{
				type: string;
				path: string;
				size: number;
				lfs?: { oid?: string };
			}>;
			return tree
				.filter((e) => e.type === "file" && !e.path.startsWith(".git"))
				.map((e) => ({
					path: e.path,
					size: e.size,
					sha256: e.lfs?.oid,
				}));
		},
		async fetchFile(repo, revision, file) {
			const u = `https://huggingface.co/${repo}/resolve/${revision}/${file.path}`;
			return fetch(u, { headers });
		},
	};
}

/** A peer hub as an Origin — its /models index is the file list (every row
 *  declares its sha256), its authed /blobs serves the bytes. */
export function hubOrigin(baseUrl: string, token?: string): Origin {
	const base = baseUrl.replace(/\/$/, "");
	const headers: Record<string, string> = token
		? { authorization: `Bearer ${token}` }
		: {};
	return {
		async listFiles(repo, revision) {
			const res = await fetch(`${base}/models`, { headers });
			if (!res.ok) throw new Error(`peer ${base}: HTTP ${res.status}`);
			const idx = (await res.json()) as StoreIndex;
			const rec =
				Object.values(idx.models ?? {}).find(
					(m) => m.repo === repo && m.revision === revision,
				) ?? null;
			if (!rec) throw new Error(`peer ${base}: no ${repo}@${revision}`);
			return rec.files;
		},
		async fetchFile(_repo, _revision, file) {
			if (!file.sha256) throw new Error("peer pull needs a declared sha256");
			return fetch(`${base}/blobs/${file.sha256}`, { headers });
		},
	};
}

// ─── catalog → store diff + acquire ───

/** GGUF repos (unsloth/bartowski convention) name files <base>-<quant>.gguf;
 *  the catalog row's quant picks the file. */
export const ggufFileName = (repo: string, quant: string): string => {
	const base = (repo.split("/").pop() ?? repo).replace(/-GGUF$/i, "");
	return `${base}-${quant}.gguf`;
};

const blobIntact = (root: string, rec: ModelRecord): boolean => {
	try {
		for (const f of rec.files) {
			const st = statSync(blobPath(root, f.sha256 as string));
			if (st.size !== f.size) return false;
		}
		return rec.files.length > 0;
	} catch {
		return false;
	}
};

const pickFiles = (entry: CatalogEntry, files: FileMeta[]): FileMeta[] => {
	if (entry.runtime !== "gguf") return files; // mlx pulls the whole tree
	if (!entry.quant) return []; // no quant → no derivable artifact; caller reports
	const want = ggufFileName(entry.repo, entry.quant);
	return files.filter((f) => f.path === want);
};

export interface SyncDeps {
	root: string;
	entries: CatalogEntry[];
	/** Tried in order — first origin that lists the entry's repo wins. */
	origins: Origin[];
	log?: (msg: string) => void;
}

/** The sync verb: diff the catalog vs the store, acquire what's missing.
 *  Index saves are per-entry and atomic, so a run interrupted at entry 3 of
 *  5 keeps 1–2 — the next sync re-diffs and continues. */
export async function syncCatalog(deps: SyncDeps): Promise<SyncReport> {
	const index = loadIndex(deps.root);
	const report: SyncReport = { added: [], verified: [], failed: [] };
	for (const entry of deps.entries) {
		const existing = index.models[entry.id];
		if (
			existing &&
			existing.revision === entry.revision &&
			blobIntact(deps.root, existing)
		) {
			report.verified.push(entry.id);
			continue;
		}
		try {
			let files: FileMeta[] | null = null;
			let origin: Origin | null = null;
			let lastErr: string | null = null;
			for (const o of deps.origins) {
				try {
					const listed = await o.listFiles(entry.repo, entry.revision);
					const picked = pickFiles(entry, listed);
					if (picked.length > 0) {
						files = picked;
						origin = o;
						break;
					}
					if (entry.runtime !== "gguf" && listed.length > 0) {
						files = listed;
						origin = o;
						break;
					}
					lastErr = `origin listed 0 usable files for ${entry.repo}@${entry.revision}`;
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
				}
			}
			if (!files || !origin)
				throw new Error(lastErr ?? "no origin had this artifact");
			const out: FileMeta[] = [];
			for (const f of files) {
				const res = await origin.fetchFile(entry.repo, entry.revision, f);
				if (!res.ok || !res.body)
					throw new Error(`fetch ${f.path}: HTTP ${res.status}`);
				const got = await ingestBlob(deps.root, res.body, f.sha256);
				out.push({
					path: f.path,
					size: got.size,
					sha256: got.sha256,
				});
				if (got.deduped)
					deps.log?.(`${entry.id}: ${f.path} already in store (deduped)`);
			}
			index.models[entry.id] = {
				id: entry.id,
				repo: entry.repo,
				revision: entry.revision,
				runtime: entry.runtime,
				...(entry.quant ? { quant: entry.quant } : {}),
				files: out,
			};
			saveIndex(deps.root, index);
			report.added.push(entry.id);
			deps.log?.(
				`${entry.id}: ${out.length} file(s) → ${entry.repo}@${entry.revision}`,
			);
		} catch (e) {
			report.failed.push({
				id: entry.id,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
	return report;
}
