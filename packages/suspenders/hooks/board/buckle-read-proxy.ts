// The Buckle console reuses the live fleet graph without exposing Belt's
// machine-local read API to the browser. Keep this proxy read-only and exact.
const DATA_PATHS = new Set([
	"/api/status",
	"/api/remotes",
	"/api/supervisor",
	"/api/network",
	"/api/model-access",
	"/api/model-capabilities",
	"/api/model-inventory",
	"/api/topology-context",
	"/api/metrics/history",
]);

const ASSET_PATHS = new Set([
	"/dashboard-topology.js",
	"/dashboard-model-access.js",
	"/dashboard-topology-model.js",
	"/dashboard-topology-hubs.js",
	"/dashboard-topology-hubs-model.js",
	"/dashboard-observability.js",
	"/dashboard-state.js",
	"/observation.js",
	"/vendor/lit.js",
	"/vendor/uPlot.iife.min.js",
	"/vendor/uPlot.min.css",
]);

const DATA_PREFIX = "/api/console/buckle";
const ASSET_PREFIX = "/console/buckle-assets";
// W1294.2.1: env override is the test pin (console-network dead-belt board);
// live default stays the machine belt observation feed.
const BELT_READ_ORIGIN =
	process.env.SUSPENDERS_BELT_READ_ORIGIN || "http://127.0.0.1:7791";

// W1294.2.1: freshness probe for the belt chunk set — HEAD the NEWEST chunk
// (the one W858.7.31 added). A 200 proves the runtime home is at least
// W858.7.31-fresh, so the older two chunks necessarily serve too and the
// belt page may emit all its script tags. A stale runtime home (dashboard.ts
// predates the chunk routes) 404s and the page drops the tags instead of
// console-erroring on every load.
export async function beltAssetUp(
	fetchRead: typeof fetch = fetch,
): Promise<boolean> {
	try {
		const upstream = await fetchRead(
			`${BELT_READ_ORIGIN}/dashboard-topology-hubs.js`,
			{
				method: "HEAD",
				cache: "no-store",
				signal: AbortSignal.timeout(3000),
			},
		);
		return upstream.status === 200;
	} catch {
		return false;
	}
}

export async function buckleReadProxy(
	req: Request,
	url: URL,
	fetchRead: typeof fetch = fetch,
): Promise<Response | null> {
	const isData = url.pathname.startsWith(`${DATA_PREFIX}/`);
	const isAsset = url.pathname.startsWith(`${ASSET_PREFIX}/`);
	if (!isData && !isAsset) return null;
	if (req.method !== "GET" && req.method !== "HEAD")
		return new Response("method not allowed", { status: 405 });
	const path = url.pathname.slice((isData ? DATA_PREFIX : ASSET_PREFIX).length);
	if (!(isData ? DATA_PATHS : ASSET_PATHS).has(path))
		return new Response("not found", { status: 404 });
	try {
		const target = `${BELT_READ_ORIGIN}${path}${isData ? url.search : ""}`;
		const upstream = await fetchRead(target, {
			method: req.method,
			cache: "no-store",
			signal: AbortSignal.timeout(6000),
		});
		const headers = new Headers({ "cache-control": "no-store" });
		const contentType = upstream.headers.get("content-type");
		if (contentType) headers.set("content-type", contentType);
		return new Response(req.method === "HEAD" ? null : upstream.body, {
			status: upstream.status,
			headers,
		});
	} catch {
		return new Response("Buckle read feed unavailable", { status: 503 });
	}
}
