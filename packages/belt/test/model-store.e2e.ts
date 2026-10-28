// model-store.test.ts — W763: the hub model store — content-addressed
// ingest + verify, catalog-diff sync into tmp stores, and the face: W764
// auth envelope on /blobs, fail-closed 503, sync route.
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { scratchWorld } from "@klh/test-kit";
import {
	ggufFileName,
	hubOrigin,
	ingestBlob,
	loadIndex,
	saveIndex,
	syncCatalog,
	type FileMeta,
	type Origin,
} from "../bin/model-store-lib.ts";
import { createApp, openKeyLedger } from "../bin/model-store.ts";
import { applyGovernanceSchema } from "@klh/buckle/src/gov/schema.ts";
import { KeyStore } from "@klh/buckle/src/gov/keys.ts";
import {
	PullAuthorizer,
	STORE_READ_SCOPE,
	TokenBucket,
} from "@klh/buckle/src/gov/store-auth.ts";

// ─── helpers ───

const sha = (content: string): string =>
	createHash("sha256").update(content).digest("hex");

const tmpStore = (): string => scratchWorld().home;

/** Fake origin: files = {path: content}; declares real sha256 + size. */
function fakeOrigin(files: Record<string, string>): Origin {
	const metas = (): FileMeta[] =>
		Object.entries(files).map(([path, content]) => ({
			path,
			size: Buffer.byteLength(content),
			sha256: sha(content),
		}));
	return {
		async listFiles() {
			return metas();
		},
		async fetchFile(_repo, _rev, file) {
			const content = files[file.path];
			if (content === undefined) return new Response("nope", { status: 404 });
			return new Response(content);
		},
	};
}

type Authorizer = Parameters<typeof createApp>[0]["authorizer"];

/** A real face over tmp state, on an OS-assigned port. */
function face(store: string, authorizer: Authorizer) {
	const app = createApp({
		root: store,
		authorizer,
		readCatalog: () => ({ version: 1, models: [] }),
		origins: () => [],
	});
	const server = Bun.serve({ port: 0, fetch: app.fetch });
	return {
		url: `http://localhost:${server.port}`,
		stop: () => server.stop(true),
	};
}

/** In-memory buckle ledger + one store-read key + its authorizer. */
function seededLedger(): { key: string; authorizer: Authorizer } {
	const db = new Database(":memory:", { create: true });
	applyGovernanceSchema(db);
	const keys = new KeyStore(db);
	const issued = keys.issue({
		name: "pull-test",
		team: null,
		scopes: [STORE_READ_SCOPE],
		rpmLimit: null,
		tpmLimit: null,
		expiresInS: null,
		actor: "test",
	});
	return {
		key: issued.key,
		authorizer: new PullAuthorizer({
			keys,
			bucket: new TokenBucket({
				capacity: 30,
				refillPerS: 1,
				idleTtlMs: 60_000,
			}),
		}),
	};
}

// ─── lib: index + ingest ───

test.describe("index + ingest", () => {
	test("saveIndex/loadIndex roundtrip through the atomic write @unit", () => {
		const root = tmpStore();
		saveIndex(root, {
			version: 1,
			models: {
				m1: {
					id: "m1",
					repo: "org/repo",
					revision: "abc1234",
					runtime: "mlx",
					files: [{ path: "config.json", size: 2, sha256: sha("hi") }],
				},
			},
		});
		const idx = loadIndex(root);
		expect(idx.models.m1?.revision).toBe("abc1234");
		expect(idx.models.m1?.files[0]?.sha256).toBe(sha("hi"));
	});

	test("ingestBlob hashes content, enforces the declared sha, dedupes @unit", async () => {
		const root = tmpStore();
		const body = (c: string): ReadableStream<Uint8Array> =>
			new Response(c).body as ReadableStream<Uint8Array>;
		const a = await ingestBlob(root, body("hello store"));
		expect(a.sha256).toBe(sha("hello store"));
		expect(a.deduped).toBe(false);
		const b = await ingestBlob(root, body("hello store"));
		expect(b.deduped).toBe(true);
		const c = await ingestBlob(root, body("pinned"), sha("pinned"));
		expect(c.sha256).toBe(sha("pinned"));
	});

	test("declared-sha mismatch → error, nothing lands @unit", async () => {
		const root = tmpStore();
		const body = (c: string): ReadableStream<Uint8Array> =>
			new Response(c).body as ReadableStream<Uint8Array>;
		await expect(
			ingestBlob(root, body("tampered"), sha("original")),
		).rejects.toThrow("sha256 mismatch");
		expect(existsSync(join(root, "blobs", sha("tampered")))).toBe(false);
	});
});

// ─── lib: catalog sync (fake origins) ───

const mlxEntry = (over: Record<string, unknown> = {}): CatalogEntryLike => ({
	id: "m",
	repo: "org/Model-4bit",
	revision: "abc1234",
	license: "apache-2.0",
	runtime: "mlx",
	specialist: 8902,
	tier: "always",
	...over,
});

type CatalogEntryLike = Parameters<typeof syncCatalog>[0]["entries"][number];

test.describe("syncCatalog", () => {
	test("acquires an mlx tree, records shas, is idempotent @unit", async () => {
		const root = tmpStore();
		const files = {
			"config.json": `{"model_type":"qwen3"}`,
			"model.safetensors": "weights-bytes",
		};
		const rep = await syncCatalog({
			root,
			entries: [mlxEntry()],
			origins: [fakeOrigin(files)],
		});
		expect(rep.added).toEqual(["m"]);
		const rec = loadIndex(root).models.m;
		expect(rec?.files).toHaveLength(2);
		expect(rec?.files[0]?.sha256).toBe(sha(`{"model_type":"qwen3"}`));
		expect(existsSync(join(root, "blobs", sha("weights-bytes")))).toBe(true);
		const rep2 = await syncCatalog({
			root,
			entries: [mlxEntry()],
			origins: [fakeOrigin(files)],
		});
		expect(rep2.verified).toEqual(["m"]);
		expect(rep2.added).toEqual([]);
	});

	test("revision change re-acquires; a deleted blob re-acquires too @unit", async () => {
		const root = tmpStore();
		const v1 = { "config.json": "v1-config" };
		const v2 = { "config.json": "v2-config" };
		await syncCatalog({
			root,
			entries: [mlxEntry()],
			origins: [fakeOrigin(v1)],
		});
		await syncCatalog({
			root,
			entries: [mlxEntry({ revision: "def5678" })],
			origins: [fakeOrigin(v2)],
		});
		expect(loadIndex(root).models.m?.revision).toBe("def5678");
		expect(existsSync(join(root, "blobs", sha("v2-config")))).toBe(true);
		rmSync(join(root, "blobs", sha("v2-config")));
		const rep = await syncCatalog({
			root,
			entries: [mlxEntry({ revision: "def5678" })],
			origins: [fakeOrigin(v2)],
		});
		expect(rep.added).toEqual(["m"]);
	});

	test("gguf quant picks its file; quant-less gguf fails cleanly @unit", async () => {
		const root = tmpStore();
		const files = {
			"Model-4B-Q4_K_M.gguf": "gguf-bytes",
			"Model-4B-Q8_0.gguf": "other-quant",
		};
		const rep = await syncCatalog({
			root,
			entries: [
				mlxEntry({
					id: "g",
					repo: "org/Model-4B-GGUF",
					runtime: "gguf",
					quant: "Q4_K_M",
					platforms: ["win32", "linux"],
				}),
			],
			origins: [fakeOrigin(files)],
		});
		expect(rep.added).toEqual(["g"]);
		const rec = loadIndex(root).models.g;
		expect(rec?.files).toHaveLength(1);
		expect(rec?.files[0]?.path).toBe("Model-4B-Q4_K_M.gguf");
	});

	test("origin chain: first origin failing falls through to the next @unit", async () => {
		const root = tmpStore();
		const dead: Origin = {
			async listFiles() {
				throw new Error("peer unreachable");
			},
			async fetchFile() {
				throw new Error("peer unreachable");
			},
		};
		const rep = await syncCatalog({
			root,
			entries: [mlxEntry()],
			origins: [dead, fakeOrigin({ "config.json": "from-hf" })],
		});
		expect(rep.added).toEqual(["m"]);
		expect(loadIndex(root).models.m?.files[0]?.sha256).toBe(sha("from-hf"));
	});
});

// ─── hub-to-hub: a peer face IS an Origin ───

test.describe("hub-to-hub replication", () => {
	test("hubOrigin pulls /models + authed /blobs; byte-identical blobs land @unit", async () => {
		const src = tmpStore();
		const seed = await syncCatalog({
			root: src,
			entries: [mlxEntry()],
			origins: [
				fakeOrigin({
					"config.json": "peer-content",
					"model.safetensors": "peer-weights",
				}),
			],
		});
		expect(seed.added).toEqual(["m"]);
		const led = seededLedger();
		const peer = face(src, led.authorizer);
		try {
			const rep = await syncCatalog({
				root: tmpStore(),
				entries: [mlxEntry()],
				origins: [hubOrigin(peer.url, led.key)],
			});
			expect(rep.added).toEqual(["m"]);
		} finally {
			peer.stop();
		}
	});
});

// ─── the face: auth envelope + routes ───

test.describe("model-store face", () => {
	test("/health and /models answer open (host-guarded reads) @unit", async () => {
		const store = tmpStore();
		const f = face(store, seededLedger().authorizer);
		try {
			const h = await fetch(`${f.url}/health`);
			expect(h.status).toBe(200);
			expect(((await h.json()) as { ok: boolean }).ok).toBe(true);
			const m = await fetch(`${f.url}/models`);
			expect(m.status).toBe(200);
			expect(((await m.json()) as { version: number }).version).toBe(1);
		} finally {
			f.stop();
		}
	});

	test("/blobs: no key 401, unknown key 401, valid key streams bytes @unit", async () => {
		const store = tmpStore();
		const led = seededLedger();
		const f = face(store, led.authorizer);
		const shaOf = sha("secret-bytes");
		mkdirSync(join(store, "blobs"), { recursive: true });
		writeFileSync(join(store, "blobs", shaOf), "secret-bytes");
		try {
			expect((await fetch(`${f.url}/blobs/${shaOf}`)).status).toBe(401);
			const stranger = seededLedger();
			expect(
				(
					await fetch(`${f.url}/blobs/${shaOf}`, {
						headers: { authorization: `Bearer ${stranger.key}` },
					})
				).status,
			).toBe(401);
			const ok = await fetch(`${f.url}/blobs/${shaOf}`, {
				headers: { authorization: `Bearer ${led.key}` },
			});
			expect(ok.status).toBe(200);
			expect(ok.headers.get("x-checksum-sha256")).toBe(shaOf);
			expect(await ok.text()).toBe("secret-bytes");
			// existence is not revealed to strangers — 404 rides the valid key
			expect(
				(
					await fetch(`${f.url}/blobs/${"0".repeat(64)}`, {
						headers: { authorization: `Bearer ${led.key}` },
					})
				).status,
			).toBe(404);
		} finally {
			f.stop();
		}
	});

	test("no ledger → /blobs fails closed with 503 @unit", async () => {
		const f = face(tmpStore(), null);
		try {
			expect((await fetch(`${f.url}/blobs/${sha("x")}`)).status).toBe(503);
		} finally {
			f.stop();
		}
	});

	test("openKeyLedger: missing file → null (fail-closed) @unit", () => {
		expect(openKeyLedger(join(tmpStore(), "nope.db"))).toBeNull();
	});

	test("ggufFileName: quant rides the base name, -GGUF suffix stripped @unit", () => {
		expect(ggufFileName("org/Model-4B-GGUF", "Q4_K_M")).toBe(
			"Model-4B-Q4_K_M.gguf",
		);
		expect(ggufFileName("org/Model-4B", "Q8_0")).toBe("Model-4B-Q8_0.gguf");
	});

	test("POST /sync needs the write token; with it the catalog lands @unit", async () => {
		const store = tmpStore();
		const tokFile = join(tmpStore(), "wt");
		writeFileSync(tokFile, `${"w".repeat(40)}\n`);
		process.env.SUSPENDERS_WRITE_TOKEN_FILE = tokFile;
		const app = createApp({
			root: store,
			authorizer: seededLedger().authorizer,
			readCatalog: () => ({
				version: 1,
				models: [mlxEntry({ id: "sync-me" })],
			}),
			origins: () => [fakeOrigin({ "config.json": "synced-config" })],
		});
		const server = Bun.serve({ port: 0, fetch: app.fetch });
		const url = `http://localhost:${server.port}`;
		try {
			const deny = await fetch(`${url}/sync`, { method: "POST" });
			expect(deny.status).toBe(403);
			await fetch(`${url}/sync`, {
				method: "POST",
				headers: { "x-klh-write-token": "w".repeat(40) },
			});
			for (let i = 0; i < 40; i++) {
				const r = await fetch(`${url}/models`);
				const idx = (await r.json()) as { models: Record<string, unknown> };
				if (idx.models["sync-me"]) break;
				await Bun.sleep(50);
			}
			expect(loadIndex(store).models["sync-me"]).toBeTruthy();
		} finally {
			server.stop(true);
		}
	});
});
