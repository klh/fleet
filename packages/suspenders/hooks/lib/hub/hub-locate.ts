// hooks/lib/hub/hub-locate.ts — multi-hub registry resolver (generalizes the
// belt-locate.ts chain from "one named service" to "many labeled hubs").
// A repo's .prefer pins `hub=Label` (W228); this resolves that label to a
// REAL url instead of staying a display-only prefix (owner directive
// 2026-10-03: "local hub to remote hubs scenario" — one box may dispatch
// into IKEA's hub, a NAS-hosted hub, or its own local belt/buckle, and the
// repo should not have to hardcode which).
//
// chain, same shape as resolveBelt(): env override (per-label) → repo's own
// one-off candidates (.prefer `hub-url=`, most specific intent) → global
// registry (~/.claude/local-llm/hubs.json, label -> candidate list) → mDNS-
// style <label>.local guess (the suspenders.local/belt.local precedent) →
// null (callers degrade to local belt — never a silent wrong hub).
import { readFileSync } from "node:fs";
import { expandHome, warnDeprecated } from "@klh/settings";
import {
	darkHubNow,
	loadStack,
	stackSource,
	type HubProfile,
} from "../stack-config.ts";
import { BUCKLE_SPOKE_PORT } from "../loopback.ts";
import { hubBuckleUrl } from "./hub-endpoint.ts";

export interface HubLocation {
	label: string;
	url: string;
	token?: string;
	via: string;
}

type HubRegistry = Record<string, { candidates?: string[]; token?: string }>;

export const REGISTRY_PATH = (): string =>
	process.env.SUSPENDERS_HUBS_FILE ??
	`${process.env.HOME}/.claude/local-llm/hubs.json`;

export function readRegistry(): HubRegistry {
	try {
		return JSON.parse(readFileSync(REGISTRY_PATH(), "utf8")) as HubRegistry;
	} catch {
		return {};
	}
}

/** A hub's front token: the legacy inline value, else the first line of
 *  its 0600 `token_file` (settings.json never holds the value itself). */
export function profileToken(prof: HubProfile): string | undefined {
	if (prof.token) return prof.token;
	if (!prof.token_file) return undefined;
	try {
		const first = readFileSync(expandHome(prof.token_file), "utf8").split(
			"\n",
		)[0];
		return first?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Every hub label this machine knows (settings/stack hubs + legacy
 *  registry), for `.prefer hub=<label>` validation. */
export function knownHubLabels(): string[] {
	let stackLabels: string[] = [];
	try {
		stackLabels = Object.keys(loadStack().hubs);
	} catch {}
	return [...new Set([...stackLabels, ...Object.keys(readRegistry())])].sort();
}

/** `.prefer hub=<label>` check: null when known, else a warning naming
 *  the known labels (an unknown label silently degrades to local belt). */
export function unknownHubWarning(label: string): string | null {
	const known = knownHubLabels();
	const want = label.trim().toLowerCase();
	if (!want || known.some((l) => l.toLowerCase() === want)) return null;
	return `.prefer hub=${label.trim()}: unknown hub label — known: ${known.join(", ") || "none"} (add it under hubs in settings.json)`;
}

const HUB_SERVICE_TYPE = "_klh-hub._tcp";

// Browse for advertised hubs (belt/bin/remotes.ts's discover(), ported for
// hubs instead of LLM endpoints). Browse first for a name matching the
// label, then -L to resolve its SRV record (host:port) — a bare browse only
// yields instance names, never a port.
async function discoverHub(label: string): Promise<string | null> {
	try {
		const browse = Bun.spawnSync(
			["/usr/bin/dns-sd", "-B", HUB_SERVICE_TYPE, "local."],
			{ timeout: 3000 },
		);
		const wantLower = label.toLowerCase();
		let name: string | null = null;
		// real `dns-sd -B` output is column-formatted (timestamp/flags/if/
		// domain/type/instance), NOT "<name>.<type>.local." on one token —
		// the instance name is the trailing field on a row naming our
		// service type.
		for (const line of browse.stdout.toString().split("\n")) {
			if (!line.includes(`${HUB_SERVICE_TYPE}.`)) continue;
			const parts = line.trim().split(/\s+/);
			const candidate = parts.at(-1);
			if (candidate?.toLowerCase().includes(wantLower)) {
				name = candidate;
				break;
			}
		}
		if (!name) return null;
		const lookup = Bun.spawnSync(
			["/usr/bin/dns-sd", "-L", name, HUB_SERVICE_TYPE, "local."],
			{ timeout: 3000 },
		);
		const m = lookup.stdout.toString().match(/can be reached at (\S+):(\d+)/);
		if (!m) return null;
		const [, host, port] = m;
		for (const scheme of ["https", "http"]) {
			const cand = `${scheme}://${host}:${port}`;
			if (await alive(cand)) return cand;
		}
		return null;
	} catch {
		return null; // no dns-sd on this platform, or browse/lookup timed out
	}
}

// a server that answers AT ALL counts as present (even a 404) — belt-locate
// precedent: we are locating a host, not a route.
export async function alive(base: string): Promise<boolean> {
	for (const path of ["/api/health", "/health/liveliness", "/"]) {
		try {
			await fetch(base.replace(/\/$/, "") + path, {
				signal: AbortSignal.timeout(1500),
			});
			return true;
		} catch {}
	}
	return false;
}

/** Resolve a `.prefer` hub label to a real, reachable URL.
 *  `oneOff` = candidates the repo itself declared (.prefer `hub-url=`,
 *  comma-separated) — tried before the global registry since they are the
 *  more specific owner intent (same precedence rule as W228 must-wins). */
export async function resolveHub(
	label: string,
	oneOff: string[] = [],
): Promise<HubLocation | null> {
	const norm = label.trim();
	if (!norm) return null;
	// 0. W483 quiet hours — a hub inside its stack.json dark window is
	// EXPECTED down (NAS nightly poweroff); resolving it would pin lanes to
	// a host that vanishes mid-flight. Degrade like any unresolved label.
	if (darkHubNow(norm)) return null;
	// 1. explicit env override, per label (SUSPENDERS_HUB_IKEA_URL, etc.)
	const envKey = `SUSPENDERS_HUB_${norm.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
	const envUrl = process.env[envKey];
	if (envUrl)
		return { label: norm, url: envUrl.replace(/\/$/, ""), via: "env" };
	// 2. repo-declared one-off candidates
	for (const cand of oneOff) {
		if (await alive(cand))
			return {
				label: norm,
				url: cand.replace(/\/$/, ""),
				via: "prefer hub-url",
			};
	}
	// 2b. the ONE stack config (W230) — profile url (+ optional front
	// token) is the machine truth for a labeled hub; hubs.json stays the
	// fallback lookup. Missing/bad file just continues the chain.
	let prof: HubProfile | undefined;
	let viaHub: "settings hubs" | "stack.json" = "settings hubs";
	try {
		const hubs = loadStack().hubs;
		prof = Object.entries(hubs).find(
			([l]) => l.toLowerCase() === norm.toLowerCase(),
		)?.[1];
		if (stackSource() !== "settings") viaHub = "stack.json";
	} catch {
		// no/bad config — the chain continues to the registry
	}
	const url = prof ? hubBuckleUrl(prof) : null;
	const token = prof ? profileToken(prof) : undefined;
	if (url && (await alive(url)))
		return { label: norm, url, token, via: viaHub };
	// 2c. settings.json `hubs.<label>.candidates` — the folded hubs.json
	// registry rows, same label.
	for (const cand of prof?.candidates ?? []) {
		if (await alive(cand))
			return {
				label: norm,
				url: cand.replace(/\/$/, ""),
				token,
				via: `${viaHub} candidates`,
			};
	}
	// 3. legacy global registry (hubs.json, one-release fallback — `coord
	// settings migrate` folds it into settings.json hubs.<label>).
	const reg = readRegistry()[norm] ?? readRegistry()[norm.toUpperCase()];
	for (const cand of reg?.candidates ?? []) {
		if (await alive(cand)) {
			warnDeprecated(
				"hubs.json",
				`${REGISTRY_PATH()} is deprecated — run \`coord settings migrate\` (hubs.<label>.candidates in settings.json)`,
			);
			return {
				label: norm,
				url: cand.replace(/\/$/, ""),
				token: reg?.token,
				via: "registry hubs.json",
			};
		}
	}
	// 4. DNS-SD browse — same convention belt/bin/remotes.ts already uses for
	// LLM discovery (_klh-llm._tcp, avahi on linux / dns-sd on macOS), one
	// service type over for hubs: _klh-hub._tcp. A NAS or sibling box that
	// runs a hub announces itself here; no registry entry required.
	const sdUrl = await discoverHub(norm);
	if (sdUrl) return { label: norm, url: sdUrl, via: "dns-sd _klh-hub._tcp" };
	// 5. mDNS guess (last resort) — the suspenders.local/belt.local
	// precedent, one guess at the buckle shadow port and the bare
	// name, for hubs that run a plain Bonjour hostname with no SRV record.
	const guessHost = norm.toLowerCase().replace(/[^a-z0-9-]/g, "");
	for (const cand of [
		`https://${guessHost}.local:${BUCKLE_SPOKE_PORT}`,
		`http://${guessHost}.local:${BUCKLE_SPOKE_PORT}`,
	]) {
		if (await alive(cand)) return { label: norm, url: cand, via: "mdns guess" };
	}
	return null; // hub unreachable/unconfigured — caller degrades to local belt
}
