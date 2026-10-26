// test/w746-kv-tenant-isolation.test.ts — W746 tenant isolation: the KV
// ship face carries fleet packet-prefix bytes (0600 machine config content).
// When a ship token is configured, the namespace cannot be cross-read: pack
// GETs demand the bearer exactly like PUTs; without a token the loopback
// peer is the only reader. A wrong token reads zero bytes.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packKvpack, serveKv } from "../bin/kv-ship.ts";

const HOME = mkdtempSync(join(tmpdir(), "w746-kv-iso-"));
const MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit";
const SLUG = "mlx-community_Qwen3-4B-Instruct-2507-4bit";
const SHA = "d".repeat(64);

test.beforeAll(async () => {
	const dir = join(HOME, SLUG);
	mkdirSync(dir, { recursive: true });
	const cache = join(dir, `${SHA}.safetensors`);
	writeFileSync(cache, Buffer.alloc(32 * 1024, 9));
	writeFileSync(
		join(dir, `${SHA}.json`),
		JSON.stringify({
			version: 1,
			kind: "belt-kv-prefix",
			model: MODEL,
			idsSha: SHA,
			prefixSha: "0123456789abcdef",
			tokenCount: 4200,
			kvBits: 8,
			kvGroupSize: 64,
			quantizedKvStart: 0,
			mlxLmVersion: "0.31.3",
			cacheBytes: 32 * 1024,
			prefix: {
				capturedAt: 1,
				model: "claude-fable-5-1",
				tools: [],
				system: "You are lane W746.",
			},
			createdAt: "2026-10-18T00:00:00Z",
		}),
	);
	await packKvpack({
		metaPath: join(dir, `${SHA}.json`),
		cachePath: cache,
		outPath: join(HOME, "outbox", `${SLUG}-${SHA}.kvpack.gz`),
	});
});

test.afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test.describe("W746 KV namespace isolation", () => {
	test("configured token gates pack GETs — wrong token reads zero bytes @unit", async () => {
		const server = serveKv({ port: 0, home: HOME, token: "iso-tok" });
		const base = `http://127.0.0.1:${server.port}`;
		const wrong = await fetch(`${base}/kv/${SLUG}/${SHA.slice(0, 12)}`);
		expect(wrong.status).toBe(401);
		expect((await wrong.arrayBuffer()).byteLength).toBeLessThan(1024);
		const misused = await fetch(`${base}/kv/${SLUG}/${SHA.slice(0, 12)}`, {
			headers: { authorization: "Bearer wrong-peer-tok" },
		});
		expect(misused.status).toBe(401);
		expect((await misused.arrayBuffer()).byteLength).toBeLessThan(1024);
		const right = await fetch(`${base}/kv/${SLUG}/${SHA.slice(0, 12)}`, {
			headers: { authorization: "Bearer iso-tok" },
		});
		expect(right.status).toBe(200);
		expect((await right.arrayBuffer()).byteLength).toBeGreaterThan(0);
		server.stop(true);
	});

	test("no token configured → loopback GETs stay open (solo posture) @unit", async () => {
		const server = serveKv({ port: 0, home: HOME, token: "" });
		const base = `http://127.0.0.1:${server.port}`;
		const open = await fetch(`${base}/kv/${SLUG}/${SHA.slice(0, 12)}`);
		expect(open.status).toBe(200);
		server.stop(true);
	});
});
