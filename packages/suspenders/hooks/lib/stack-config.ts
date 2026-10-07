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
	/** Synthetic readiness (W467): where the buckle-ready sidecar serves the
	 *  completion-leg verdict, and which model the synthetic 1-token request
	 *  names (must be one the hub's routing ladder actually serves). */
	buckle_ready_port?: number;
	ready_model?: string;
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
	};
	secrets?: { buckle_root_key?: string };
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
