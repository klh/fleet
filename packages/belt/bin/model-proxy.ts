// Belt-owned, model-agnostic OpenAI wire for a local model server. The
// upstream URL is machine config; its live /v1/models response is inventory.
// Buckle sends work here, and this component never forwards Buckle keys.
export function createModelProxy(options: { upstream: string }) {
	const origin = new URL(options.upstream);
	if (
		!["http:", "https:"].includes(origin.protocol) ||
		origin.username ||
		origin.password
	)
		throw new Error(
			"Belt model upstream must be an HTTP URL without credentials",
		);
	const base = origin.href.replace(/\/$/, "");

	return async (request: Request): Promise<Response> => {
		const path = new URL(request.url).pathname;
		const inventory =
			path === "/v1/models" &&
			(request.method === "GET" || request.method === "HEAD");
		const chat = path === "/v1/chat/completions" && request.method === "POST";
		if (!inventory && !chat)
			return Response.json({ error: "not found" }, { status: 404 });

		const parent = request.headers.get("traceparent");
		const trace =
			request.headers.get("x-klh-trace-id") ??
			/^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(parent ?? "")?.[1];
		const headers = new Headers({
			"cache-control": "no-store",
			"x-klh-hop": "belt",
			"x-klh-service": "belt-model-proxy",
		});
		if (trace) headers.set("x-klh-trace-id", trace);
		const upstreamHeaders = new Headers();
		for (const name of ["accept", "content-type", "traceparent"]) {
			const value = request.headers.get(name);
			if (value) upstreamHeaders.set(name, value);
		}
		try {
			const response = await fetch(`${base}${path}`, {
				method: request.method,
				headers: upstreamHeaders,
				body: chat ? request.body : undefined,
				signal: inventory
					// inventory: fixed 3s — a catalog poll, not a stream (#55405)
					? AbortSignal.any([request.signal, AbortSignal.timeout(3000)])
					// W1106: chat streams carry NO fixed client-side cutoff — the
					// client's abort (Buckle's wire guards upstream of this hop)
					// is the deadline authority, propagated via request.signal.
					: request.signal,
				redirect: "manual",
			});
			const contentType = response.headers.get("content-type");
			if (contentType) headers.set("content-type", contentType);
			if (inventory && response.ok && request.method === "GET") {
				const catalog = await response.json();
				if (!Array.isArray(catalog?.data) || catalog.data.length === 0)
					return Response.json(
						{ error: "model inventory unavailable" },
						{ status: 503, headers },
					);
				return Response.json(catalog, { status: response.status, headers });
			}
			return new Response(request.method === "HEAD" ? null : response.body, {
				status: response.status,
				headers,
			});
		} catch {
			headers.set("x-klh-refusal", "network");
			return Response.json(
				{ error: "model upstream unavailable" },
				{ status: inventory ? 503 : 502, headers },
			);
		}
	};
}

if (import.meta.main) {
	const upstream = process.env.BELT_MODEL_UPSTREAM;
	if (!upstream) throw new Error("BELT_MODEL_UPSTREAM is required");
	const port = Number(process.env.BELT_MODEL_PORT ?? "8914");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
		throw new Error("BELT_MODEL_PORT must be a TCP port");
	Bun.serve({
		hostname: "127.0.0.1",
		port,
		// W1106 (owner directive 2026-10-21): no Bun idle cutoff on the
		// inference path — quiet model streams ride past any fixed timer.
		idleTimeout: 0,
		fetch: createModelProxy({ upstream }),
	});
}
