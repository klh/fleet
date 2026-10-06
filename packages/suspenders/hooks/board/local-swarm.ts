// hooks/board/local-swarm.ts — W183.1: THIS MACHINE's own local-llm swarm
// surfaced as prime (plane:"local") dispatch executors. Distinct from
// belt.ts (LAN peers + cloud providers another machine serves) — this reads
// the same canonical Belt registry as the dashboard and service consoles.
// Only chat-capable models can execute a lane. Model checks require 2xx;
// the router is checked on its actual health endpoint.
import {
	MODEL_INVENTORY,
	ROUTER_INVENTORY as ROUTER,
	probePathFor,
} from "../lib/service-inventory.ts";
const SPECIALISTS = MODEL_INVENTORY.filter((s) => s.class === "chat");

export interface LocalSwarmEntry {
	port: number;
	model: string;
	label: string;
	role: string;
	// W183.1 — reasoning-effort is only meaningful for the "reason"
	// specialist today; everything else ignores the dial if sent one.
	reasoningEffort: boolean;
	ok: boolean;
}

const probeHttp = async (
	port: number,
	path = "/v1/models",
): Promise<boolean> => {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			signal: AbortSignal.timeout(800),
		});
		return response.ok;
	} catch {
		return false;
	}
};

let cache: { at: number; rows: LocalSwarmEntry[] } | null = null;

export const localSwarmEntries = async (): Promise<LocalSwarmEntry[]> => {
	if (cache && Date.now() - cache.at < 60_000) return cache.rows;
	const specialists = await Promise.all(
		SPECIALISTS.map(async (s) => ({
			port: s.port,
			model: s.model,
			label: s.label,
			role: s.role,
			reasoningEffort: s.role === "reason",
			ok: await probeHttp(s.port, probePathFor(s)),
		})),
	);
	const router = ROUTER
		? {
				port: ROUTER.port,
				model: "router",
				label: ROUTER.label,
				role: ROUTER.role,
				reasoningEffort: false,
				ok: await probeHttp(ROUTER.port, "/health/liveliness"),
			}
		: null;
	const rows = [...specialists, ...(router ? [router] : [])];
	cache = { at: Date.now(), rows };
	return rows;
};

// port -> Specialist lookup for dispatch-time resolution (routes-actions.ts
// llm:local:<port> picks) — kept here so the port<->model contract has one
// reader, mirroring registry.ts's own byPort().
export const specialistByPort = (port: number) =>
	SPECIALISTS.find((s) => s.port === port);
