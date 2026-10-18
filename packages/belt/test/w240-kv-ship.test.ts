// W240 — kv-ship tests: real gzip round-trips, a real loopback Bun.serve,
// injected fetchImpl for pull/push. No python, no models.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	packKvpack,
	pullKv,
	pushKv,
	serveKv,
	unpackKvpack,
} from "../bin/kv-ship.ts";
import { KV_SHIP_TOKEN_ENV, readKvMeta } from "../bin/kv-prefix.ts";

const HOME = mkdtempSync(join(tmpdir(), "fleet-kv-ship-"));
const MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit";
const SLUG = "mlx-community_Qwen3-4B-Instruct-2507-4bit";
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const PREFIX = {
	capturedAt: 1,
	model: "claude-fable-5-1",
	tools: [] as unknown[],
	system: "You are lane W240.",
};

const metaDoc = (idsSha: string, cacheBytes: number) => ({
	version: 1,
	kind: "belt-kv-prefix",
	model: MODEL,
	idsSha,
	prefixSha: "0123456789abcdef",
	tokenCount: 9000,
	kvBits: 8,
	kvGroupSize: 64,
	quantizedKvStart: 0,
	mlxLmVersion: "0.31.3",
	cacheBytes,
	prefix: PREFIX,
	createdAt: "2026-10-11T00:00:00Z",
});

const SHA = "c".repeat(64);
let PACK = "";

beforeAll(async () => {
	const dir = join(HOME, SLUG);
	mkdirSync(dir, { recursive: true });
	const cache = join(dir, `${SHA}.safetensors`);
	writeFileSync(cache, Buffer.alloc(64 * 1024, 7));
	writeFileSync(
		join(dir, `${SHA}.json`),
		JSON.stringify(metaDoc(SHA, 64 * 1024)),
	);
	const packed = await packKvpack({
		metaPath: join(dir, `${SHA}.json`),
		cachePath: cache,
		outPath: join(HOME, "outbox", `${SLUG}-${SHA}.kvpack.gz`),
	});
	PACK = packed.packPath;
});

test("pack→unpack round-trip preserves meta and cache bytes", async () => {
	const other = mkdtempSync(join(tmpdir(), "fleet-kv-ship-in-"));
	try {
		const res = await unpackKvpack({ packPath: PACK, home: other });
		expect(res.meta.model).toBe(MODEL);
		expect(res.meta.idsSha).toBe(SHA);
		const installed = `${other}/${SLUG}/${SHA}.safetensors`;
		expect(statSync(installed).size).toBe(64 * 1024);
		const boot = `${other}/${SLUG}/${SHA}.boot.safetensors`;
		expect(statSync(boot).size).toBe(64 * 1024);
		expect(readKvMeta(`${other}/${SLUG}/${SHA}.json`)?.tokenCount).toBe(9000);
	} finally {
		rmSync(other, { recursive: true, force: true });
	}
});

test("unpack rejects bad magic and truncated packs", async () => {
	const bad = join(HOME, "bad.kvpack.gz");
	await Bun.write(bad, Bun.gzipSync(Buffer.alloc(256, 1)));
	await expect(unpackKvpack({ packPath: bad, home: HOME })).rejects.toThrow(
		"bad KVPACK magic",
	);
	const trunc = join(HOME, "trunc.kvpack.gz");
	const all = Buffer.from(await Bun.file(PACK).arrayBuffer());
	await Bun.write(trunc, all.subarray(0, 8));
	await expect(unpackKvpack({ packPath: trunc, home: HOME })).rejects.toThrow();
});

test("pack refuses caches past the byte cap", async () => {
	await expect(
		packKvpack({
			metaPath: join(HOME, SLUG, `${SHA}.json`),
			cachePath: join(HOME, SLUG, `${SHA}.safetensors`),
			outPath: join(HOME, "outbox", "capped.kvpack.gz"),
			maxCacheBytes: 1024,
		}),
	).rejects.toThrow("exceeds cap");
});

test("serveKv: health, index, GET pack, PUT installs with token", async () => {
	process.env[KV_SHIP_TOKEN_ENV] = "sekrit";
	const server = serveKv({ port: 0, home: HOME });
	const base = `http://127.0.0.1:${server.port}`;
	const health = await fetch(`${base}/health`);
	expect(health.ok).toBe(true);
	const index = (await (await fetch(`${base}/kv`)).json()) as Array<{
		slug: string;
	}>;
	expect(index.map((r) => r.slug)).toContain(SLUG);
	const got = await fetch(`${base}/kv/${SLUG}/${SHA.slice(0, 12)}`, {
		// W746: pack bytes are token-gated once a ship token is configured
		headers: { authorization: "Bearer sekrit" },
	});
	expect(got.ok).toBe(true);
	const localBytes = new Uint8Array(await Bun.file(PACK).arrayBuffer());
	const gotBytes = new Uint8Array(await got.arrayBuffer());
	expect(gotBytes.length).toBe(localBytes.length);
	expect(Buffer.from(gotBytes).equals(Buffer.from(localBytes))).toBe(true);
	const noAuth = await fetch(`${base}/kv/${SLUG}`, {
		method: "PUT",
		body: "x",
	});
	expect(noAuth.status).toBe(401);
	server.stop(true);
	delete process.env[KV_SHIP_TOKEN_ENV];
});

test("serveKv PUT installs a valid pack end-to-end", async () => {
	const other = mkdtempSync(join(tmpdir(), "fleet-kv-ship-put-"));
	process.env[KV_SHIP_TOKEN_ENV] = "sekrit";
	const server = serveKv({ port: 0, home: other });
	const base = `http://127.0.0.1:${server.port}`;
	const res = await fetch(`${base}/kv/${SLUG}`, {
		method: "PUT",
		headers: { authorization: "Bearer sekrit" },
		body: Bun.file(PACK),
	});
	expect(res.ok).toBe(true);
	const doc = (await res.json()) as { ok?: boolean; sha?: string };
	expect(doc.ok).toBe(true);
	expect(doc.sha).toBe(SHA.slice(0, 12));
	const idx = (await (await fetch(`${base}/kv`)).json()) as Array<{
		slug: string;
	}>;
	expect(idx.map((r) => r.slug)).toContain(SLUG);
	server.stop(true);
	delete process.env[KV_SHIP_TOKEN_ENV];
	rmSync(other, { recursive: true, force: true });
});

test("non-loopback bind without a token refuses to start", () => {
	expect(() =>
		serveKv({ port: 0, host: "0.0.0.0", home: HOME, token: "" }),
	).toThrow(KV_SHIP_TOKEN_ENV);
});

test("pullKv installs from a peer; 404 fails cleanly", async () => {
	const other = mkdtempSync(join(tmpdir(), "fleet-kv-ship-pull-"));
	try {
		const packBytes = await Bun.file(PACK).arrayBuffer();
		const ok404 = await pullKv({
			from: "http://peer.test",
			model: MODEL,
			home: other,
			fetchImpl: (async () =>
				new Response("no pack", { status: 404 })) as typeof fetch,
		});
		expect(ok404.verdict).toBe("fail");
		const good = await pullKv({
			from: "http://peer.test",
			model: MODEL,
			home: other,
			fetchImpl: (async () =>
				new Response(packBytes, {
					headers: { "content-type": "application/gzip" },
				})) as typeof fetch,
		});
		expect(good.verdict).toBe("pass");
		expect(statSync(join(other, SLUG, `${SHA}.safetensors`)).size).toBe(
			64 * 1024,
		);
	} finally {
		rmSync(other, { recursive: true, force: true });
	}
});

test("pushKv packs and PUTs the latest cache", async () => {
	let seenAuth = "";
	let seenBytes = 0;
	const v = await pushKv({
		to: "http://peer.test",
		model: MODEL,
		home: HOME,
		token: "tok",
		fetchImpl: (async (_url: RequestInfo, init?: RequestInit) => {
			seenAuth = String(new Headers(init?.headers).get("authorization"));
			const body = init?.body as unknown as {
				size?: number;
				arrayBuffer?: () => Promise<ArrayBuffer>;
			};
			seenBytes = body?.size ?? (await body?.arrayBuffer())?.byteLength ?? 0;
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch,
	});
	expect(v.verdict).toBe("pass");
	expect(seenAuth).toBe("Bearer tok");
	expect(seenBytes).toBeGreaterThan(0);
});
