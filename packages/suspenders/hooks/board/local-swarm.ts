// hooks/board/local-swarm.ts — W183.1: THIS MACHINE's own local-llm swarm
// surfaced as prime (plane:"local") dispatch executors. Distinct from
// belt.ts (LAN peers + cloud providers another machine serves) — this reads
// registry.ts, the swarm's single source of truth for port<->model pairs
// (packages/local-llm/registry.ts), and live-probes each resident specialist
// the same way swarm.ts's own health check does (any HTTP response on
// /v1/models = listening; the router doesn't implement it by design and
// is probed separately with a cheap TCP-level check instead).
// W422.4 moved the kit to packages/local-llm; install.sh copies it to
// $PREFIX/local-llm for the installed harness. One static specifier can't
// resolve in both layouts — resolve dynamically, repo layout first.
type Registry = typeof import("../local-llm/registry.ts");
let registryMod: Registry | null = null;
const loadRegistry = async (): Promise<Registry> => {
	if (registryMod) return registryMod;
	for (const spec of [
		"../local-llm/registry.ts",
		"../../../local-llm/registry.ts",
	]) {
		try {
			registryMod = (await import(spec)) as Registry;
			return registryMod;
		} catch {}
	}
	throw new Error(
		"local-llm registry not found (neither $PREFIX/local-llm nor packages/local-llm layout)",
	);
};

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

const probeHttp = async (port: number): Promise<boolean> => {
	try {
		await fetch(`http://127.0.0.1:${port}/v1/models`, {
			signal: AbortSignal.timeout(800),
		});
		return true;
	} catch {
		return false;
	}
};

let cache: { at: number; rows: LocalSwarmEntry[] } | null = null;

export const localSwarmEntries = async (): Promise<LocalSwarmEntry[]> => {
	if (cache && Date.now() - cache.at < 60_000) return cache.rows;
	const { ROUTER, SPECIALISTS } = await loadRegistry();
	const specialists = await Promise.all(
		SPECIALISTS.map(async (s) => ({
			port: s.port,
			model: s.model,
			label: s.label,
			role: s.role,
			reasoningEffort: s.role === "reason",
			ok: await probeHttp(s.port),
		})),
	);
	const router = {
		port: ROUTER.port,
		model: "router",
		label: ROUTER.label,
		role: ROUTER.role,
		reasoningEffort: false,
		ok: await probeHttp(ROUTER.port),
	};
	const rows = [...specialists, router];
	cache = { at: Date.now(), rows };
	return rows;
};

// port -> Specialist lookup for dispatch-time resolution (routes-actions.ts
// llm:local:<port> picks) — kept here so the port<->model contract has one
// reader, mirroring registry.ts's own byPort().
export const specialistByPort = async (port: number) =>
	(await loadRegistry()).SPECIALISTS.find((s) => s.port === port);
