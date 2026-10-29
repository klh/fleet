// hooks/lib/loopback.ts — W1256.2: the ONE loopback-endpoints constants
// module. Hostnames, ports and URL builders for the well-known loopback
// services (the AGENTS.md machines-and-processes map) live HERE — consumers
// import the constant instead of re-typing `http://127.0.0.1:<port>`, so a
// port change is a one-line edit and a drift scan has one source to grep.
//
// The loopback membership test is consolidated too: policy seams used to
// hand-roll `["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)`
// (consult-outbox-relay, session-policy, knowledge-sync-policy,
// service-inventory, belt hubs) — isLoopbackHostname is the one predicate,
// bracket- and case-normalized.

/** The loopback IPv4 address literal. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Build `http://127.0.0.1:<port>[<path>]`. */
export const loopbackUrl = (port: number, path = ""): string =>
	`http://${LOOPBACK_HOST}:${port}${path}`;

/** Hostname set treated as loopback (URL.hostname form; brackets stripped). */
export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"0:0:0:0:0:0:0:1",
]);

/** True when a URL.hostname (or bare host) names the local machine. */
export function isLoopbackHostname(host: string | null | undefined): boolean {
	if (!host) return false;
	const bare = host
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, "$1");
	return LOOPBACK_HOSTNAMES.has(bare);
}

// ─── well-known loopback ports (AGENTS.md machines-and-processes map) ────

export const ROUTER_PORT = 4000; // belt router-shim (Anthropic-format API)
export const LITELLM_PORT = 4100; // cloud gateway (com.suspenders.cloud-gateway)
export const BUCKLE_SPOKE_PORT = 4101; // buckle front, Mac spoke (hubs 4101/4111)
export const BELT_DASHBOARD_PORT = 7791; // com.belt.dashboard
export const STORE_PORT = 7794; // fleet store, Mac (NAS 7795 / desktop 7796)
export const BOARD_PORT = 7799; // fleet board
export const MLX_CODER_PORT = 8901; // :890x specialist tier below
export const MLX_EXTRACT_PORT = 8902;
export const MLX_REASON_PORT = 8903;
export const MLX_DANISH_PORT = 8906;
export const MLX_EMBEDDINGS_PORT = 8907;
export const MLX_KEV_PORT = 8912;
export const MLX_RERANK_PORT = 8913;
