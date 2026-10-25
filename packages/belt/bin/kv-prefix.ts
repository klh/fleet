// kv-prefix.ts — W240 persistent packet-prefix KV for the self-hosted swarm.
//
// The fleet's stable packet prefix (harness preamble + AGENTS.md as tools +
// system blocks — the W623 capture shape) is re-prefilled at cache-write
// rates on every specialist cold boot: the W500 reaper, tier swaps and model
// revivals all start from an empty LRU. The installed mlx_lm 0.31.3 server
// keeps its prompt cache in RAM only (LRUPromptCache with token-trie
// fetch_nearest_cache — no cache-file ingestion), so this module covers the
// whole lifecycle:
//
//   build   render the prefix the way the server renders chat requests
//           (apply_chat_template with tools, tokenize=True) and prefill a
//           quantized KV cache with cache_prompt's own flags (--kv-bits,
//           --kv-group-size, --quantized-kv-start), saving it in the
//           cache_prompt --prompt-cache-file format (save_prompt_cache) plus
//           a sidecar meta. Identity = sha256 over the rendered token-id
//           JSON — never the prompt text (prompt-fingerprint law).
//   warm    replay the prefix through a live specialist's OpenAI endpoint
//           (max_tokens 1, nonce user turn) — the ingestion path that works
//           TODAY: the server's token trie matches the rendered prefix and
//           hands later requests their KV without re-prefill.
//   probe   record which cache flags the installed mlx_lm server actually
//           declares (its --help) to <kvHome>/server-flags.json;
//           spawnArgs reads that file — sync, no subprocess on the spawn
//           path. On 0.31.3 the probe is empty so the wiring no-ops; when
//           upstream ships --prompt-cache-file the same code lights up.
//   ship    kv-ship.ts packs meta+cache into a self-describing KVPACK and
//           moves it between fleet Macs over HTTP.
//
// Boot-copy rule: the canonical <sha>.safetensors is never handed to the
// server directly — servers that DO accept a cache file also SAVE back into
// it after requests; the server gets <sha>.boot.safetensors so the shipped
// artifact stays prefix-pure. build/pull write both.
//
// Evidence discipline: python runs via argument arrays (never a shell), the
// interpreter path is env-overridable for tests, and every spawn seam takes
// an injected exec so unit tests never load a model.
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SPECIALISTS } from "./registry.ts";

/** The captured stable prefix (prefix-keepwarm.ts capture shape). */
export interface PacketPrefix {
	capturedAt: number;
	model: string;
	tools: unknown[];
	system: unknown;
}

const isPacketPrefix = (v: unknown): v is PacketPrefix => {
	if (!v || typeof v !== "object") return false;
	const p = v as Partial<PacketPrefix>;
	return (
		typeof p.model === "string" &&
		p.model.length > 0 &&
		typeof p.capturedAt === "number" &&
		Array.isArray(p.tools) &&
		p.system !== undefined
	);
};

/** Read + validate the W623 capture file; null when absent/corrupt. */
export function loadPacketPrefix(path: string): PacketPrefix | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isPacketPrefix(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export const runtimeHome = (): string =>
	process.env.LOCAL_LLM_HOME ?? join(homedir(), ".claude", "local-llm");

export const kvHome = (): string =>
	process.env.LOCAL_LLM_KV_HOME ?? join(runtimeHome(), "kv");

/** Env name only — the token itself lives in machine config (config-over-code). */
export const KV_SHIP_TOKEN_ENV = "BELT_KV_SHIP_TOKEN";

export const mlxPython = (): string =>
	process.env.BELT_MLX_PYTHON ??
	`${homedir()}/.local/share/uv/tools/mlx-lm/bin/python`;

export const kvProbePath = (): string =>
	process.env.BELT_KV_PROBE ?? join(kvHome(), "server-flags.json");

export const slug = (model: string): string => model.split("/").join("_");

export const kvPaths = (
	model: string,
	sha: string,
	home = kvHome(),
): { dir: string; cache: string; boot: string; meta: string } => {
	const dir = join(home, slug(model));
	return {
		dir,
		cache: join(dir, `${sha}.safetensors`),
		boot: join(dir, `${sha}.boot.safetensors`),
		meta: join(dir, `${sha}.json`),
	};
};

/** Flatten the wire-shape system (string or content-block array) exactly the
 *  way the server's process_message_content does before templating. */
export function systemText(system: unknown): string {
	if (typeof system === "string") return system;
	if (Array.isArray(system))
		return system
			.filter(
				(b): b is { type?: string; text?: string } =>
					!!b && typeof b === "object",
			)
			.map((b) => (typeof b.text === "string" ? b.text : ""))
			.filter((t) => t.length > 0)
			.join("\n");
	return "";
}

/** Stable identity of a prefix: sha256 over canonical JSON of model+tools+
 *  system, 16 hex — the fingerprint rides logs and URLs, text never does. */
export function prefixSha(prefix: PacketPrefix): string {
	return createHash("sha256")
		.update(
			JSON.stringify({ m: prefix.model, t: prefix.tools, s: prefix.system }),
		)
		.digest("hex")
		.slice(0, 16);
}

// ─── python: render + prefill (mirror cache_prompt.py's own flow) ───────────

// Tokenizer-only render — mirrors the server's chat path: tools pass into
// apply_chat_template, content flattened, tokenize=True.
const PY_RENDER = `import json,sys,hashlib
from transformers import AutoTokenizer
cfg=json.loads(sys.stdin.read())
tok=AutoTokenizer.from_pretrained(cfg["model"],trust_remote_code=True)
s=cfg["system"]
content=s if isinstance(s,str) else "\\n".join(b.get("text","") for b in s if isinstance(b,dict) and b.get("type")=="text")
raw=tok.apply_chat_template([{"role":"system","content":content}],tools=(cfg["tools"] or None),add_generation_prompt=False,tokenize=True)
ids=[int(t) for t in (raw if isinstance(raw,(list,tuple)) else raw["input_ids"])]
print(json.dumps({"tokenCount":len(ids),"idsSha":hashlib.sha256(json.dumps(ids).encode()).hexdigest()}))`;

// Model load + prefill + save — mirrors mlx_lm cache_prompt main(): token
// ids through generate_step(max_tokens=0) with kv quantization, then
// save_prompt_cache (the --prompt-cache-file format). The ids sha rides the
// cache metadata so a pack can be checked against the prefix it claims.
const PY_PREFILL = `import json,sys,hashlib,time,os,importlib.metadata as im
import mlx.core as mx
from transformers import AutoTokenizer
from mlx_lm.utils import load
from mlx_lm.generate import generate_step
from mlx_lm.models.cache import make_prompt_cache, save_prompt_cache
cfg=json.loads(sys.stdin.read())
tok=AutoTokenizer.from_pretrained(cfg["model"],trust_remote_code=True)
s=cfg["system"]
content=s if isinstance(s,str) else "\\n".join(b.get("text","") for b in s if isinstance(b,dict) and b.get("type")=="text")
raw=tok.apply_chat_template([{"role":"system","content":content}],tools=(cfg["tools"] or None),add_generation_prompt=False,tokenize=True)
ids=[int(t) for t in (raw if isinstance(raw,(list,tuple)) else raw["input_ids"])]
ids_sha=hashlib.sha256(json.dumps(ids).encode()).hexdigest()
model,_=load(cfg["model"],tokenizer_config={"trust_remote_code":True})
cache=make_prompt_cache(model,None)
t0=time.time()
for _ in generate_step(mx.array(ids),model,max_tokens=0,prompt_cache=cache,kv_bits=cfg["kvBits"],kv_group_size=cfg["kvGroupSize"],quantized_kv_start=cfg["quantizedKvStart"]):
    pass
ver=im.version("mlx-lm")
save_prompt_cache(cfg["out"],cache,{"model":cfg["model"],"ids_sha":ids_sha,"belt_kv":"1","mlx_lm_version":ver})
print(json.dumps({"tokenCount":len(ids),"idsSha":ids_sha,"seconds":round(time.time()-t0,1),"mlxLmVersion":ver,"cacheBytes":os.path.getsize(cfg["out"])}))`;

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Exec seam — tests inject a fake; the default spawns the real interpreter
 *  with argument arrays and pipes stdin/stdout/stderr. */
export type Exec = (argv: string[], input: string) => Promise<ExecResult>;

export const defaultExec: Exec = async (argv, input) => {
	const proc = Bun.spawn(argv, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(input);
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
};

const runPy = async (
	code: string,
	cfg: unknown,
	exec: Exec,
	label: string,
): Promise<Record<string, unknown>> => {
	const r = await exec([mlxPython(), "-c", code], JSON.stringify(cfg));
	if (r.exitCode !== 0)
		throw new Error(
			`${label} failed (exit ${r.exitCode}): ${r.stderr.slice(-2000)}`,
		);
	try {
		const last = r.stdout.trim().split("\n").pop() ?? "";
		return JSON.parse(last) as Record<string, unknown>;
	} catch {
		throw new Error(
			`${label}: no JSON summary on stdout: ${r.stdout.slice(-200)}`,
		);
	}
};

// ─── meta ────────────────────────────────────────────────────────────────────

export interface KvMeta {
	version: 1;
	kind: "belt-kv-prefix";
	model: string;
	/** sha256 over the rendered token-id JSON (the prefill identity). */
	idsSha: string;
	/** prefixSha — the capture identity this cache was built from. */
	prefixSha: string;
	tokenCount: number;
	kvBits: number;
	kvGroupSize: number;
	quantizedKvStart: number;
	mlxLmVersion: string;
	cacheBytes: number;
	/** The prefix itself rides the meta so a peer can warm-replay without
	 *  the source capture file. Text stays inside 0600 machine config. */
	prefix: PacketPrefix;
	createdAt: string;
}

const isKvMeta = (v: unknown): v is KvMeta => {
	if (!v || typeof v !== "object") return false;
	const m = v as Partial<KvMeta>;
	return (
		m.version === 1 &&
		m.kind === "belt-kv-prefix" &&
		typeof m.model === "string" &&
		typeof m.idsSha === "string" &&
		typeof m.prefixSha === "string" &&
		typeof m.tokenCount === "number" &&
		isPacketPrefix(m.prefix as unknown)
	);
};

export const readKvMeta = (path: string): KvMeta | null => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isKvMeta(parsed) ? parsed : null;
	} catch {
		return null;
	}
};

/** Newest valid meta file in one model dir (readdir order is not time order —
 *  take max createdAt). Null when the dir is absent or holds no valid meta. */
export function newestMetaFile(dir: string): KvMeta | null {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	let best: KvMeta | null = null;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const meta = readKvMeta(join(dir, name));
		if (!meta) continue;
		if (!best || meta.createdAt > best.createdAt) best = meta;
	}
	return best;
}

/** Newest valid meta for a model, or null: scans the model's dir, keeps
 *  only metas whose model field matches (a dir can hold another model's
 *  stale meta), takes max createdAt. */
export function latestKvMeta(
	model: string,
	home = kvHome(),
): { meta: KvMeta; paths: ReturnType<typeof kvPaths> } | null {
	const dir = join(home, slug(model));
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	let best: { meta: KvMeta; paths: ReturnType<typeof kvPaths> } | null = null;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const meta = readKvMeta(join(dir, name));
		if (!meta || meta.model !== model) continue;
		if (!best || meta.createdAt > best.meta.createdAt)
			best = { meta, paths: kvPaths(model, meta.idsSha, home) };
	}
	return best;
}

// ─── build ───────────────────────────────────────────────────────────────────

export interface BuildResult {
	meta: KvMeta;
	paths: ReturnType<typeof kvPaths>;
	render: Record<string, unknown>;
	prefill: Record<string, unknown>;
}

/** Build the persistent packet-prefix KV for one model: render (tokenizer
 *  only) → prefill (model load, --kv-bits quantized) → meta + boot copy.
 *  Cross-check: the two python steps must agree on the rendered token ids,
 *  else the build is refused (a cache that does not match its claimed
 *  tokens would poison the server's trie with WRONG KV). */
export async function buildPacket(
	o: {
		model: string;
		prefix: PacketPrefix;
		kvBits?: number;
		kvGroupSize?: number;
		quantizedKvStart?: number;
		home?: string;
	},
	exec: Exec = defaultExec,
): Promise<BuildResult> {
	const kvBits = o.kvBits ?? 8;
	const kvGroupSize = o.kvGroupSize ?? 64;
	const quantizedKvStart = o.quantizedKvStart ?? 0;
	const home = o.home ?? kvHome();
	const psha = prefixSha(o.prefix);
	const renderCfg = {
		model: o.model,
		system: o.prefix.system,
		tools: o.prefix.tools,
	};
	const render = await runPy(PY_RENDER, renderCfg, exec, "kv render");
	const idsSha = render.idsSha;
	if (typeof idsSha !== "string" || idsSha.length !== 64)
		throw new Error(`kv render: bad idsSha: ${JSON.stringify(render)}`);
	const paths = kvPaths(o.model, idsSha, home);
	mkdirSync(paths.dir, { recursive: true });
	const prefill = await runPy(
		PY_PREFILL,
		{ ...renderCfg, out: paths.cache, kvBits, kvGroupSize, quantizedKvStart },
		exec,
		"kv prefill",
	);
	if (prefill.idsSha !== idsSha)
		throw new Error(
			`kv prefill rendered different tokens (${String(prefill.idsSha)}) than render (${idsSha}) — refusing to save a mismatched cache`,
		);
	const cacheBytes = Number(prefill.cacheBytes);
	if (!Number.isFinite(cacheBytes) || !existsSync(paths.cache))
		throw new Error("kv prefill: cache file missing after save");
	copyFileSync(paths.cache, paths.boot);
	const meta: KvMeta = {
		version: 1,
		kind: "belt-kv-prefix",
		model: o.model,
		idsSha,
		prefixSha: psha,
		tokenCount: Number(render.tokenCount) || 0,
		kvBits,
		kvGroupSize,
		quantizedKvStart,
		mlxLmVersion: String(prefill.mlxLmVersion ?? "unknown"),
		cacheBytes,
		prefix: o.prefix,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, {
		mode: 0o600,
	});
	return { meta, paths, render, prefill };
}

/** Verify a built cache against its meta and the source prefix: files exist,
 *  sizes agree, cache metadata ids_sha matches, and the capture has not
 *  drifted (prefixSha equality — a stale capture must not ship). */
export function verifyPacket(
	o: { prefix?: PacketPrefix; home?: string },
	model: string,
): { verdict: "pass" | "fail"; why: string; meta?: KvMeta } {
	const found = latestKvMeta(model, o.home);
	if (!found) return { verdict: "fail", why: `no kv meta for ${model}` };
	const { meta, paths } = found;
	if (!existsSync(paths.cache))
		return { verdict: "fail", why: `cache file missing: ${paths.cache}` };
	const bytes = statSync(paths.cache).size;
	if (bytes !== meta.cacheBytes)
		return {
			verdict: "fail",
			why: `cache size drift: ${bytes} vs meta ${meta.cacheBytes}`,
			meta,
		};
	if (o.prefix && prefixSha(o.prefix) !== meta.prefixSha)
		return {
			verdict: "fail",
			why: `prefix drift: capture sha ${prefixSha(o.prefix)} vs built ${meta.prefixSha} — rebuild`,
			meta,
		};
	return {
		verdict: "pass",
		why: `${meta.tokenCount} tokens, kv${meta.kvBits}`,
		meta,
	};
}

// ─── probe: what the installed mlx_lm server can ingest ─────────────────────

export interface ServerFlagsProbe {
	probedAt: string;
	mlxLmVersion?: string;
	flags: { promptCacheFile?: boolean; kvBits?: boolean };
}

const parseHelp = (help: string): ServerFlagsProbe["flags"] => ({
	promptCacheFile: /--prompt-cache-file\b/.test(help),
	kvBits: /--kv-bits\b/.test(help),
});

/** Parse `mlx_lm server --help` output into the probe doc. */
export const probeFromHelp = (
	help: string,
	version?: string,
): ServerFlagsProbe => ({
	probedAt: new Date().toISOString(),
	mlxLmVersion: version,
	flags: parseHelp(help),
});

export const readProbe = (path = kvProbePath()): ServerFlagsProbe | null => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as { probedAt?: unknown }).probedAt === "string" &&
			(parsed as { flags?: unknown }).flags
		)
			return parsed as ServerFlagsProbe;
		return null;
	} catch {
		return null;
	}
};

/** mlx_lm.server argv suffix for a model with a built cache — appended by
 *  spawnArgs ONLY when the probe file says the installed server declares the
 *  flag. Boot copy, never the canonical cache. [] on any absence. */
export function serverKvArgs(
	model: string,
	home = kvHome(),
	probe: ServerFlagsProbe | null = readProbe(),
): string[] {
	if (!probe) return [];
	const found = latestKvMeta(model, home);
	if (!found) return [];
	const argv: string[] = [];
	if (probe.flags.promptCacheFile)
		argv.push("--prompt-cache-file", found.paths.boot);
	if (probe.flags.kvBits)
		argv.push(
			"--kv-bits",
			String(found.meta.kvBits),
			"--kv-group-size",
			String(found.meta.kvGroupSize),
		);
	return argv;
}

/** Refresh the probe doc from the real server --help. */
export async function probeServer(
	exec: Exec = defaultExec,
): Promise<ServerFlagsProbe> {
	const r = await exec([mlxPython(), "-m", "mlx_lm", "server", "--help"], "");
	if (r.exitCode !== 0 && !/--prompt-cache/.test(r.stdout + r.stderr))
		throw new Error(`mlx_lm server --help failed (exit ${r.exitCode})`);
	const probe = probeFromHelp(`${r.stdout}\n${r.stderr}`);
	mkdirSync(kvHome(), { recursive: true });
	writeFileSync(kvProbePath(), `${JSON.stringify(probe, null, 2)}\n`, {
		mode: 0o600,
	});
	return probe;
}

// ─── warm: the ingestion path that works today ───────────────────────────────

export interface WarmResult {
	port: number;
	verdict: "pass" | "fail" | "skipped";
	why: string;
	ms: number;
	promptTokens?: number;
}

/** The warm request: prefix system + ONE nonce user turn (the nonce keeps a
 *  response cache from answering; only the shared prefix matches the trie).
 *  Tools are OFF by default: local OpenAI specialists reject harness tool
 *  names (>64 chars) and real local traffic shares the SYSTEM prefix, not
 *  the tool dump — pass withTools for a capture-parity replay. */
export const warmOpenaiBody = (
	prefix: PacketPrefix,
	nonce: number,
	model?: string,
	withTools = false,
): Record<string, unknown> => ({
	model: model ?? prefix.model,
	max_tokens: 1,
	stream: false,
	tools: withTools && prefix.tools.length > 0 ? prefix.tools : undefined,
	messages: [
		{ role: "system", content: systemText(prefix.system) },
		{ role: "user", content: `warm ${nonce}` },
	],
});

/** Warm one live specialist through its OpenAI endpoint. Never spawns: only
 *  ports that already answer get warmed (loading a 22GB model to prefill a
 *  prefix nobody asked for is the W500 class, not this). */
export async function warmSpecialist(o: {
	port: number;
	model: string;
	prefix: PacketPrefix;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<WarmResult> {
	const fetchImpl = o.fetchImpl ?? fetch;
	const t0 = Date.now();
	try {
		const r = await fetchImpl(
			`http://localhost:${o.port}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(warmOpenaiBody(o.prefix, Date.now(), o.model)),
				signal: AbortSignal.timeout(o.timeoutMs ?? 300_000),
			},
		);
		const ms = Date.now() - t0;
		if (!r.ok)
			return { port: o.port, verdict: "fail", why: `HTTP ${r.status}`, ms };
		const doc = (await r.json().catch(() => null)) as {
			usage?: { prompt_tokens?: number };
		} | null;
		return {
			port: o.port,
			verdict: "pass",
			why: "prefix replayed",
			ms,
			promptTokens: doc?.usage?.prompt_tokens,
		};
	} catch (e) {
		return {
			port: o.port,
			verdict: "fail",
			why: `unreachable: ${String(e).slice(0, 120)}`,
			ms: Date.now() - t0,
		};
	}
}

/** Warm every UP specialist from one capture (default) — model id per port
 *  comes from the registry, so the body carries the served model id. */
export async function warmAll(
	o: { prefix: PacketPrefix; ports?: number[] },
	fetchImpl?: typeof fetch,
): Promise<WarmResult[]> {
	const ports = o.ports ?? SPECIALISTS.map((s) => s.port);
	const results = await Promise.all(
		ports.map(async (port) => {
			const s = SPECIALISTS.find((x) => x.port === port);
			if (!s)
				return {
					port,
					verdict: "skipped",
					why: "not in registry",
					ms: 0,
				} as WarmResult;
			return warmSpecialist({
				port,
				model: s.model,
				prefix: o.prefix,
				fetchImpl,
			});
		}),
	);
	return results;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

/** Registry alias | port | exact model id → the served mlx model id. */
export const resolveAliasModel = (name: string): string => {
	const hit = SPECIALISTS.find(
		(s) => s.alias === name || String(s.port) === name || s.model === name,
	);
	return hit?.model ?? name;
};

const usage = (): void => {
	console.log(
		[
			"usage: bun bin/kv-prefix.ts <verb> [options]",
			"  build --model <alias|mlx-id> [--prefix <path>] [--kv-bits 8] [--kv-group-size 64] [--quantized-kv-start 0]",
			"  warm  [--port <n>...] [--prefix <path>]        — replay the prefix through UP specialists (never spawns)",
			"  probe                                          — record the installed server's cache flags",
			"  flags --model <alias|mlx-id>                   — the spawnArgs suffix (from the probe file)",
			"  verify --model <alias|mlx-id> [--prefix <path>]",
			"  report                                         — list built caches",
		].join("\n"),
	);
};

const flagValue = (argv: string[], flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};

const DEFAULT_PREFIX_PATH = (): string =>
	process.env.PREFIX_CACHE_PATH ?? join(runtimeHome(), "prefix-cache.json");

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const verb = argv[0];
	if (!verb || argv.includes("--help")) {
		usage();
		return verb ? 1 : 0;
	}
	const prefixPath = flagValue(argv, "--prefix") ?? DEFAULT_PREFIX_PATH();
	switch (verb) {
		case "build": {
			const raw = flagValue(argv, "--model");
			if (!raw) throw new Error("build needs --model");
			const prefix = loadPacketPrefix(prefixPath);
			if (!prefix)
				throw new Error(
					`no captured packet prefix at ${prefixPath} — run suspenders hooks/bin/prefix-keepwarm.ts --capture first`,
				);
			const out = await buildPacket({
				model: resolveAliasModel(raw),
				prefix,
				kvBits: Number(flagValue(argv, "--kv-bits")) || undefined,
				kvGroupSize: Number(flagValue(argv, "--kv-group-size")) || undefined,
				quantizedKvStart:
					Number(flagValue(argv, "--quantized-kv-start")) || undefined,
			});
			console.log(
				`built ${out.meta.model} ${out.meta.idsSha.slice(0, 12)} ${out.meta.tokenCount} tokens kv${out.meta.kvBits} ${(out.meta.cacheBytes / 2 ** 20).toFixed(1)}MiB in ${String(out.prefill.seconds ?? "?")}s → ${out.paths.cache}`,
			);
			return 0;
		}
		case "warm": {
			const prefix = loadPacketPrefix(prefixPath);
			if (!prefix) throw new Error(`no captured prefix at ${prefixPath}`);
			const ports = argv
				.flatMap((a, i) => (a === "--port" ? [Number(argv[i + 1])] : []))
				.filter((n) => Number.isFinite(n));
			const results = await warmAll({ prefix, ports });
			for (const w of results)
				console.log(
					`  :${w.port} ${w.verdict} ${w.ms}ms ${w.why}${w.promptTokens ? ` (${w.promptTokens} prompt tokens)` : ""}`,
				);
			return results.some((w) => w.verdict === "pass") ? 0 : 1;
		}
		case "probe": {
			const probe = await probeServer();
			console.log(
				`probed mlx_lm ${probe.mlxLmVersion ?? "?"}: prompt-cache-file=${probe.flags.promptCacheFile} kv-bits=${probe.flags.kvBits} → ${kvProbePath()}`,
			);
			return 0;
		}
		case "flags": {
			const raw = flagValue(argv, "--model");
			if (!raw) throw new Error("flags needs --model");
			console.log(JSON.stringify(serverKvArgs(resolveAliasModel(raw))));
			return 0;
		}
		case "verify": {
			const raw = flagValue(argv, "--model");
			if (!raw) throw new Error("verify needs --model");
			const v = verifyPacket(
				{ prefix: loadPacketPrefix(prefixPath) ?? undefined },
				resolveAliasModel(raw),
			);
			console.log(`verify ${raw}: ${v.verdict} — ${v.why}`);
			return v.verdict === "pass" ? 0 : 1;
		}
		case "report": {
			const home = kvHome();
			let dirs: string[];
			try {
				dirs = readdirSync(home, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name);
			} catch {
				console.log("no kv home yet");
				return 0;
			}
			for (const d of dirs) {
				const model = d.split("_").join("/");
				const found = latestKvMeta(model, home);
				if (!found) continue;
				console.log(
					`  ${model}: ${found.meta.tokenCount} tokens kv${found.meta.kvBits} ${(found.meta.cacheBytes / 2 ** 20).toFixed(1)}MiB, built ${found.meta.createdAt}`,
				);
			}
			return 0;
		}
		default:
			usage();
			return 1;
	}
}

if (import.meta.main) process.exit(await main());
