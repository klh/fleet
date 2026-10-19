// ext-seal.ts — external known-set slice (W823): parse a byte-exact raw
// snapshot (ext-raw/), select a fixed-seed slice, seal it into tasks-ext/
// with answers + provenance. Same laws as tasks/: never edit, hash-verified
// manifest, "--n k takes the first k tasks". Contamination note lives in
// the sealed `note` and ext-raw/SOURCE.md — directional, never
// leaderboard-grade.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARENA_DIR, rng, sha, shuffle } from "./core.ts";

export const EXT_TASK_DIR = join(ARENA_DIR, "tasks-ext");
export const EXT_RAW = join(ARENA_DIR, "ext-raw", "frames-test.tsv");
export const EXT_SEED = "bench-arena-ext/2026-10-19";
export const EXT_GEN = "ext-seal-1";
export const EXT_N = 48;
export const EXT_RULE = "never edit; --n k takes the first k tasks";

export interface ExtSource {
	repo: string;
	revision: string;
	license: string;
	url: string;
	fetched: string;
	file: string;
	sha256: string;
}
export interface ExtTask {
	id: string;
	prompt: string;
	answer: string;
	reasoning: string;
	links: number;
}
export interface ExtTaskFile {
	kind: "ext";
	generator: string;
	seed: string;
	note: string;
	source: ExtSource;
	tasks: ExtTask[];
}
export interface ExtManifest {
	generator: string;
	seed: string;
	sealed_at: string;
	rule: string;
	raw: { file: string; sha256: string; bytes: number };
	note: string;
	files: Record<string, { n: number; bytes: number; sha256: string }>;
}

export const EXT_NOTE =
	"FRAMES slice (public since 2024-09, Apache-2.0): multi-hop search questions " +
	"with short verifiable answers — the GAIA/WebWalker class. Contaminated in " +
	"the wild: treat as directional signal next to seeded-defect recall, never " +
	"leaderboard-grade. GAIA/WebWalkerQA/SealQA are gate-walled and not " +
	"bundleable; see ext-raw/SOURCE.md.";

/** RFC4180 parser with a configurable delimiter (TSV here): quoted fields,
 *  doubled quotes, embedded newlines. */
export function parseDsv(src: string, delim = "\t"): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let f = "";
	let q = false;
	const push = () => {
		row.push(f);
		f = "";
	};
	const end = () => {
		push();
		if (row.length > 1 || (row[0] ?? "") !== "") rows.push(row);
		row = [];
	};
	for (let i = 0; i < src.length; i++) {
		const c = src[i] ?? "";
		if (q) {
			if (c === '"') {
				if (src[i + 1] === '"') {
					f += '"';
					i++;
				} else q = false;
			} else f += c;
		} else if (c === '"') q = true;
		else if (c === delim) push();
		else if (c === "\n") end();
		else if (c !== "\r") f += c;
	}
	if (f !== "" || row.length > 0) end();
	return rows;
}

const linkCols = (rec: Record<string, string>) => {
	let n = 0;
	for (const [k, v] of Object.entries(rec)) {
		if (!/^wikipedia_link_\d+\+?$/.test(k) || v === "") continue;
		n += k.endsWith("+") ? (v.match(/https?:\/\//g) ?? []).length : 1;
	}
	return n;
};

/** Raw FRAMES tsv → the full candidate pool (order = raw order). */
export function extPool(src: string): ExtTask[] {
	const rows = parseDsv(src);
	const head = rows[0] ?? [];
	const col = (name: string) => head.indexOf(name);
	const iP = col("Prompt");
	const iA = col("Answer");
	const iR = col("reasoning_types");
	if (iP < 0 || iA < 0)
		throw new Error("raw snapshot lacks Prompt/Answer columns");
	const out: ExtTask[] = [];
	for (const r of rows.slice(1)) {
		const prompt = (r[iP] ?? "").trim();
		const answer = (r[iA] ?? "").trim();
		if (!prompt || !answer) continue;
		const rec: Record<string, string> = {};
		head.forEach((h, i) => {
			rec[h] = r[i] ?? "";
		});
		out.push({
			id: `fr${out.length + 1}`,
			prompt,
			answer,
			reasoning: (r[iR] ?? "").trim() || "unknown",
			links: linkCols(rec),
		});
	}
	return out;
}

/** Fixed-seed slice: seeded shuffle of the pool, take the first n. */
export function extSlice(
	pool: ExtTask[],
	n: number,
	seed = EXT_SEED,
): ExtTask[] {
	return shuffle(rng(seed), pool).slice(0, n);
}

const ALREADY =
	"tasks-ext/ is already sealed. Re-sealing invalidates every prior " +
	"comparison; delete tasks-ext/ by hand if you really mean it.";

export function buildExtFile(pool: ExtTask[], source: ExtSource): ExtTaskFile {
	return {
		kind: "ext",
		generator: EXT_GEN,
		seed: EXT_SEED,
		note: EXT_NOTE,
		source,
		tasks: extSlice(pool, EXT_N),
	};
}

export function extManifestBody(raw: {
	file: string;
	sha256: string;
	bytes: number;
}): string {
	const m: ExtManifest = {
		generator: EXT_GEN,
		seed: EXT_SEED,
		sealed_at: new Date().toISOString(),
		rule: EXT_RULE,
		raw,
		note: EXT_NOTE,
		files: {
			"frames.json": {
				n: EXT_N,
				bytes: 0,
				sha256: "",
			},
		},
	};
	return `${JSON.stringify(m, null, 1)}\n`;
}

/** Seal tasks-ext/ from a raw snapshot (refuses to overwrite). */
export function extSealFrom(
	rawPath: string,
	dir = EXT_TASK_DIR,
	log = console.log,
): ExtManifest {
	if (existsSync(join(dir, "MANIFEST.json"))) throw new Error(ALREADY);
	const src = readFileSync(rawPath, "utf8");
	const source: ExtSource = {
		repo: "google/frames-benchmark",
		revision: "58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef",
		license: "apache-2.0",
		url: "https://huggingface.co/datasets/google/frames-benchmark/resolve/main/test.tsv",
		fetched: "2026-10-19",
		file: "ext-raw/frames-test.tsv",
		sha256: sha(src),
	};
	const body = `${JSON.stringify(buildExtFile(extPool(src), source), null, 1)}\n`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "frames.json"), body);
	const m = JSON.parse(extManifestBody(source)) as ExtManifest;
	m.files["frames.json"] = {
		n: (JSON.parse(body) as ExtTaskFile).tasks.length,
		bytes: body.length,
		sha256: sha(body),
	};
	m.raw = { file: source.file, sha256: source.sha256, bytes: src.length };
	const mb = `${JSON.stringify(m, null, 1)}\n`;
	writeFileSync(join(dir, "MANIFEST.json"), mb);
	log(
		`ext seal: ${m.files["frames.json"].n} tasks, raw sha ${source.sha256.slice(0, 16)}`,
	);
	return m;
}

export interface ExtCheck {
	ok: boolean;
	rows: string[];
	hash: string;
}
/** Verify the sealed slice AND the raw chain it was derived from. */
export function verifyExt(dir = EXT_TASK_DIR, rawPath = EXT_RAW): ExtCheck {
	const p = join(dir, "MANIFEST.json");
	if (!existsSync(p))
		return {
			ok: false,
			rows: ["MANIFEST.json missing — run --ext-seal-from"],
			hash: "",
		};
	const raw = readFileSync(p, "utf8");
	const m = JSON.parse(raw) as ExtManifest;
	const rows: string[] = [];
	let ok = true;
	const rawSha = existsSync(rawPath)
		? sha(readFileSync(rawPath, "utf8"))
		: "missing";
	const rawOk = rawSha === m.raw.sha256;
	ok &&= rawOk;
	rows.push(
		`| ${m.raw.file} | raw | — | ${(m.raw.bytes / 1024).toFixed(0)} KiB | \`${m.raw.sha256.slice(0, 16)}\` | ${rawOk ? "PASS" : "FAIL (hash mismatch)"} |`,
	);
	for (const [f, e] of Object.entries(m.files)) {
		const fp = join(dir, f);
		const h = existsSync(fp) ? sha(readFileSync(fp, "utf8")) : "missing";
		const good = h === e.sha256;
		ok &&= good;
		rows.push(
			`| ${f} | ext | ${e.n} | ${(e.bytes / 1024).toFixed(0)} KiB | \`${e.sha256.slice(0, 16)}\` | ${good ? "PASS" : "FAIL (hash mismatch)"} |`,
		);
	}
	return { ok, rows, hash: sha(raw).slice(0, 16) };
}

const cache = new Map<string, ExtTaskFile>();
export function loadExt(dir = EXT_TASK_DIR): ExtTaskFile {
	let tf = cache.get(dir);
	if (!tf) {
		tf = JSON.parse(
			readFileSync(join(dir, "frames.json"), "utf8"),
		) as ExtTaskFile;
		cache.set(dir, tf);
	}
	return tf;
}
