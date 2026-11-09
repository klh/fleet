import { problem } from "./citizenship.ts";

/** The listener shares the gateway host. Never forward a caller bearer off-host. */
export function workerInventoryRelay(
	base: string,
	fetchImpl: typeof fetch = fetch,
): (request: Request) => Promise<Response> {
	const url = new URL(base);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("runner inventory requires a literal loopback origin");
	const endpoint = new URL("/v1/workers", url);
	return async (request) => {
		const authorization = request.headers.get("authorization");
		if (!authorization)
			return problem({
				status: 401,
				code: "buckle.worker_inventory_denied",
				why: "bearer required",
			});
		try {
			const response = await fetchImpl(endpoint, {
				headers: { authorization },
				redirect: "error",
				signal: AbortSignal.timeout(1_500),
			});
			return new Response(response.body, {
				status: response.status,
				headers: {
					"content-type": "application/json",
					"cache-control": "no-store",
				},
			});
		} catch {
			return problem({
				status: 503,
				code: "buckle.worker_inventory_unavailable",
				why: "runner listener unavailable",
			});
		}
	};
}
