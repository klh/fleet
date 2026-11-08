// scripts/install/install-pi.ts — the pi coding-agent fleet face (W2861).
// The 2026-11-08 owner ask: "why didn't our install auto-enable everything
// for pi?" — because pi wiring never existed: the models.json was
// hand-written during the stall recovery. This module makes the install own
// it: one anthropic-messages provider per fleet hub, models = the hub's
// LIVE /v1/models (6s probe, down hubs skipped), apiKey = a `!command` that
// sources the machine conf at request time — no key material ever lands in
// pi's config. pi reads skills from the SHARED ~/.agents/skills dir
// natively (vendored skills-agents registry, 'pi' row), so skills need no
// per-agent install step. A pre-existing user-authored models.json (no
// $fleetGenerated marker) is user content — preserved untouched.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The marker distinguishing a fleet-generated models.json from user content. */
export const PI_MODELS_MARKER = "$fleetGenerated";

export interface PiModelsResult {
	status: "ok" | "planned" | "skipped" | "failed";
	/** Provider names landed in the file (empty when skipped/preserved). */
	providers: string[];
	note: string;
}

interface HubRow {
	candidates: string[];
	token?: string;
}

export interface PiModelsOptions {
	home?: string;
	/** pi agent dir (default `<home>/.pi/agent`). */
	piHome?: string;
	/** machine-conf dir holding hubs.json + buckle-spoke.env. */
	llmConfDir?: string;
	/** local spoke face (default the fixed fleet topology :4101). */
	spokeUrl?: string;
	probeTimeoutMs?: number;
	dryRun?: boolean;
}

/** Reads one KEY=VALUE line from a machine-conf env file (never logged). */
function envValue(envPath: string, key: string): string | null {
	if (!existsSync(envPath) || statSync(envPath).isSymbolicLink()) return null;
	const line = readFileSync(envPath, "utf8")
		.split("\n")
		.find((l) => l.startsWith(`${key}=`));
	if (line === undefined) return null;
	return line.slice(key.length + 1).trim() || null;
}

function readHubs(confDir: string): Record<string, HubRow> {
	const path = join(confDir, "hubs.json");
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`invalid hubs.json at ${path}`);
	return parsed as Record<string, HubRow>;
}

async function listModels(url: string, key: string, timeoutMs: number) {
	try {
		const res = await fetch(`${url}/v1/models`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return [];
		const body = (await res.json()) as { data?: { id?: string }[] };
		return (body.data ?? [])
			.filter((m): m is { id: string } => typeof m.id === "string")
			.map((m) => m.id);
	} catch {
		return [];
	}
}

interface PiProvider {
	baseUrl: string;
	apiKey: string;
	models: string[];
}

/** The local spoke face: `fleet` provider when the spoke env + probe allow. */
async function spokeProvider(
	confDir: string,
	spokeUrl: string,
	timeoutMs: number,
	downs: string[],
): Promise<PiProvider | null> {
	const envPath = join(confDir, "buckle-spoke.env");
	const key = envValue(envPath, "BUCKLE_ROOT_KEY");
	if (key === null) return null;
	const models = await listModels(spokeUrl, key, timeoutMs);
	if (models.length === 0) {
		downs.push("local spoke");
		return null;
	}
	return {
		baseUrl: spokeUrl,
		apiKey: `!sed -n 's/^BUCKLE_ROOT_KEY=//p' ${envPath}`,
		models,
	};
}

/** One hub face: `fleet-<label>` provider when the hub row + probe allow. */
async function hubProvider(
	label: string,
	hub: HubRow,
	confDir: string,
	timeoutMs: number,
	downs: string[],
): Promise<PiProvider | null> {
	if (!Array.isArray(hub.candidates) || hub.candidates.length === 0)
		return null;
	const url = hub.candidates[0];
	if (typeof hub.token !== "string" || hub.token === "") return null;
	const models = await listModels(url, hub.token, timeoutMs);
	if (models.length === 0) {
		downs.push(label);
		return null;
	}
	const hubsPath = join(confDir, "hubs.json");
	return {
		baseUrl: url,
		apiKey: `!bun -e 'const h=JSON.parse(require("fs").readFileSync(${JSON.stringify(hubsPath)},"utf8"));console.log(h.${label}.token)'`,
		models,
	};
}

/**
 * Probes the local spoke + every hub and returns the pi provider map.
 * Down faces are skipped (the next install retries them); hub labels
 * resolving to the local spoke URL are not duplicated.
 */
async function gatherProviders(options: {
	confDir: string;
	spokeUrl: string;
	timeoutMs: number;
}): Promise<{ providers: Map<string, PiProvider>; downs: string[] }> {
	const providers = new Map<string, PiProvider>();
	const downs: string[] = [];
	const spoke = await spokeProvider(
		options.confDir,
		options.spokeUrl,
		options.timeoutMs,
		downs,
	);
	if (spoke !== null) providers.set("fleet", spoke);
	const hubs = readHubs(options.confDir);
	for (const [label, hub] of Object.entries(hubs)) {
		if (hub.candidates[0] === options.spokeUrl) continue;
		const one = await hubProvider(
			label,
			hub,
			options.confDir,
			options.timeoutMs,
			downs,
		);
		if (one !== null) providers.set(`fleet-${label}`, one);
	}
	return { providers, downs };
}

/** True when the existing models.json is user content (no fleet marker). */
function userAuthored(modelsPath: string): boolean {
	if (!existsSync(modelsPath)) return false;
	try {
		const parsed: unknown = JSON.parse(readFileSync(modelsPath, "utf8"));
		return (
			parsed === null ||
			typeof parsed !== "object" ||
			!(PI_MODELS_MARKER in (parsed as object))
		);
	} catch {
		return true;
	}
}

/** Serializes the provider map into the 0600 models.json. */
function writeModels(
	modelsPath: string,
	providers: Map<string, PiProvider>,
): void {
	const config = {
		[PI_MODELS_MARKER]: true,
		$schema: "https://pi.dev/schemas/models.schema.json",
		providers: Object.fromEntries(providers),
	};
	writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
}

/** Resolves the run's paths + tuning from options with machine defaults. */
function resolveState(options: PiModelsOptions): {
	piHome: string;
	confDir: string;
	timeoutMs: number;
	spokeUrl: string;
	modelsPath: string;
} {
	const home = options.home ?? process.env.HOME ?? "";
	const piHome = options.piHome ?? join(home, ".pi", "agent");
	const confDir = options.llmConfDir ?? join(home, ".claude", "local-llm");
	const timeoutMs = options.probeTimeoutMs ?? 6000;
	const spokeUrl = options.spokeUrl ?? "http://127.0.0.1:4101";
	return {
		piHome,
		confDir,
		timeoutMs,
		spokeUrl,
		modelsPath: join(piHome, "models.json"),
	};
}

/** The skip verdict when pi is absent or the models.json is user content. */
function skipReason(state: {
	piHome: string;
	modelsPath: string;
}): string | null {
	if (!existsSync(state.piHome)) {
		return `${state.piHome} absent — pi not installed, nothing wired`;
	}
	if (userAuthored(state.modelsPath)) {
		return `${state.modelsPath} is user content (no marker) — preserved untouched`;
	}
	return null;
}

/** W2861 entry — probe fleet faces, write the 0600 models.json when pi exists. */
export async function installPiModels(
	options: PiModelsOptions = {},
): Promise<PiModelsResult> {
	const state = resolveState(options);
	const skip = skipReason(state);
	if (skip !== null) return { status: "skipped", providers: [], note: skip };
	const { providers, downs } = await gatherProviders({
		confDir: state.confDir,
		spokeUrl: state.spokeUrl,
		timeoutMs: state.timeoutMs,
	});
	if (providers.size === 0)
		return {
			status: "skipped",
			providers: [],
			note: `no reachable fleet face (${downs.join(", ") || "no conf"})`,
		};
	if (options.dryRun === true)
		return {
			status: "planned",
			providers: [...providers.keys()],
			note: `would write ${state.modelsPath} (${providers.size} providers)`,
		};
	mkdirSync(state.piHome, { recursive: true });
	writeModels(state.modelsPath, providers);
	const downsSuffix =
		downs.length > 0 ? ` (down, skipped: ${downs.join(", ")})` : "";
	const faces = [...providers.keys()]
		.map((p) => `${p} (${(providers.get(p) as PiProvider).models.length})`)
		.join(", ");
	return {
		status: "ok",
		providers: [...providers.keys()],
		note: `wrote ${state.modelsPath}: ${faces}${downsSuffix}`,
	};
}

if (import.meta.main) {
	if (process.argv.includes("--help")) {
		console.log("usage: bun install-pi.ts [--dry-run] [--help]");
	} else {
		const result = await installPiModels({
			dryRun: process.argv.includes("--dry-run"),
		});
		console.log(`pi models face [${result.status}]: ${result.note}`);
	}
}
