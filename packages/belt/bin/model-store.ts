// model-store.ts — W763: the hub model store's HTTP face + CLI. The core
// (model-store-lib.ts) holds content-addressed blobs; this face serves them:
//
//   GET  /health        → { ok, models, blobs }        (host-guarded read)
//   GET  /models        → the store index              (host-guarded read)
//   GET  /blobs/<sha>   → the bytes                    (bksk_ store-read key)
//   POST /sync          → catalog sync verb            (install write token)
//   GET  /status /metrics ride servicemon (probe sidecar targets /status)
//
// Dev-pull auth rides W764's PullAuthorizer seam — a bksk_ bearer verified
// against the hub's buckle key ledger (the ONE key authority; the face opens
// the shared buckle.db — WAL multi-process, busy_timeout — and gates on
// buckle:store:READ_, per-key fairness bucket). Fail-closed: no ledger, no
// pulls (503). Hub-to-hub replication needs no new surface — the peer's
// /models + /blobs ARE an Origin (model-store-lib.ts hubOrigin).
//
// run:   bun belt/bin/model-store.ts [serve] | sync [--from <url>]
// knobs: MODEL_STORE_ROOT (default ~/.claude/local-llm/model-store)
//        MODEL_STORE_PORT (7797) · MODEL_STORE_BIND (127.0.0.1)
//        BUCKLE_DB (key ledger; REQUIRED for pulls — fail-closed 503)
//        MODEL_STORE_PEER_URL + MODEL_STORE_PEER_TOKEN (replication source)
//        MODEL_STORE_HF_TOKEN (gated repos; public repos need none)
//        MODEL_STORE_SYNC_ON_BOOT (1 → serve syncs the catalog pre-listen)
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { KeyStore } from "../../buckle/src/gov/keys.ts";
import {
	PullAuthorizer,
	TokenBucket,
} from "../../buckle/src/gov/store-auth.ts";
import { loadCatalog } from "../../local-llm/models.catalog.ts";
import {
	hostGuard,
	writeToken,
} from "../../suspenders/hooks/lib/host-guard.ts";
import { servicemon } from "../../suspenders/hooks/lib/servicemon.ts";
import {
	hfOrigin,
	hubOrigin,
	loadIndex,
	type Origin,
	type SyncReport,
	syncCatalog,
} from "./model-store-lib.ts";

// ─── knobs (config-over-code: env names here, values in machine config) ───

export const ROOT =
	process.env.MODEL_STORE_ROOT ??
	join(process.env.HOME ?? "", ".claude", "local-llm", "model-store");
export const PORT = Number(process.env.MODEL_STORE_PORT ?? "") || 7797;
export const BIND = process.env.MODEL_STORE_BIND ?? "127.0.0.1";

// pull fairness: per-KEY bucket from W764 — one dev draining their budget
// never starves another (capacity 30 concurrent-ish takes, 1/s sustained).
const BUCKET = new TokenBucket({
	capacity: 30,
	refillPerS: 1,
	idleTtlMs: 600_000,
});

/** Fail-closed key ledger: opens the hub's buckle.db READ-ONLY-intent —
 *  never creates it (the buckle gate owns schema + minting; a store face
 *  that mints nothing opens what exists or serves nothing). */
export function openKeyLedger(path: string): KeyStore | null {
	try {
		const db = new Database(path);
		db.exec("PRAGMA busy_timeout = 5000");
		return new KeyStore(db);
	} catch {
		return null;
	}
}

export interface AppDeps {
	root: string;
	authorizer: PullAuthorizer | null;
	/** Catalog source — injectable so tests never read the machine catalog. */
	readCatalog: () => ReturnType<typeof loadCatalog>;
	/** Origins for POST /sync (first usable wins). Default: peer first, HF. */
	origins?: () => Origin[];
	/** Replication token used to pull FROM a peer. */
	peerToken?: string;
}

// ─── routes ───

const SHA_RE = /^[0-9a-f]{64}$/;

/** Serve one content-addressed blob. Sha is validated by the caller. */
function serveBlob(root: string, sha: string): Response {
	let size = 0;
	try {
		size = statSync(join(root, "blobs", sha)).size;
	} catch {
		return Response.json({ error: "no such blob" }, { status: 404 });
	}
	const body = Bun.file(join(root, "blobs", sha));
	return new Response(body, {
		headers: {
			"content-length": String(size),
			"content-type": "application/octet-stream",
			"x-checksum-sha256": sha,
		},
	});
}

/** Blob count for /health — files under blobs/ (bounded: name-filtered). */
function countBlobs(root: string): number {
	try {
		return [...new Bun.Glob("*").scanSync({ cwd: join(root, "blobs") })].filter(
			(n) => /^[0-9a-f]{64}$/.test(n),
		).length;
	} catch {
		return 0;
	}
}

// ─── sync verb ───

/** Default origin chain: the peer hub FIRST (owned links beat origin
 *  egress), then the public origin. No peer configured → HF only. */
function defaultOrigins(deps: AppDeps): Origin[] {
	const chain: Origin[] = [];
	if (process.env.MODEL_STORE_PEER_URL)
		chain.push(hubOrigin(process.env.MODEL_STORE_PEER_URL, deps.peerToken));
	chain.push(hfOrigin({ token: process.env.MODEL_STORE_HF_TOKEN }));
	return chain;
}

/** One sync pass: diff loadCatalog() vs the store, acquire from the chain.
 *  Returns the full report (the /sync route fires it fire-and-forget; the
 *  CLI awaits it). */
export async function runSync(
	deps: AppDeps,
	origins?: Origin[],
): Promise<SyncReport> {
	return syncCatalog({
		root: deps.root,
		entries: deps.readCatalog().models,
		origins: origins ?? deps.origins?.() ?? defaultOrigins(deps),
		log: (m) => console.error(`model-store: ${m}`),
	});
}

// ─── serve + CLI ───

function makeDeps(): AppDeps {
	const keys = openKeyLedger(
		process.env.BUCKLE_DB ??
			join(process.env.HOME ?? "", ".claude", "local-llm", "buckle.db"),
	);
	return {
		root: ROOT,
		authorizer: keys ? new PullAuthorizer({ keys, bucket: BUCKET }) : null,
		readCatalog: loadCatalog,
		peerToken: process.env.MODEL_STORE_PEER_TOKEN,
	};
}

/** The hub face: auth wiring + servicemon observability. Exported so the
 *  compose service and tests share one constructor. */
export function buildServer(): { stop: () => void; port: number } {
	const sm = servicemon({ service: "model-store", port: PORT });
	const server = Bun.serve(
		sm.wrapped({
			port: PORT,
			hostname: BIND,
			fetch: createApp(makeDeps()).fetch,
		}),
	);
	return {
		port: server.port,
		stop: () => server.stop(true),
	};
}

/** CLI entry. `sync` = one-shot catalog sync — exits 0 when every catalog
 *  entry landed or verified, 1 on any failure (compose/cron can gate on it).
 *  `serve` (default) runs the face; sync-on-boot knob pre-warms the store. */
export async function main(argv: string[]): Promise<number> {
	const cmd = argv[0] ?? "serve";
	if (cmd === "sync") {
		const from = argv[argv.indexOf("--from") + 1] ?? "";
		const chain = from
			? [hubOrigin(from, process.env.MODEL_STORE_PEER_TOKEN)]
			: undefined;
		const report = await runSync(makeDeps(), chain);
		console.error(
			`model-store sync: ${report.added.length} added, ${report.verified.length} verified, ${report.failed.length} failed`,
		);
		for (const f of report.failed)
			console.error(`  FAILED ${f.id}: ${f.error}`);
		return report.failed.length === 0 ? 0 : 1;
	}
	// serve (default): ensure the write-token file, sync-on-boot knob, face.
	writeToken();
	if (process.env.MODEL_STORE_SYNC_ON_BOOT === "1") void runSync(makeDeps());
	const server = buildServer();
	console.error(`model-store on ${BIND}:${server.port} (root ${ROOT})`);
	await new Promise(() => {}); // serve runs until signalled
	return 0;
}

if (import.meta.main) {
	const code = await main(process.argv.slice(2));
	if (code !== 0) process.exit(code);
}

/** The route table. /blobs = W764 auth + byte stream; /sync single-flights
 *  (a POST while one runs answers 409, never a racing index write). */
export function createApp(deps: AppDeps): {
	fetch: (req: Request) => Promise<Response>;
} {
	let syncing: Promise<unknown> | null = null;
	const handler = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const path = url.pathname;
		// host allowlist gates EVERY route (DNS-rebind defense, W264);
		// writes additionally need the install write token
		const denied = hostGuard(req, {
			bind: BIND,
			write: req.method === "POST",
		});
		if (denied) return denied;
		if (path === "/health") {
			const index = loadIndex(deps.root);
			return Response.json({
				ok: true,
				models: Object.keys(index.models).length,
				blobs: countBlobs(deps.root),
			});
		}
		if (path === "/models") {
			return Response.json(loadIndex(deps.root));
		}
		if (path.startsWith("/blobs/")) {
			const sha = path.slice("/blobs/".length);
			if (!SHA_RE.test(sha))
				return Response.json({ error: "malformed sha256" }, { status: 400 });
			// fail-closed: no ledger → no pulls (503 before any auth math)
			if (!deps.authorizer)
				return Response.json(
					{ error: "key ledger unavailable — pulls disabled" },
					{ status: 503 },
				);
			const v = deps.authorizer.authorize(req.headers);
			if (!v.ok) {
				const h: Record<string, string> = {};
				if (v.retryAfterS !== null && v.retryAfterS !== undefined)
					h["retry-after"] = String(v.retryAfterS);
				return Response.json(
					{ error: v.why, code: v.code },
					{ status: v.status, headers: h },
				);
			}
			return serveBlob(deps.root, sha);
		}
		if (path === "/sync" && req.method === "POST") {
			if (syncing)
				return Response.json(
					{ error: "sync already running" },
					{ status: 409 },
				);
			syncing = runSync(deps)
				.finally(() => {
					syncing = null;
				})
				.catch(() => {});
			return Response.json({ started: true });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	};
	return { fetch: handler };
}
