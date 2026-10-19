// hooks/board/drop-files.ts — W858.8 orchestrator file attachments: bounded,
// private, expiring stores with resolvable Fleet references. Browser File
// objects carry no reusable local path — the BYTES ride the upload (never a
// path string), the board stores them 0600 under the governor cache, and the
// returned reference is an exact URL any lane (local or remote) can fetch
// until it expires.
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// limits — config-over-code via SUSPENDERS_DROP_* (machine-local env), read
// at call time so a deploy pins them without a restart contract.
const numEnv = (key: string, dflt: number): number => {
	const v = Number(process.env[key]);
	return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const dropLimits = () => ({
	maxFiles: Math.floor(numEnv("SUSPENDERS_DROP_MAX_FILES", 8)),
	maxBytes: Math.floor(numEnv("SUSPENDERS_DROP_MAX_BYTES", 4 * 1024 * 1024)),
	maxTotal: Math.floor(
		numEnv("SUSPENDERS_DROP_MAX_TOTAL", 4 * 8 * 1024 * 1024),
	),
	ttlMs: numEnv("SUSPENDERS_DROP_TTL_HOURS", 24) * 3_600_000,
});

// the storage root — env pin beats the HOME-derived governor cache (read at
// call time; the ?home= test convention pins per-suite isolation)
export const dropDir = (home = process.env.HOME ?? ""): string =>
	process.env.SUSPENDERS_DROP_DIR ?? `${home}/.cache/claude-governor/drop-files`;

// type limit: a bounded extension allowlist (docs/code/data + a few images).
// Deterministic, no mime sniffing — the stored type string rides the meta
// for the GET's content-type only.
const EXT_RE =
	/\.(md|txt|json|csv|tsv|yaml|yml|toml|xml|html|htm|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|sh|sql|log|ini|cfg|conf|svg|png|jpg|jpeg|gif|webp)$/i;

// 8 random bytes hex = 16 chars — the id is public, the 16-byte secret is
// the per-file credential (capability URL: the link IS the auth).
const ID_RE = /^[0-9a-f]{16}$/;
const metaPath = (id: string): string => join(dropDir(), `${id}.json`);
const binPath = (id: string): string => join(dropDir(), `${id}.bin`);

export interface DropMeta {
	id: string;
	secret: string;
	name: string;
	type: string;
	size: number;
	sha256: string;
	createdAt: number;
	expiresAt: number;
}

// strip any path decoration a client sends — basename only, bounded length
export function sanitizeDropName(name: string): string {
	const base = String(name ?? "")
		.replace(/\\/g, "/")
		.split("/")
		.pop();
	return (base || "file").slice(0, 120);
}

// validation errors name the broken rule; the route maps kind → status code
export function validateDrop(
	name: string,
	size: number,
	limits = dropLimits(),
): { ok: true } | { ok: false; error: string; kind: "size" | "type" | "name" } {
	if (!name || !EXT_RE.test(name))
		return {
			ok: false,
			kind: "type",
			error: `type not allowed (${EXT_RE.source.slice(3, -2)})`,
		};
	if (size > limits.maxBytes)
		return {
			ok: false,
			kind: "size",
			error: `larger than the ${limits.maxBytes}-byte per-file cap`,
		};
	if (size <= 0) return { ok: false, kind: "size", error: "empty file" };
	return { ok: true };
}

function ensureDir(): void {
	mkdirSync(dropDir(), { recursive: true, mode: 0o700 });
}

// store one upload: bytes to <id>.bin (0600), meta to <id>.json (0600 — the
// secret lives in the meta, the file MODE is what keeps it private)
export function storeDrop(input: {
	name: string;
	type: string;
	bytes: Uint8Array;
	ttlMs?: number;
}): { ok: true; meta: DropMeta } | { ok: false; error: string; kind: string } {
	const limits = dropLimits();
	const name = sanitizeDropName(input.name);
	const v = validateDrop(name, input.bytes.length, limits);
	if (!v.ok) return { ok: false, error: v.error, kind: v.kind };
	ensureDir();
	const now = Date.now();
	const meta: DropMeta = {
		id: randomBytes(8).toString("hex"),
		secret: randomBytes(16).toString("hex"),
		name,
		type: String(input.type || "application/octet-stream").slice(0, 120),
		size: input.bytes.length,
		sha256: createHash("sha256").update(input.bytes).digest("hex"),
		createdAt: now,
		expiresAt: now + (input.ttlMs ?? limits.ttlMs),
	};
	writeFileSync(binPath(meta.id), input.bytes);
	writeFileSync(metaPath(meta.id), `${JSON.stringify(meta, null, "\t")}\n`);
	chmodSync(binPath(meta.id), 0o600);
	chmodSync(metaPath(meta.id), 0o600);
	return { ok: true, meta };
}

const secretOk = (expected: string, presented: string): boolean => {
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
};

// capability check + expiry: secret mismatch and unknown id both answer
// "missing"; expired entries purge on touch and answer "expired" once.
export function resolveDrop(
	id: string,
	secret: string,
): { ok: true; meta: DropMeta } | { ok: false; reason: "missing" | "expired" } {
	if (!ID_RE.test(id)) return { ok: false, reason: "missing" };
	let meta: DropMeta;
	try {
		meta = JSON.parse(readFileSync(metaPath(id), "utf8")) as DropMeta;
	} catch {
		return { ok: false, reason: "missing" };
	}
	if (!secretOk(meta.secret, secret)) return { ok: false, reason: "missing" };
	if (Date.now() >= meta.expiresAt) {
		removeDrop(id);
		return { ok: false, reason: "expired" };
	}
	return { ok: true, meta };
}

// parse a returned reference URL back into (id, secret) and resolve it —
// the ONE way an inbound attachment ref is validated before it rides a prompt
export function resolveDropRef(
	ref: string,
): { ok: true; meta: DropMeta; url: string } | { ok: false; reason: string } {
	let u: URL;
	try {
		u = new URL(ref);
	} catch {
		return { ok: false, reason: "not a URL" };
	}
	const m = u.pathname.match(/\/api\/files\/([0-9a-f]{16})$/);
	const k = u.searchParams.get("k") ?? "";
	if (!m) return { ok: false, reason: "not an attachment ref" };
	const r = resolveDrop(m[1], k);
	if (!r.ok) return r;
	return { ok: true, meta: r.meta, url: ref };
}

// the goal append: one exact link per attachment, resolved fresh so the
// prompt never carries a dead reference (any dead ref fails the request)
export function composeGoalAttachments(
	goal: string,
	refs: string[],
): { ok: true; goal: string } | { ok: false; error: string } {
	const limits = dropLimits();
	const picked = refs.slice(0, limits.maxFiles);
	const lines: string[] = [];
	for (const ref of picked) {
		const r = resolveDropRef(ref);
		if (!r.ok)
			return {
				ok: false,
				error: `attachment not resolvable (${r.reason}): ${ref.slice(0, 120)}`,
			};
		lines.push(
			`- ${r.meta.name} (${r.meta.size} bytes, type ${r.meta.type}) — ${r.url}`,
		);
	}
	if (!lines.length) return { ok: true, goal };
	return {
		ok: true,
		goal: `${goal}\n\nATTACHED FILES (fetch these URLs for the content):\n${lines.join("\n")}`,
	};
}

export function readDrop(meta: DropMeta): Buffer {
	return readFileSync(binPath(meta.id));
}

// the exact link a lane (local or remote) fetches — derived from the
// request origin so the URL matches however the browser reached the board
export function dropUrl(origin: string, meta: DropMeta): string {
	return `${origin}/api/files/${meta.id}?k=${meta.secret}`;
}

// response-safe meta view: never carries the secret
export function publicMeta(meta: DropMeta): {
	id: string;
	name: string;
	type: string;
	size: number;
	sha256: string;
	createdAt: number;
	expiresAt: number;
} {
	const { id, name, type, size, sha256, createdAt, expiresAt } = meta;
	return { id, name, type, size, sha256, createdAt, expiresAt };
}

export function removeDrop(id: string): void {
	rmSync(metaPath(id), { force: true });
	rmSync(binPath(id), { force: true });
}

// lazy sweep — every upload purges expired entries first, so the store
// self-heals without a timer; returns the number purged
export function purgeExpiredDrops(now = Date.now()): number {
	const dir = dropDir();
	let n = 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const f of names) {
		if (!f.endsWith(".json")) continue;
		try {
			const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as DropMeta;
			if (now >= meta.expiresAt) {
				removeDrop(meta.id);
				n++;
			}
		} catch {
			// unreadable meta → orphaned bin will never resolve; drop the pair
			const id = f.slice(0, -5);
			if (ID_RE.test(id)) removeDrop(id);
			n++;
		}
	}
	return n;
}
