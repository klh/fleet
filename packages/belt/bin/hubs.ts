// hubs.ts — remote buckle hubs as supervised rows (W351 probe-only, W371
// self-healing).
//
// ~/.claude/local-llm/hubs.json is the label → candidate-URLs registry
// suspenders' resolveHub() walks (hooks/lib/hub-locate.ts). Belt reads the
// SAME file (env SUSPENDERS_HUBS_FILE overrides, same key) and turns each
// label into a supervisor Target so the dashboard's Supervisor section and
// /llms.txt can surface the hubs visibly.
//
// W371: a hub whose stack.yaml profile declares deploy.dir is RESTARTABLE —
// belt runs docker compose up on the hub when it is down (ssh-wrapped for a
// remote deploy.ssh target, local /bin/sh for a local-docker hub). Labels
// join case-insensitively (coord hubs precedent); a hub without a profile
// stays probe-only. Belt still never spawns ON another host — the restart
// is one compose-up command the hub executes.

import { readFileSync } from "node:fs";
import { composeUpArgv } from "../../suspenders/deploy/hub-remote.ts";
import { mergedHubUpstreams } from "../../suspenders/deploy/openrouter-free.ts";
import { mergeZaiHubUpstreams } from "../../suspenders/deploy/zai-catalog.ts";
import { readZaiSnapshot } from "./zai-catalog-rows.ts";
import {
	inQuietHours,
	tryLoadStack,
	type HubProfile,
} from "../../suspenders/hooks/lib/stack-config.ts";
import type { Target } from "./supervisor.ts";

const HUBS_PATH = () =>
	process.env.SUSPENDERS_HUBS_FILE ??
	`${process.env.HOME}/.claude/local-llm/hubs.json`;

/** A complete registry revision. Ignore partial or malformed writes so the
 *  running supervisor keeps its last valid hub set until the next poll. */
export function hubRegistryRevision(): string | null {
	try {
		const source = readFileSync(HUBS_PATH(), "utf8");
		const value: unknown = JSON.parse(source);
		return value && typeof value === "object" && !Array.isArray(value)
			? source
			: null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		return null;
	}
}

export interface HubRow {
	label: string;
	consoleUrl?: string;
	/** First candidate URL (hub-locate precedence: candidates are ordered). */
	base: string;
	host: string;
	port: number;
	tls: boolean;
}

export function browserConsoleUrl(
	value: unknown,
	remote = true,
): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			!url.hostname ||
			url.username ||
			url.password
		)
			return null;
		if (
			remote &&
			(url.hostname.endsWith(".local") ||
				["localhost", "127.0.0.1", "::1"].includes(url.hostname))
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}

/** Parse the hub registry — entries with a usable candidate URL only.
 *  Missing or unreadable file = no rows (belt runs hub-less). */
export function readHubs(file = HUBS_PATH()): HubRow[] {
	const rows: HubRow[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return rows;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rows;
	for (const [label, entry] of Object.entries(raw as Record<string, unknown>)) {
		const candidates =
			entry && typeof entry === "object" && !Array.isArray(entry)
				? (entry as { candidates?: unknown }).candidates
				: null;
		const base =
			typeof candidates === "string"
				? candidates
				: Array.isArray(candidates) && typeof candidates[0] === "string"
					? candidates[0]
					: "";
		if (!base) continue;
		let url: URL;
		try {
			url = new URL(base);
		} catch {
			continue;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") continue;
		const consoleUrl = browserConsoleUrl(
			entry && typeof entry === "object" && !Array.isArray(entry)
				? (entry as { console_url?: unknown }).console_url
				: null,
		);
		rows.push({
			label,
			...(consoleUrl ? { consoleUrl } : {}),
			base: base.replace(/\/$/, ""),
			host: url.hostname,
			port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
			tls: url.protocol === "https:",
		});
	}
	return rows;
}

export function hubConsoleLinks(): Array<{ name: string; url: string }> {
	const profiles = hubProfiles();
	return readHubs().flatMap((hub) => {
		const url =
			browserConsoleUrl(profiles.get(hub.label.toLowerCase())?.console_url) ??
			hub.consoleUrl;
		return url ? [{ name: hub.label, url }] : [];
	});
}

/** Browser-safe gateway route names from registered hub profiles. This is
 *  configuration inventory, not a claim that inference currently succeeds. */
export function hubGatewayRoutes(): Array<{
	name: string;
	models: string[];
	routeCount: number;
	unresolvedRoutes: string[];
	routesByModel: Record<string, string[]>;
	providerIntents: string[];
	providerHosts: string[];
	providerHostsByModel: Record<string, string[]>;
	providerModelIds: Record<string, { provider: string; id: string }>;
}> {
	const profiles = hubProfiles();
	return readHubs().map((hub) => {
		const profile = profiles.get(hub.label.toLowerCase());
		let groups = profile?.upstreams?.groups ?? {};
		if (profile) {
			try {
				groups = mergeZaiHubUpstreams(profile, mergedHubUpstreams(profile));
			} catch {
				// Missing or stale generated catalogs never become configured routes.
				// Explicit machine-level routes remain visible on their own.
			}
		}
		const hosts = new Set<string>();
		const modelHosts = new Map<string, Set<string>>();
		const routesByModel = new Map<string, Set<string>>();
		const unresolvedRoutes: string[] = [];
		let zaiIds = new Set<string>();
		if (profile?.upstreams?.zai_catalog_file) {
			try {
				zaiIds = new Set(
					readZaiSnapshot(profile.upstreams.zai_catalog_file).model_ids,
				);
			} catch {
				// A stale or unreadable snapshot never supplies provider provenance.
			}
		}
		const providerModelIds: Record<string, { provider: string; id: string }> =
			{};
		for (const [route, candidates] of Object.entries(groups)) {
			let resolved = false;
			for (const candidate of candidates) {
				const inherited = candidate["<<"];
				const inheritedCandidate =
					inherited && typeof inherited === "object"
						? (inherited as Record<string, unknown>)
						: null;
				const model = candidate.model ?? inheritedCandidate?.model;
				if (typeof model !== "string" || !model.trim()) continue;
				resolved = true;
				const name = model.trim();
				if (name.startsWith("zai-") && zaiIds.has(name.slice(4)))
					providerModelIds[name] = { provider: "zai", id: name.slice(4) };
				if (!modelHosts.has(name)) modelHosts.set(name, new Set());
				if (!routesByModel.has(name)) routesByModel.set(name, new Set());
				routesByModel.get(name)?.add(route);
				const raw = candidate.url ?? inheritedCandidate?.url;
				if (typeof raw !== "string") continue;
				try {
					const host = new URL(raw).hostname.toLowerCase();
					hosts.add(host);
					modelHosts.get(name)?.add(host);
				} catch {}
			}
			if (!resolved) unresolvedRoutes.push(route);
		}
		return {
			name: hub.label,
			models: [...modelHosts.keys()],
			routeCount: Object.keys(groups).length,
			unresolvedRoutes,
			providerIntents: (
				profiles.get(hub.label.toLowerCase())?.provider_intents ?? []
			).filter(
				(key) => typeof key === "string" && /^[a-z][a-z0-9-]*$/.test(key),
			),
			routesByModel: Object.fromEntries(
				[...routesByModel].map(([model, routes]) => [model, [...routes]]),
			),
			providerHosts: [...hosts],
			providerHostsByModel: Object.fromEntries(
				[...modelHosts].map(([model, targets]) => [model, [...targets]]),
			),
			providerModelIds,
		};
	});
}

/** Stack profiles keyed by stable hub id. Display names never affect lookup
 *  or healing; a missing stack still leaves registry hubs probe-only. */
function hubProfiles(): Map<string, HubProfile> {
	const out = new Map<string, HubProfile>();
	for (const [label, hub] of Object.entries(tryLoadStack()?.hubs ?? {})) {
		out.set(label.toLowerCase(), hub);
	}
	return out;
}

/** One whole-heal budget: compose up may pull images / start cold containers.
 *  The supervisor polls the port for this long after a clean compose exit. */
export const HUB_BIND_TIMEOUT_MS = 90_000;

const HEAL_CMD_TIMEOUT_MS = 120_000;

/** W371 heal closure: docker compose up on the hub. Null = clean run; a
 *  string is a bounded failure note (last stderr/out lines). */
export function hubHeal(profile: HubProfile): () => Promise<string | null> {
	return async () => {
		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn(composeUpArgv(profile), {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (e) {
			return `heal spawn failure: ${String(e)}`;
		}
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
		}, HEAL_CMD_TIMEOUT_MS);
		try {
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code === 0) return null;
			const note = `${err}${out}`.trim();
			const lines = note.split("\n").slice(-3).join(" | ");
			return `compose up exit ${code}: ${lines.slice(0, 300)}`;
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Supervisor targets for the registry. Probe-only by default; rows whose
 *  stack.yaml profile declares deploy.dir carry a heal closure + quiet-hours
 *  hold (W483: a hub is EXPECTED down in its window — no restart attempts,
 *  no paging). */
export function hubTargets(): Target[] {
	const profiles = hubProfiles();
	return readHubs().map((h) => {
		const profile = profiles.get(h.label.toLowerCase());
		const displayName = profile?.display_name?.trim();
		const row: Target = {
			name: h.label,
			...(displayName ? { displayName } : {}),
			port: h.port,
			kind: "hub",
			owned: false,
			host: h.host,
			...(h.tls ? { scheme: "https" as const } : {}),
			healthPath: "/api/health",
		};
		if (!profile?.deploy?.dir) return row;
		return {
			...row,
			heal: hubHeal(profile),
			quietHours: () => inQuietHours(profile),
			bindTimeoutMs: HUB_BIND_TIMEOUT_MS,
		};
	});
}

/** One llms.txt row per hub: `- LABEL base — state`. */
export function hubLlmsRows(
	rows: HubRow[],
	stateOf: (h: HubRow) => string,
): string[] {
	return rows.map((h) => `- ${h.label} ${h.base} — ${stateOf(h)}`);
}
