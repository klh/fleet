// deploy/phase0-rehearsal/apim-sim.ts — the APIM policy stand-in (W2968).
// Simulates the Azure APIM front for the local two-Buckle rehearsal:
// identity gate, token-bucket quota, correlation-id mint, raw stream
// passthrough. It is a SIMULATION of the policy shape — the real APIM
// policy is validated in the live Phase 0 exit test, never here.
//
// Faces (route ALLOWLIST — everything else 404s at the sim, never proxied):
//   GET  /__health            sim-local liveness (unauthenticated; the
//                             readiness poll target — exempt from quota)
//   GET  /v1/models           proxied after the identity gate (discovery)
//   POST /v1/chat/completions proxied after the gate (raw stream
//                             passthrough — the buffer-response="false"
//                             equivalent: the client reads the upstream
//                             SSE bytes unbuffered)
//   /v1/admin/*, /__log, ...  404 — excluded from the published surface
//
// Correlation contract: inbound x-klh-request-id / x-request-id are
// STRIPPED and a fresh id is minted per request (crypto.randomUUID) —
// the client never dictates correlation. The sim adds NO fleet headers
// of its own beyond that id (no hop-contract stamping — verify asserts
// the id survives both buckles unchanged).
//
// NO EXTERNAL IMPORTS by contract: the rehearsal mounts the worktree
// read-only at /src/fleet and node_modules does not resolve inside the
// container (Pi's stub entrypoint follows the same rule). Config is
// loud-fail parsed from env by hand — zod is unavailable in that mount.

/** Loud-fail env parse (zod unavailable in the container mount — see head). */
const parseApimSimConfig = (env: Record<string, string | undefined>) => {
	const need = (name: string): string => {
		const value = env[name];
		if (typeof value !== "string" || value.length === 0) {
			console.error(`apim-sim: missing required env ${name}`);
			process.exit(1);
		}
		return value;
	};
	const num = (name: string, fallback: number): number => {
		const raw = env[name];
		if (typeof raw !== "string" || raw.length === 0) return fallback;
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0) {
			console.error(`apim-sim: bad ${name} "${raw}"`);
			process.exit(1);
		}
		return value;
	};
	return {
		port: num("APIM_PORT", 8191),
		bind: env.APIM_BIND || "0.0.0.0",
		authToken: need("APIM_AUTH_TOKEN"),
		// the sim->edge hop credential, minted at up and injected by the
		// force-recreate (empty until then — proxy answers 503, never the
		// client's own credential relayed)
		edgeKey: env.APIM_EDGE_KEY || "",
		upstream: need("APIM_UPSTREAM").replace(/\/+$/, ""),
		quotaRequests: num("APIM_QUOTA_REQUESTS", 60),
		quotaWindowMs: num("APIM_QUOTA_WINDOW_MS", 60_000),
	};
};

const cfg = parseApimSimConfig(process.env);

// Token-bucket quota — one identity (the APIM subscription-key stand-in).
// Refills continuously across the window; an empty bucket answers 429 with
// a Retry-After, exactly the APIM rate-limit policy shape.
const bucket = { tokens: cfg.quotaRequests, last: Date.now() };
const takeToken = (): boolean => {
	const now = Date.now();
	const rate = cfg.quotaRequests / cfg.quotaWindowMs;
	bucket.tokens = Math.min(
		cfg.quotaRequests,
		bucket.tokens + (now - bucket.last) * rate,
	);
	bucket.last = now;
	if (bucket.tokens < 1) return false;
	bucket.tokens -= 1;
	return true;
};

// W3C traceparent mint — the correlation plane on the buckle wire. The
// buckles relay traceparent child spans (never the APIM request id), so
// the rehearsal joins by trace id: `00-<32hex>-<16hex>-01` per spec.
const mintTraceparent = (): string =>
	`00-${crypto.randomUUID().replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`;

// Fixed-target proxy. Raw stream passthrough: the upstream body flows to
// the client UNBUFFERED (the SSE bytes arrive as the edge Buckle emits
// them). Client correlation ids never ride; one fresh id is minted per
// request and echoed on the response so the caller can trace it.
const proxy = async (req: Request): Promise<Response> => {
	const inbound = new URL(req.url);
	const id = crypto.randomUUID();
	const tp = mintTraceparent();
	const target = `${cfg.upstream}${inbound.pathname}${inbound.search}`;
	const headers = new Headers(req.headers);
	headers.delete("host");
	headers.delete("content-length");
	// distinct credentials: the client's developer identity STOPS at the
	// sim — the edge hop rides the scoped APIM_EDGE_KEY minted at up
	headers.delete("authorization");
	headers.delete("x-api-key");
	headers.delete("x-klh-request-id");
	headers.delete("x-request-id");
	// client-forged trace context is never relayed — one trusted trace per
	// request is minted here (the buckles relay traceparent child spans, not
	// the APIM request id; the rehearsal joins by trace id)
	headers.delete("traceparent");
	headers.delete("tracestate");
	headers.set("x-klh-request-id", id);
	headers.set("traceparent", tp);
	if (cfg.edgeKey.length === 0)
		return Response.json(
			{ error: { message: "edge credential not minted yet" } },
			{ status: 503 },
		);
	headers.set("authorization", `Bearer ${cfg.edgeKey}`);
	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method: req.method,
			headers,
			body: req.body,
			redirect: "manual",
		});
	} catch {
		// the APIM shape: upstream unreachable surfaces as 502, never a
		// bare 500 from an unhandled proxy throw
		return Response.json(
			{ error: { message: "upstream unreachable" } },
			{ status: 502 },
		);
	}
	const out = new Headers(upstream.headers);
	out.set("x-klh-request-id", id);
	out.set("x-klh-trace-id", tp.split("-")[1] ?? "");
	return new Response(upstream.body, {
		status: upstream.status,
		headers: out,
	});
};

// The route surface: health bypass, allowlist, identity gate — proxied
// requests ride the fixed-target raw passthrough.
const handle = async (req: Request): Promise<Response> => {
	const url = new URL(req.url);
	if (url.pathname === "/__health") return Response.json({ ok: true });
	// route ALLOWLIST: discovery + inference only, everything else is 404
	// AT THE SIM (admin faces and stub journals never publish here)
	if (url.pathname !== "/v1/models" && url.pathname !== "/v1/chat/completions")
		return Response.json(
			{ error: { message: `no such route: ${url.pathname}` } },
			{ status: 404 },
		);
	// identity gate (the APIM subscription-key shape)
	const auth = req.headers.get("authorization") ?? "";
	if (auth !== `Bearer ${cfg.authToken}`)
		return Response.json(
			{ error: { message: "invalid identity" } },
			{ status: 401 },
		);
	// quota (the APIM rate-limit policy shape: 429 + Retry-After)
	if (!takeToken())
		return Response.json(
			{ error: { message: "quota exceeded" } },
			{
				status: 429,
				headers: { "retry-after": String(Math.ceil(cfg.quotaWindowMs / 1000)) },
			},
		);
	return proxy(req);
};

Bun.serve({
	hostname: cfg.bind,
	port: cfg.port,
	fetch: (req) => handle(req),
});

console.log(
	`apim-sim: serving ${cfg.bind}:${cfg.port} -> ${cfg.upstream} ` +
		`(quota ${cfg.quotaRequests}/${cfg.quotaWindowMs}ms)`,
);
