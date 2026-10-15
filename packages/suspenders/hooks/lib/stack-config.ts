// hooks/lib/stack-config.ts — the ONE stack.yaml reader (config-over-code:
// real hosts, ports, secret PATHS live only in ~/.config/klh/stack.yaml,
// mode 600). deploy/hubctl.ts renders deploys from it; coord hubs (W356)
// projects the topology from it. KLH_STACK overrides the path (tests).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export interface HubProfile {
	host: string;
	buckle_port?: number;
	board_port?: number;
	store_port?: number;
	belt_port?: number;
	/** Health sidecar serve ports (W422.10) — where each *-health probe
	 *  serves its verdict; falls through to the template default when
	 *  undeclared. */
	buckle_health_port?: number;
	board_health_port?: number;
	store_health_port?: number;
	belt_health_port?: number;
	/** W763 hub model store — the face port + its health sidecar. */
	model_store_port?: number;
	model_store_health_port?: number;
	/** Synthetic readiness (W467): where the buckle-ready sidecar serves the
	 *  completion-leg verdict, and which model the synthetic 1-token request
	 *  names (must be one the hub's routing ladder actually serves). */
	buckle_ready_port?: number;
	ready_model?: string;
	/** W688.7.1: the buckle entrypoint the hub runs (path inside the
	 *  container). Unset = the base `src/server.ts` (provider-less solo
	 *  posture); an enterprise hub points it at the overlay entry that
	 *  injects the gov providers (its own src/server.ts). */
	buckle_entry?: string;
	/** W688.7.1: private-network hosts the ladder may reach over plain http
	 *  (BUCKLE_HTTP_UPSTREAM_HOSTS egress allowlist), e.g. the engine host. */
	http_upstream_hosts?: string[];
	bind?: string;
	board_bind?: string;
	belt_bind?: string;
	allowed_hosts?: string[];
	services_json?: string;
	peers?: string[];
	/** Deploy source: `ref` pins the git ref for all three repos; the named
	 *  entries override origins (forks/mirrors) — never host paths, the hub
	 *  pulls its code from the git origins into volumes. */
	repos?: {
		ref?: string;
		buckle?: string;
		suspenders?: string;
		belt?: string;
		/** Packages root inside the clone the hub services run from. An
		 *  overlay monorepo (private tier) resolves its pinned public base
		 *  under node_modules/<dep>/packages; unset = the public layout. */
		src?: string;
	};
	deploy?: {
		ssh?: string;
		dir: string;
		docker?: string;
		compose?: string;
		/** W701: seconds ssh/scp wait to connect (-o ConnectTimeout) before
		 *  an unreachable hub fails fast; unset = 10. BatchMode is always on. */
		connect_timeout?: number;
	};
	/** W688.7.1: the hub's REAL upstream ladder (config-over-code) — inline
	 *  `groups:` in buckle's upstreams.yaml shape, materialized by hubctl
	 *  into the deploy dir and merged over the committed (placeholder)
	 *  ladder via BUCKLE_UPSTREAMS. Keys stay in env vars named by each
	 *  row's api_key_env — never values here. */
	upstreams?: { groups?: Record<string, Array<Record<string, unknown>>> };
	secrets?: {
		buckle_root_key?: string;
		/** Ladder key env NAME → key-file PATH on the hub device. hubctl push
		 *  materializes them into the 0600 `upstream.env` ON the hub (the
		 *  value is read there, never printed or transported); values never
		 *  live in config. */
		upstream_keys?: Record<string, string>;
	};
	/** W483: nightly dark window "HH:MM-HH:MM" (may cross midnight) — the
	 *  hub is EXPECTED down in it (NAS DSM poweroff). Routing skips, dispatch
	 *  falls back to local belt, monitoring suppresses instead of paging. */
	quiet_hours?: string;
}

export interface StackConfig {
	/** The stack version: ONE string pins buckle+suspenders+belt — the ref
	 *  every repo sidecar pulls. Absent = main (dev posture). */
	version?: string;
	hubs: Record<string, HubProfile>;
	auth?: { required?: boolean };
}

export const STACK_PATH = (): string =>
	process.env.KLH_STACK ?? join(homedir(), ".config", "klh", "stack.yaml");

/** Parse the machine-level stack config; `hubs:` is mandatory. */
export function loadStack(): StackConfig {
	const raw = parse(readFileSync(STACK_PATH(), "utf8")) as StackConfig;
	if (!raw?.hubs || typeof raw.hubs !== "object") {
		throw new Error(`no hubs: section in ${STACK_PATH()}`);
	}
	return raw;
}

// ---- quiet hours (W483) ----------------------------------------------------
// A hub with `quiet_hours: "00:00-08:00"` is EXPECTED dark in that window
// (NAS DSM nightly poweroff). Consumers: resolveHub (skip dark hubs),
// dispatch-next (fall back to local belt, surfaced), hubctl status (exit 0),
// metrics-alert (suppress instead of paging dead-letter noise).

export interface QuietWindow {
	/** minutes from midnight, inclusive start / exclusive end */
	start: number;
	end: number;
}

/** Parse "HH:MM-HH:MM" — start past end means the window crosses midnight.
 *  Malformed specs return null (a typo never darks a hub by accident). */
export function parseQuietHours(spec: string): QuietWindow | null {
	const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
	if (!m) return null;
	const [sh, sm, eh, em] = m.slice(1).map(Number);
	const mins = (h: number, mm: number): number | null =>
		h > 23 || mm > 59 ? null : h * 60 + mm;
	const start = mins(sh, sm);
	const end = mins(eh, em);
	if (start === null || end === null || start === end) return null;
	return { start, end };
}

const minutesOf = (d: Date): number => d.getHours() * 60 + d.getMinutes();

/** Is `now` inside the hub's quiet window? No spec (or unparseable) = never
 *  quiet — config-over-code: only an explicit operator window suppresses. */
export function inQuietHours(
	hub: Pick<HubProfile, "quiet_hours">,
	now: Date = new Date(),
): boolean {
	if (!hub.quiet_hours) return false;
	const w = parseQuietHours(hub.quiet_hours);
	if (!w) return false;
	const m = minutesOf(now);
	return w.start < w.end
		? m >= w.start && m < w.end
		: m >= w.start || m < w.end;
}

const profileHost = (hub: HubProfile): string =>
	(hub.host ?? "").replace(/^[^@]+@/, "");

/** Label → is that hub dark RIGHT NOW? Case-insensitive (resolveHub
 *  precedent); missing stack.yaml / unknown label / no window = false. */
export function darkHubNow(label: string, now: Date = new Date()): boolean {
	try {
		const key = label.trim().toLowerCase();
		const hub = Object.entries(loadStack().hubs).find(
			([l]) => l.toLowerCase() === key,
		)?.[1];
		return hub ? inQuietHours(hub, now) : false;
	} catch {
		return false;
	}
}

/** Target URL → is it a quiet-hours hub's host? Metrics-alert suppression
 *  keys on hostname (stack.yaml hosts are bare, ssh user stripped). */
export function urlInQuietHours(url: string, now: Date = new Date()): boolean {
	try {
		const host = new URL(url).hostname;
		return Object.values(loadStack().hubs).some(
			(h) => profileHost(h) === host && inQuietHours(h, now),
		);
	} catch {
		return false;
	}
}
