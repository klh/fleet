// registry.ts — SINGLE SOURCE OF TRUTH for the local-llm swarm.
// swarm.ts (lifecycle) and router-shim.ts (routing) both import this.
// Port↔model pairs exist ONLY here. Change a model here; both tools follow.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── per-platform serving runtime (W765) ───
// The qvac platformDefinitions pattern: ONE table maps platform → the
// backend that serves the fleet there. Registry rows carry a runtime attr
// (default derived from the platform) and the spawner derives argv from it.
export type Platform = "darwin" | "win32" | "linux";
export type RuntimeBackend = "mlx" | "llama.cpp";

export interface PlatformDefinition {
	runtime: RuntimeBackend;
	accel: "metal" | "vulkan" | "cpu";
}

// darwin = MLX (metal); win32/linux = llama.cpp on GGUF (vulkan/cpu)
export const platformDefinitions: Record<Platform, PlatformDefinition> = {
	darwin: { runtime: "mlx", accel: "metal" },
	win32: { runtime: "llama.cpp", accel: "vulkan" },
	linux: { runtime: "llama.cpp", accel: "cpu" },
};

export const thisPlatform = (): Platform =>
	process.platform === "darwin"
		? "darwin"
		: process.platform === "win32"
			? "win32"
			: "linux";

/** Row override wins; otherwise the platform table decides. */
export const runtimeFor = (
	s: Pick<Specialist, "runtime">,
	platform: Platform = thisPlatform(),
): RuntimeBackend => s.runtime ?? platformDefinitions[platform].runtime;

export interface Specialist {
	port: SPECIALIST_PORTS;
	// mlx rows: exact mlx-community id — mlx_lm validates it.
	// llama.cpp rows: local GGUF file path (acquisition binds repo+quant in
	// the model catalog; see local-llm/models.catalog.ts)
	model: string;
	/** Chat checkpoint required by rapid-mlx when this row serves embeddings. */
	serveModel?: string;
	label: string; // display + routing role
	// belt-facing gateway alias (litellm model_name, buckle group, direct
	// tier key) — emitters derive every downstream config from this
	alias: string;
	role: "code" | "extract" | "reason" | "embed" | "rerank" | "general";
	ram_gb: number; // reconciled with benchmarks.md (the canonical table)
	// max tokens the model is served for (native window of the weights) —
	// route on measured prompt tokens against this, not prose
	contextTokens: number;
	tier: "resident" | "ondemand";
	/** Full tier only when a light row also loads a second checkpoint. */
	minimalResident?: boolean;
	// W504 request-side cap: max in-flight /v1 calls the :4000 router admits
	// for this port before 429 + ladder fall-through. Big unified-memory
	// backends swap under bursts (the W500 OOM class). Unset = global default
	// (BELT_MAX_INFLIGHT, 4); BELT_PORT_CAPS overrides per port.
	maxInflight?: number;
	engine?: "mlx_lm" | "rapid"; // default mlx_lm; rapid = rapid-mlx (MTP, prefix cache, batching)
	flags?: string[]; // extra server args for the chosen engine
	// W765: serving runtime — default from platformDefinitions (darwin=mlx,
	// win32/linux=llama.cpp-GGUF); an explicit row value pins it cross-platform
	runtime?: RuntimeBackend;
	// W242 catalog dimension: speculative decoding lives in the CHECKPOINT —
	// rapid-mlx auto-detects `mtp.*` weights and uses them; mlx_lm strips them
	// at load. "mtp" = the checkpoint ships MTP heads. Absent = plain
	// next-token decoding. bin/specdec.ts check verifies this declaration
	// against the served snapshot's weight names.
	spec_dec?: "mtp";
	// terse capability tags, comma-separated — written so an LLM picking an
	// agent-LLM from a fleet manifest chooses the right specialist
	good_at: string;
}

// Wire protocol per row: specialists speak OpenAI-compatible /v1 (rapid-mlx /
// mlx_lm servers); only the :4000 router speaks Anthropic. Exposed so the
// dashboard and LLM-facing manifests can state the protocol per entry.
export const SPECIALIST_PROTOCOL = "openai";
export const ROUTER_PROTOCOL = "anthropic-shim";

// The :4000 router is not a Specialist (no model of its own — it fronts the
// fleet and, when allowed, the cloud), but LLM-facing manifests list it
// alongside them.
// W289 operational fields: which launchd agent revives it and which log to
// tail — ONE source, so the recovery map (suspenders W273) drops its literals.
export const SWARM_AGENT = "com.suspenders.local-llm";
export const SWARM_LOG = "~/.claude-insights/swarm-serve-launchd.log";

export const ROUTER = {
	port: 4000,
	/** LiteLLM's local-only router group; never escalate this group back to LiteLLM. */
	gatewayAlias: "local-swarm",
	label: "router",
	role: "router",
	protocol: ROUTER_PROTOCOL,
	model_served: null,
	healthPath: "/health/liveness",
	launchdLabel: SWARM_AGENT,
	logPath: SWARM_LOG,
	good_at:
		"anthropic-protocol clients, deterministic role routing, fleet-wide access, cloud fallback",
} as const;

export type SPECIALIST_PORTS =
	| 8901
	| 8902
	| 8903
	| 8904
	| 8905
	| 8906
	| 8907
	| 8911
	| 8913;

export const SPECIALISTS: Specialist[] = [
	{
		// 2026-09-21 swap: Qwen3-Coder-30B-A3B (MoE, 3B active) replaces
		// Qwen2.5-Coder-32B (dense, prev gen) — faster inference + newer coder.
		// 2026-09-23: engine -> rapid (bench-suite A/B: 121.8 vs 91.9 tok/s).
		port: 8901,
		model: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
		label: "⚡ code",
		alias: "local-coder",
		role: "code",
		ram_gb: 18,
		maxInflight: 2, // 30B MoE — 2 concurrent before KV pressure (W504)
		contextTokens: 262_144,
		tier: "resident",
		engine: "rapid",
		flags: ["--enable-prefix-cache", "--response-cache-entries", "128"],
		// 2026-09-23 A/B: --kv-cache-dtype int8 = 87.3 vs 117.7 tok/s median (-26%)
		// at short contexts — dequant overhead dominates; bf16 KV stays.
		good_at:
			"code generation, multi-file edits, repo-scale refactors, long context",
	},
	{
		port: 8902,
		model: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
		label: "🏠 extract",
		alias: "local-extract",
		role: "extract",
		ram_gb: 2.5,
		contextTokens: 262_144,
		tier: "resident",
		engine: "rapid",
		flags: ["--enable-prefix-cache", "--response-cache-entries", "128"],
		good_at:
			"structured extraction, json shaping, summarization, fast cheap drafting",
	},
	{
		// 2026-10-03 swap (W228): OptiQ re-quant of the same model wins the reason
		// slot — fleet-refresh A/B 107.2 vs 86.0 tok/s (nonce-cold, load1 8.4, AC).
		// Prior 2026-09-23 swap: 35B-A3B replaced dense Qwen3.8-27B (147.9 vs 28.3).
		port: 8903,
		model: "mlx-community/Qwen3.5-35B-A3B-OptiQ-4bit",
		label: "🧠 reason",
		alias: "local-reason",
		role: "reason",
		ram_gb: 22,
		maxInflight: 2, // 35B — the W500 OOM class; ≤2 concurrent (W504)
		contextTokens: 262_144,
		tier: "resident",
		engine: "rapid",
		flags: [
			"--reasoning",
			"--enable-prefix-cache",
			"--response-cache-entries",
			"128",
		],
		good_at:
			"multi-step reasoning, planning, hard analysis, determinate answers, knowledge distillation",
	},
	// 8904/8905 retired when mlx_lm dropped the embedding and rerank routes.
	// rapid-mlx serves the cached embedding model through /v1/embeddings.
	{
		port: 8907,
		model: "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ",
		// rapid-mlx requires a positional chat model even for embedding-only use.
		serveModel: "mlx-community/Qwen3-Reranker-0.6B-4bit",
		label: "🧲 embed",
		alias: "local-embed",
		role: "embed",
		ram_gb: 2,
		contextTokens: 32_768,
		tier: "resident",
		minimalResident: false,
		engine: "rapid",
		flags: ["--embedding-model", "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ"],
		good_at: "text embeddings for retrieval (context-rag, mail-rag)",
	},
	{
		port: 8906,
		model: "mlx-community/Qwen3.5-9B-MLX-4bit",
		label: "🌐 danish/general",
		alias: "local-general",
		role: "general",
		ram_gb: 5,
		contextTokens: 262_144,
		tier: "ondemand",
		engine: "rapid",
		flags: [
			"--reasoning",
			"--enable-prefix-cache",
			"--response-cache-entries",
			"128",
		],
		good_at: "danish, general chat, translation, light on-demand reasoning",
	},
	{
		// 2026-09-24 adoption: found running stray on the brew 0.14.3 binary,
		// relaunched under the uv 0.15.x engine. Closes the doc-rerank gap left
		// by the 8904/8905 retirement (context-rag / mail-rag rerank consumers).
		port: 8913,
		model: "mlx-community/Qwen3-Reranker-0.6B-4bit",
		label: "🔀 rerank",
		alias: "local-rerank",
		role: "rerank",
		ram_gb: 0.5,
		contextTokens: 32_768,
		tier: "resident",
		engine: "rapid",
		flags: ["--enable-prefix-cache"],
		good_at: "document reranking, relevance ordering, query-passage scoring",
	},
];

// ─── external fleet members ───
// Processes that hold fleet RAM/ports but are NOT launched by belt (no swarm
// lifecycle, not in DOWNLOAD_MODELS). Declared here so the registry stays the
// single source of truth for every port the fleet occupies — never hidden.
export interface ExternalService {
	port: number;
	healthPath: string;
	launchdLabel?: string;
	model: string;
	label: string;
	alias: string;
	role: "classify" | "embed";
	ram_gb: number;
	contextTokens: number;
	tier: "resident" | "ondemand";
	owner: string; // where the process lives + who starts it
	protocol: string;
	good_at: string;
}

export const EXTERNAL: ExternalService[] = [
	{
		// Kev-4B typed-question classifier (System One API), base
		// Qwen/Qwen3.5-4B-Base; launchd/com.belt.kev.plist. Consumers: router-shim
		// ambiguity band, fit-classifier BELT_FIT_BACKEND=kev. contextTokens =
		// Kev's trained MAX_STATE (384); longer states are unmeasured.
		port: 8912,
		healthPath: "/v1/models",
		launchdLabel: "com.belt.kev",
		model: "jaredpalmer/kev-4b",
		label: "🗂 kev",
		alias: "local-kev",
		role: "classify",
		ram_gb: 8,
		contextTokens: 384,
		tier: "resident",
		owner: "external: ~/dev/kev (launchd com.belt.kev)",
		protocol: "systemone",
		good_at: "typed-question classification, use-case routing verdicts",
	},
];

// ─── audio tier (W440) — cloud TTS/STT rows in the fleet catalog ───
// NOT chat entries: registryEntries()/chatEntries() stay port-served models
// only, so the LiteLLM/direct/buckle emitters never see these rows — audio
// rides bin/audio.ts and the router's /v1/audio/* routes, and the ladder
// stays operator-owned (routing-policy.yaml, W440).
// Config-over-code: keyEnv carries the env NAME only — the key itself lives
// in machine config (~/.claude/local-llm/belt.env, 0600). Voice ids are
// public catalog values (like model ids); ELEVENLABS_BASE overrides base.
export type AudioClass = "tts" | "stt";

export interface AudioService {
	alias: string; // belt-facing alias (x-belt-audio on router audio replies)
	provider: string;
	model: string; // vendor model id
	class: AudioClass;
	base: string; // vendor public API base (override: ELEVENLABS_BASE)
	keyEnv: string; // env NAME holding the key — machine config only
	voice?: string; // default voice id (tts rows)
	good_at: string;
}

export const AUDIO_SERVICES: AudioService[] = [
	{
		alias: "elevenlabs-tts",
		provider: "elevenlabs",
		// stable multilingual production model (29 langs incl. Danish); pass
		// --model / body.model to ride a newer one (e.g. eleven_v3)
		model: "eleven_multilingual_v2",
		class: "tts",
		base: "https://api.elevenlabs.io/v1",
		keyEnv: "ELEVENLABS_API_KEY",
		voice: "21m00Tcm4TlvDq8ikWAM", // Rachel — the vendor's catalog default
		good_at: "lifelike speech synthesis, spoken alerts, danish + 28 langs",
	},
	{
		alias: "elevenlabs-stt",
		provider: "elevenlabs",
		model: "scribe_v1",
		class: "stt",
		base: "https://api.elevenlabs.io/v1",
		keyEnv: "ELEVENLABS_API_KEY",
		good_at: "speech-to-text transcription, voice dictation, 90+ langs",
	},
];

export const audioService = (cls: AudioClass): AudioService | undefined =>
	AUDIO_SERVICES.find((s) => s.class === cls);

export const DOWNLOAD_MODELS: string[] = [
	...SPECIALISTS.map((s) => s.model),
	"mlx-community/translategemma-4b-it-4bit",
];

export const byPort = (port: number): Specialist | undefined =>
	SPECIALISTS.find((s) => s.port === port);

// ─── install tier ───
// The resident-fleet tier scopes SPECIALISTS: "full" keeps every resident;
// "minimal" keeps only ram_gb ≤ 4 (extract :8902, rerank :8913) — the fleet
// a 16GB machine holds. A filter over this registry, not new infrastructure:
// on-demand models, the router and the dashboard are unchanged. Consumers
// import `residentSet()`.
//
// W507: the tier CHOICE is machine config — the emitted tier manifest
// (registry-emit `tier` → ~/.claude/local-llm/tier.json), written by the
// installers at deploy time. Service units carry no tier env: every consumer
// (swarm supervisor, llm-keepwarm) reads the manifest, so both sides of the
// keepwarm lockstep come from ONE emission (the drift class behind the W500
// crash trigger). Precedence: explicit BELT_TIER env override → manifest →
// "full" (today's unconfigured default).
export type Tier = "full" | "minimal";
export const TIER_MAX_RAM_GB = 4;

export function tierManifestPath(): string {
	return (
		process.env.BELT_TIER_MANIFEST ??
		join(homedir(), ".claude", "local-llm", "tier.json")
	);
}

export function resolveTier(): Tier {
	if (process.env.BELT_TIER === "minimal" || process.env.BELT_TIER === "full")
		return process.env.BELT_TIER;
	try {
		const doc = JSON.parse(readFileSync(tierManifestPath(), "utf8")) as {
			tier?: string;
		};
		if (doc.tier === "minimal" || doc.tier === "full") return doc.tier;
	} catch {
		// no manifest / unreadable / bad tier → unconfigured
	}
	return "full";
}

export const BELT_TIER: Tier = resolveTier();

export function residentSet(): Specialist[] {
	const resident = SPECIALISTS.filter((s) => s.tier === "resident");
	return resolveTier() === "minimal"
		? resident.filter(
				(s) => s.ram_gb <= TIER_MAX_RAM_GB && s.minimalResident !== false,
			)
		: resident;
}

/** Effective tier ownership, not the row's default tier. Minimal installs
 * leave heavy resident rows available for a guarded on-demand start. */
export function needsDemandStart(
	s: Pick<Specialist, "port">,
	resident = residentSet(),
): boolean {
	return !resident.some((row) => row.port === s.port);
}

// bounded fallback: heavy specialists cover each other; the 4B and the 9B
// fall up to the 35B-A3B reasoner.
// Derived from the registry — no second port↔model table to drift.
export function fallbackFor(port: number): Specialist | undefined {
	if (port === 8901) return byPort(8903); // coder → reason
	if (port === 8902) return byPort(8903); // extract → reason
	if (port === 8903) return byPort(8901); // reason → coder
	if (port === 8906) return byPort(8903); // danish/general → reason
	return undefined;
}

// ─── unified registry view (W271) ───
// ONE flat list of every servable model — belt-launched specialists and
// external members alike. Emitters (bin/registry-emit.ts), GET /registry.json
// and gateway-config all read THIS; nothing else declares a port↔model pair.
// `source` is designed for hub-fed mode: a hub serves its registry and
// spokes pull it (`hub:<name>`); today every row is `local`.
export type RegistrySource = "local" | `hub:${string}`;
// chat = OpenAI /v1/chat/completions; the rest speak their own API shape
export type ModelClass = "chat" | "embed" | "rerank" | "classify";

export interface RegistryEntry {
	// W289: path the health probe rides (probePathFor defaults /v1/models);
	// launchd agent that revives the row (absent = nothing does, e.g. the
	// on-demand embed server) and the log to tail when it stays dark.
	healthPath?: string;
	launchdLabel?: string;
	logPath?: string;
	port: number;
	alias: string;
	model: string;
	label: string;
	role: string;
	class: ModelClass;
	contextTokens: number;
	ram_gb: number;
	tier: "resident" | "ondemand";
	engine: "mlx_lm" | "rapid" | "external";
	// W765 mirror of Specialist.runtime — absent on external rows (their
	// process is owned elsewhere, the platform table doesn't decide for them)
	runtime?: RuntimeBackend;
	// W242 catalog dimension — mirror of Specialist.spec_dec (external rows
	// have no MLX checkpoint, so never set it there)
	spec_dec?: "mtp";
	protocol: string;
	external: boolean;
	owner: string;
	source: RegistrySource;
	good_at: string;
}

export interface RegistryDoc {
	version: 1;
	source: RegistrySource;
	router: typeof ROUTER;
	entries: RegistryEntry[];
	audio: AudioService[];
}

export const REGISTRY_SOURCE: RegistrySource = "local";

const classOf = (role: string): ModelClass => {
	if (role === "embed" || role === "rerank" || role === "classify") return role;
	return "chat";
};

/** Every servable model, sorted by port — the order every emitter uses. */
export function registryEntries(
	source: RegistrySource = REGISTRY_SOURCE,
): RegistryEntry[] {
	const local = SPECIALISTS.map(
		(s): RegistryEntry => ({
			port: s.port,
			alias: s.alias,
			model: s.model,
			label: s.label,
			role: s.role,
			class: classOf(s.role),
			contextTokens: s.contextTokens,
			ram_gb: s.ram_gb,
			tier: s.tier,
			engine: s.engine ?? "mlx_lm",
			runtime: runtimeFor(s),
			spec_dec: s.spec_dec,
			healthPath: "/v1/models",
			launchdLabel: SWARM_AGENT,
			logPath: SWARM_LOG,
			protocol: SPECIALIST_PROTOCOL,
			external: false,
			owner: "belt swarm",
			source,
			good_at: s.good_at,
		}),
	);
	const ext = EXTERNAL.map(
		(e): RegistryEntry => ({
			port: e.port,
			alias: e.alias,
			model: e.model,
			label: e.label,
			role: e.role,
			class: classOf(e.role),
			contextTokens: e.contextTokens,
			ram_gb: e.ram_gb,
			tier: e.tier,
			engine: "external",
			healthPath: e.healthPath,
			launchdLabel: e.launchdLabel,
			protocol: e.protocol,
			external: true,
			owner: e.owner,
			source,
			good_at: e.good_at,
		}),
	);
	return [...local, ...ext].sort((a, b) => a.port - b.port);
}

/** Chat-capable OpenAI-protocol entries — what gateways can route chat to. */
export const chatEntries = (entries = registryEntries()): RegistryEntry[] =>
	entries.filter((e) => e.class === "chat" && e.protocol === "openai");

export function registryDoc(
	source: RegistrySource = REGISTRY_SOURCE,
): RegistryDoc {
	return {
		version: 1,
		source,
		router: ROUTER,
		entries: registryEntries(source),
		audio: AUDIO_SERVICES,
	};
}
