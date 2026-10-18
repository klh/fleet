// kv-ship.ts — W240 CacheGen-class LAN KV shipping between fleet Macs.
//
// CacheGen's premise: a KV cache computed once travels as compressed bytes
// far cheaper than recomputing the prefill on every consumer. On the fleet
// the quantized prefix cache (kv-prefix.ts, --kv-bits 8) packs into a
// self-describing KVPACK bundle — meta (model, token-id sha, kv params, the
// packet prefix itself) + cache bytes, gzipped — and moves over HTTP:
//
//   pack <model>                build <outbox>/<slug>-<sha>.kvpack.gz
//   serve [--port] [--host]     GET /kv (index) · GET /kv/<slug>[/<sha>]
//                               PUT /kv/<slug> (token) — loopback default
//   pull --from <url> --model   fetch + verify + install into the kv home
//   push --to <url> --model     pack + PUT the latest local cache
//
// The receiving side verifies before install: magic, meta schema, ids sha,
// byte caps. A peer without server-side ingestion still wins — the meta
// carries the prefix, so `kv-prefix.ts warm` replays it (the prefill
// becomes the peer's boot cost once, never per boot).
//
// Perimeter discipline: loopback by default; a non-loopback --host refuses
// to start without BELT_KV_SHIP_TOKEN set (config-over-code: the env NAME
// only lives here; PUT demands the bearer token, GET serves pack bytes on
// the fleet LAN). Caps: meta ≤ 1 MiB, cache ≤ 8 GiB — enforced on both
// pack (refuse) and PUT (413 mid-stream, no unbounded buffering).
import {
	copyFileSync,
	createReadStream,
	createWriteStream,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join as join2 } from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import {
	KV_SHIP_TOKEN_ENV,
	kvHome,
	kvPaths,
	latestKvMeta,
	type KvMeta,
	readKvMeta,
	resolveAliasModel,
	slug,
	newestMetaFile,
} from "./kv-prefix.ts";

export const KVPACK_MAGIC = "KVPK1\0";
const META_MAGIC_LEN = 6 + 4;
export const MAX_META_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CACHE_BYTES = 8 * 2 ** 30;

const shipToken = (): string => process.env[KV_SHIP_TOKEN_ENV] ?? "";

export interface PackResult {
	packPath: string;
	sha: string;
	cacheBytes: number;
	packBytes: number;
}

const headerFor = (meta: KvMeta): Buffer => {
	const metaBuf = Buffer.from(JSON.stringify(meta), "utf8");
	if (metaBuf.length > MAX_META_BYTES)
		throw new Error(`meta ${metaBuf.length}B exceeds ${MAX_META_BYTES}B cap`);
	const header = Buffer.alloc(META_MAGIC_LEN);
	header.write(KVPACK_MAGIC, 0, "utf8");
	header.writeUInt32LE(metaBuf.length, 6);
	return Buffer.concat([header, metaBuf]);
};

/** Stream cache → gzipped KVPACK (header+meta first, then cache bytes). */
export async function packKvpack(o: {
	metaPath: string;
	cachePath: string;
	outPath: string;
	maxCacheBytes?: number;
}): Promise<PackResult> {
	const meta = readKvMeta(o.metaPath);
	if (!meta) throw new Error(`bad meta: ${o.metaPath}`);
	const cap = o.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
	const cacheBytes = statSync(o.cachePath).size;
	if (cacheBytes > cap)
		throw new Error(`cache ${cacheBytes}B exceeds cap ${cap}B — refuse`);
	mkdirSync(o.outPath.slice(0, o.outPath.lastIndexOf("/")), {
		recursive: true,
	});
	const header = headerFor(meta);
	const out = createWriteStream(o.outPath, { mode: 0o600 });
	const gz = zlib.createGzip({ level: 6 });
	// W240 live finding: gz.pipe(out) + pipeline(rs, gz) + a second out.end()
	// let the process exit before out's final flush — a 537MiB pack landed
	// missing its gzip trailer. One pipeline owns every stream, close
	// included; resolving here means the file on disk is complete.
	await pipeline(
		(async function* () {
			yield header;
			for await (const chunk of createReadStream(o.cachePath)) yield chunk;
		})(),
		gz,
		out,
	);
	return {
		packPath: o.outPath,
		sha: meta.idsSha,
		cacheBytes,
		packBytes: statSync(o.outPath).size,
	};
}

/** Unpack a KVPACK with streaming caps: header+meta parsed before a single
 *  cache byte is written; meta schema + ids sha + size validated up front.
 *  Installs cache + boot copy + meta into the model's kv dir. */
export async function unpackKvpack(o: {
	packPath: string;
	home: string;
	maxCacheBytes?: number;
}): Promise<{ meta: KvMeta; paths: ReturnType<typeof kvPaths> }> {
	const cap = o.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
	const source = createReadStream(o.packPath).pipe(zlib.createGunzip());
	let header = Buffer.alloc(0);
	let metaLen = -1;
	let metaBuf = Buffer.alloc(0);
	let written = 0;
	let cachePath = "";
	let out = createWriteStream("/dev/null");
	try {
		for await (const chunk of source) {
			let buf = chunk as Buffer;
			while (buf.length > 0) {
				if (metaLen < 0) {
					const take = Math.min(META_MAGIC_LEN - header.length, buf.length);
					header = Buffer.concat([header, buf.subarray(0, take)]);
					buf = buf.subarray(take);
					if (header.length < META_MAGIC_LEN) continue;
					if (!header.subarray(0, 6).equals(Buffer.from(KVPACK_MAGIC, "utf8")))
						throw new Error("bad KVPACK magic");
					metaLen = header.readUInt32LE(6);
					if (metaLen > MAX_META_BYTES)
						throw new Error(`meta ${metaLen}B exceeds cap`);
					continue;
				}
				if (metaBuf.length < metaLen) {
					const take = Math.min(metaLen - metaBuf.length, buf.length);
					metaBuf = Buffer.concat([metaBuf, buf.subarray(0, take)]);
					buf = buf.subarray(take);
					if (metaBuf.length < metaLen) continue;
					const parsed: unknown = JSON.parse(metaBuf.toString("utf8"));
					const meta = ((): KvMeta => {
						if (
							!parsed ||
							typeof parsed !== "object" ||
							(parsed as KvMeta).kind !== "belt-kv-prefix"
						)
							throw new Error("bad pack meta (not a belt-kv-prefix doc)");
						return parsed as KvMeta;
					})();
					if (meta.idsSha.length !== 64 || !/^[0-9a-f]{64}$/.test(meta.idsSha))
						throw new Error("bad pack meta idsSha");
					const paths = kvPaths(meta.model, meta.idsSha, o.home);
					mkdirSync(paths.dir, { recursive: true });
					cachePath = paths.cache;
					out = createWriteStream(cachePath, { mode: 0o600 });
					continue;
				}
				if (written + buf.length > cap)
					throw new Error(`cache exceeds cap ${cap}B`);
				if (!cachePath) throw new Error("pack truncated: meta without cache");
				written += buf.length;
				if (!out.write(buf))
					await new Promise<void>((r) => out.once("drain", r));
				buf = Buffer.alloc(0);
			}
		}
	} catch (e) {
		out.destroy();
		throw e;
	}
	// Single awaited end — the same early-exit race as the pack side.
	await new Promise((both) => out.end(both));
	if (!cachePath) throw new Error("pack truncated: header without cache");
	const meta = JSON.parse(metaBuf.toString("utf8")) as KvMeta;
	const paths = kvPaths(meta.model, meta.idsSha, o.home);
	copyFileSync(cachePath, paths.boot);
	writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, {
		mode: 0o600,
	});
	return { meta, paths };
}

/** Latest pack for a slug in the outbox. */
export function latestPack(modelSlug: string, home = kvHome()): string | null {
	const dir = join2(home, "outbox");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	const hits = names
		.filter((n) => n.startsWith(`${modelSlug}-`) && n.endsWith(".kvpack.gz"))
		.sort();
	return hits.length > 0 ? join2(dir, hits[hits.length - 1]) : null;
}

export function packLatest(
	model: string,
	home = kvHome(),
	maxCacheBytes?: number,
): Promise<PackResult> {
	const found = latestKvMeta(model, home);
	if (!found)
		return Promise.reject(new Error(`no kv cache built for ${model}`));
	const slugDir = slug(model);
	return packKvpack({
		metaPath: found.paths.meta,
		cachePath: found.paths.cache,
		outPath: join2(home, "outbox", `${slugDir}-${found.meta.idsSha}.kvpack.gz`),
		maxCacheBytes,
	});
}

/** Flat listing of local kv caches (report verb + GET /kv index). */
export function kvIndex(home = kvHome()): Array<Record<string, unknown>> {
	const index: Array<Record<string, unknown>> = [];
	for (const d of listModelDirs(home)) {
		const meta = newestMetaFile(join2(home, d));
		if (!meta) continue;
		index.push({
			slug: d,
			model: meta.model,
			sha: meta.idsSha.slice(0, 12),
			tokens: meta.tokenCount,
			kvBits: meta.kvBits,
			mib: Number((meta.cacheBytes / 2 ** 20).toFixed(1)),
			built: meta.createdAt,
		});
	}
	return index;
}

export interface ShipVerdict {
	verdict: "pass" | "fail";
	why: string;
	sha?: string;
	ms: number;
}

const isLoopbackHost = (host: string): boolean =>
	["127.0.0.1", "::1", "localhost"].includes(host);

/** Bun.serve KV ship surface. Throws when a non-loopback host is requested
 *  with no ship token configured (perimeter: never serve prefix bytes
 *  unauthenticated on an explicit LAN bind). */
export function serveKv(o: {
	port?: number;
	host?: string;
	home?: string;
	token?: string;
	maxCacheBytes?: number;
}): ReturnType<typeof Bun.serve> {
	const host = o.host ?? "127.0.0.1";
	const token = o.token ?? shipToken();
	if (!isLoopbackHost(host) && token.length === 0)
		throw new Error(
			`refusing non-loopback KV ship on ${host} without ${KV_SHIP_TOKEN_ENV}`,
		);
	const home = o.home ?? kvHome();
	const cap = o.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
	return Bun.serve({
		port: o.port ?? 8919,
		hostname: host,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const parts = url.pathname.split("/").filter((p) => p.length > 0);
			if (req.method === "GET" && url.pathname === "/health")
				return Response.json({ ok: true, kind: "kv-ship" });
			if (parts[0] !== "kv") return new Response("kv-ship\n", { status: 404 });
			if (req.method === "GET" && parts.length === 1) {
				return Response.json(kvIndex(home));
			}
			if (req.method === "GET" && parts.length >= 2) {
				// W746 tenant isolation: when a ship token is configured, pack
				// bytes demand it — the PUT gate is not the only reader gate.
				// No token = loopback peer only (the solo posture, matching PUT).
				const auth = req.headers.get("authorization") ?? "";
				const expected = `Bearer ${token}`;
				if (token.length > 0 ? auth !== expected : !isLoopbackPeer(req))
					return new Response("unauthorized\n", { status: 401 });
				const target =
					parts.length >= 3
						? packForSlugSha(parts[1], parts[2], home)
						: latestPack(parts[1], home);
				if (!target) return new Response("no pack\n", { status: 404 });
				const f = Bun.file(target);
				return new Response(f, {
					headers: { "content-type": "application/gzip" },
				});
			}
			if (req.method === "PUT" && parts.length === 2) {
				const auth = req.headers.get("authorization") ?? "";
				const expected = `Bearer ${token}`;
				if (token.length > 0 ? auth !== expected : !isLoopbackPeer(req))
					return new Response("unauthorized\n", { status: 401 });
				const tmp = `${home}/.incoming-${Date.now()}.pack`;
				try {
					const n = await drainToFile(req, tmp, cap);
					if (n > cap) throw new Error("pack exceeds cap");
					const res = await unpackKvpack({
						packPath: tmp,
						home,
						maxCacheBytes: cap,
					});
					mkdirSync(join2(home, "outbox"), { recursive: true });
					const dest = join2(
						home,
						"outbox",
						`${slug(res.meta.model)}-${res.meta.idsSha}.kvpack.gz`,
					);
					renameSync(tmp, dest);
					return Response.json({
						ok: true,
						model: res.meta.model,
						sha: res.meta.idsSha.slice(0, 12),
						cacheBytes: res.meta.cacheBytes,
					});
				} catch (e) {
					rmQuiet(tmp);
					return Response.json(
						{ ok: false, error: String(e).slice(0, 200) },
						{ status: 400 },
					);
				}
			}
			return new Response("method not allowed\n", { status: 405 });
		},
	});
}

const listModelDirs = (home: string): string[] => {
	try {
		return readdirSync(home, { withFileTypes: true })
			.filter((d) => d.isDirectory() && d.name !== "outbox")
			.map((d) => d.name);
	} catch {
		return [];
	}
};

const packForSlugSha = (
	modelSlug: string,
	sha12: string,
	home: string,
): string | null => {
	const all = readdirSync(join2(home, "outbox"))
		.filter((n) => n.startsWith(`${modelSlug}-`) && n.endsWith(".kvpack.gz"))
		.sort();
	const hit = all.find((n) =>
		n.slice(modelSlug.length + 1, -11).startsWith(sha12),
	);
	return hit ? join2(home, "outbox", hit) : null;
};

const isLoopbackPeer = (req: Request): boolean => {
	const ip = req.headers.get("x-forwarded-for") ?? "";
	return ip === "" || ip.startsWith("127.") || ip === "::1";
};

const drainToFile = async (
	req: Request,
	path: string,
	cap: number,
): Promise<number> => {
	if (!req.body) return 0;
	const out = createWriteStream(path, { mode: 0o600 });
	let total = 0;
	const reader = req.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel();
			out.end();
			throw new Error(`upload exceeds cap ${cap}B`);
		}
		if (!out.write(Buffer.from(value)))
			await new Promise<void>((r) => out.once("drain", r));
	}
	await new Promise((resolve) => out.end(resolve));
	return total;
};

const rmQuiet = (path: string): void => {
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
};

/** Pull a pack from a peer and install it into the local kv home. */
export async function pullKv(o: {
	from: string;
	model: string;
	sha?: string;
	token?: string;
	home?: string;
	fetchImpl?: typeof fetch;
	maxCacheBytes?: number;
}): Promise<ShipVerdict> {
	const fetchImpl = o.fetchImpl ?? fetch;
	const home = o.home ?? kvHome();
	const t0 = Date.now();
	const url = o.sha
		? `${o.from}/kv/${slug(o.model)}/${o.sha}`
		: `${o.from}/kv/${slug(o.model)}`;
	const tmp = `${home}/.pull-${Date.now()}.pack`;
	mkdirSync(home, { recursive: true });
	try {
		const r = await fetchImpl(url, {
			headers:
				o.token && o.token.length > 0
					? { authorization: `Bearer ${o.token}` }
					: {},
			signal: AbortSignal.timeout(600_000),
		});
		if (r.status === 404)
			return {
				verdict: "fail",
				why: `peer has no pack: ${url}`,
				ms: Date.now() - t0,
			};
		if (!r.ok)
			return { verdict: "fail", why: `HTTP ${r.status}`, ms: Date.now() - t0 };
		const n = await drainToFile(
			{ body: r.body } as unknown as Request,
			tmp,
			o.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
		);
		const res = await unpackKvpack({
			packPath: tmp,
			home,
			maxCacheBytes: o.maxCacheBytes,
		});
		rmQuiet(tmp);
		return {
			verdict: "pass",
			why: `installed ${res.meta.model} ${res.meta.idsSha.slice(0, 12)} (${(n / 2 ** 20).toFixed(1)}MiB pack)`,
			sha: res.meta.idsSha,
			ms: Date.now() - t0,
		};
	} catch (e) {
		rmQuiet(tmp);
		return {
			verdict: "fail",
			why: String(e).slice(0, 160),
			ms: Date.now() - t0,
		};
	}
}

/** Pack the latest local cache and PUT it to a peer. */
export async function pushKv(o: {
	to: string;
	model: string;
	token?: string;
	home?: string;
	fetchImpl?: typeof fetch;
	maxCacheBytes?: number;
}): Promise<ShipVerdict> {
	const fetchImpl = o.fetchImpl ?? fetch;
	const home = o.home ?? kvHome();
	const t0 = Date.now();
	try {
		const packed = await packLatest(o.model, home, o.maxCacheBytes);
		const r = await fetchImpl(`${o.to}/kv/${slug(o.model)}`, {
			method: "PUT",
			headers: {
				"content-type": "application/gzip",
				authorization: `Bearer ${o.token ?? shipToken()}`,
			},
			body: Bun.file(packed.packPath),
			signal: AbortSignal.timeout(600_000),
		});
		const doc = (await r.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
		} | null;
		if (!r.ok || !doc?.ok)
			return {
				verdict: "fail",
				why: `HTTP ${r.status}${doc?.error ? `: ${doc.error}` : ""}`,
				ms: Date.now() - t0,
			};
		return {
			verdict: "pass",
			why: `pushed ${o.model} ${packed.sha.slice(0, 12)} (${(packed.packBytes / 2 ** 20).toFixed(1)}MiB pack)`,
			sha: packed.sha,
			ms: Date.now() - t0,
		};
	} catch (e) {
		return {
			verdict: "fail",
			why: String(e).slice(0, 160),
			ms: Date.now() - t0,
		};
	}
}

const usage = (): void => {
	console.log(
		[
			"usage: bun bin/kv-ship.ts <verb> [options]",
			"  pack  --model <alias|mlx-id> [--out <path>]          — bundle latest cache → outbox",
			"  serve [--port 8919] [--host 127.0.0.1] [--home <dir>] — GET /kv index + packs, PUT to install",
			"  pull  --from <url> --model <alias|mlx-id> [--sha <hex12>]",
			"  push  --to <url> --model <alias|mlx-id>",
			"  report [--home <dir>]                                — list local kv caches",
		].join("\n"),
	);
};

const flagValue = (argv: string[], flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const verb = argv[0];
	if (!verb || argv.includes("--help")) {
		usage();
		return verb ? 1 : 0;
	}
	switch (verb) {
		case "pack": {
			const raw = flagValue(argv, "--model");
			if (!raw) throw new Error("pack needs --model");
			const model = resolveAliasModel(raw);
			const packed = await packLatest(model);
			console.log(
				`packed ${model} ${packed.sha.slice(0, 12)} → ${packed.packPath} (${(packed.packBytes / 2 ** 20).toFixed(1)}MiB)`,
			);
			return 0;
		}
		case "serve": {
			const server = serveKv({
				port: Number(flagValue(argv, "--port")) || undefined,
				host: flagValue(argv, "--host"),
				home: flagValue(argv, "--home"),
			});
			console.log(
				`kv-ship serving on ${server.hostname}:${server.port} — GET /kv, PUT /kv/<slug>`,
			);
			return 0;
		}
		case "pull": {
			const from = flagValue(argv, "--from");
			const raw = flagValue(argv, "--model");
			if (!from || !raw) throw new Error("pull needs --from and --model");
			const v = await pullKv({
				from,
				model: resolveAliasModel(raw),
				sha: flagValue(argv, "--sha"),
				token: flagValue(argv, "--token"),
			});
			console.log(`pull ${v.verdict} — ${v.why}`);
			return v.verdict === "pass" ? 0 : 1;
		}
		case "push": {
			const to = flagValue(argv, "--to");
			const raw = flagValue(argv, "--model");
			if (!to || !raw) throw new Error("push needs --to and --model");
			const v = await pushKv({
				to,
				model: resolveAliasModel(raw),
				token: flagValue(argv, "--token"),
			});
			console.log(`push ${v.verdict} — ${v.why}`);
			return v.verdict === "pass" ? 0 : 1;
		}
		case "report": {
			console.log(JSON.stringify(kvIndex(kvHome()), null, 2));
			return 0;
		}
		default:
			usage();
			return 1;
	}
}

if (import.meta.main) process.exit(await main());
