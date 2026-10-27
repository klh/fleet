// src/wire-routes.ts — route dispatch (createApp): lane prefixes, named
// bases, LLM ingress, sidestore routes, and the final 404/405 law.

import { aidsRoutes } from "./aids-routes.ts";
import type { AppDeps } from "./app-deps.ts";
import {
	allowOf,
	lanePrefixOf,
	methodNotAllowed,
	options204,
	problem,
} from "./citizenship.ts";
import { dietRoutes } from "./diet.ts";
import { principalOf } from "./gov/federation.ts";
import { handleNamedIngress, namedIngressOf } from "./ingress-routes.ts";
import { pipelineRoutes } from "./pipeline.ts";
import { proxy } from "./proxy-ingress.ts";
import { repoPolicyRoutes } from "./repo-policy-routes.ts";

interface App {
	fetch(req: Request): Promise<Response>;
}

/** Route dispatch; servicemon instruments at the server seam. */
export function createApp(deps: AppDeps): App {
	async function fetch(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname;
		const method = req.method;
		// http-citizenship: introspection from the one route table (the gate
		// answers pre-auth when enabled; this covers BUCKLE_AUTH=off + tests).
		if (method === "OPTIONS") {
			const allow = allowOf(path);
			if (allow !== null) return options204(allow);
		}
		// W1 lane attribution (caveman adopt 1): /w/<slug> prefixes the LLM
		// ingress + /v1/models only. The slug lands in the audit row + the
		// x-belt-route header; the upstream sees the bare path. Other
		// surfaces (federation/admin/aids) stay unprefixed — a lane prefix
		// never widens surface.
		// W1265 named bases (/anthropic, /openai, /zai/*) — guard answers first
		// (typed local 4xx, zero outbound), legacy bare /v1 paths verbatim.
		const named = namedIngressOf(path);
		if (named !== null)
			return handleNamedIngress(named, req, method, deps, proxy);
		const laneRoute = lanePrefixOf(path);
		if (laneRoute.lane !== "") {
			const inner = laneRoute.path;
			const ingress =
				inner === "/v1/chat/completions" ||
				inner === "/v1/messages" ||
				inner === "/v1/messages/count_tokens" ||
				inner === "/v1/responses" ||
				inner === "/v1/models";
			if (method === "OPTIONS" && ingress)
				return options204(allowOf(inner) ?? "OPTIONS");
			if (method === "GET" && inner === "/v1/models") return models(deps);
			if (method === "POST" && inner === "/v1/chat/completions")
				return proxy(req, "openai", inner, deps, laneRoute.lane);
			if (method === "POST" && inner === "/v1/responses")
				return proxy(req, "openai", inner, deps, laneRoute.lane);
			if (method === "POST" && inner === "/v1/messages/count_tokens")
				return proxy(req, "anthropic", inner, deps, laneRoute.lane);
			if (method === "POST" && inner === "/v1/messages")
				return proxy(req, "anthropic", inner, deps, laneRoute.lane);
			if (ingress) return methodNotAllowed(inner);
			return problem({
				status: 404,
				code: "buckle.no_route",
				why: `no route: ${method} ${path}`,
			});
		}
		if (method === "GET" && path === "/v1/models") return models(deps);
		if ((method === "GET" || method === "HEAD") && path === "/health") {
			// Compatibility liveness only; outside-process probes own health.
			return new Response(method === "HEAD" ? null : "ok", {
				headers: { "content-type": "text/plain", "cache-control": "no-store" },
			});
		}

		if (method === "GET" && path === "/.well-known/jwks.json") {
			// W193: public JWKS — spokes fetch the manifest-signing public key
			// pre-cred; bare deps 404 honestly (the AppDeps contract).
			if (!deps.federation?.signer)
				return problem({
					status: 404,
					code: "buckle.no_route",
					why: `no route: ${method} ${path}`,
				});
			return Response.json(deps.federation.signer.jwks());
		}
		if (path.startsWith("/federation")) {
			// bare deps 404 honestly (the AppDeps contract)
			if (!deps.federation)
				return problem({
					status: 404,
					code: "buckle.no_route",
					why: `no route: ${method} ${path}`,
				});
			return deps.federation.handle(req, principalOf(req));
		}
		if (method === "GET" && path === "/v1/fleet/whoami") {
			// W607: self-verify echo for GUI fleet readers — the presented
			// bearer IS the credential (no admin needed). The gate already
			// authenticated + scope-checked (proxy GET → buckle:proxy:READ_);
			// 200 means the key is live, and the echo carries the identity
			// (key_id, scopes) the fleet-mcp server audits + enforces.
			const p = principalOf(req);
			return Response.json(
				p === null
					? { authenticated: false, reason: "gate off or anonymous" }
					: {
							authenticated: true,
							kind: p.kind,
							key_id: p.keyId,
							team: p.team,
							actor: p.actor,
							scopes: p.scopes,
						},
			);
		}
		const aidsRouted = await aidsRoutes(deps, req);
		if (aidsRouted) return aidsRouted;
		const pipeRouted = await pipelineRoutes(deps, req, path);
		if (pipeRouted) return pipeRouted;
		const dietRouted = await dietRoutes(deps, req, path);
		if (dietRouted) return dietRouted;
		const rpRouted = await repoPolicyRoutes(
			{ rows: deps.repoPolicy ?? [], sm: deps.sm },
			req,
			path,
		);
		if (rpRouted) return rpRouted;
		if (method === "POST" && path === "/v1/chat/completions") {
			return proxy(req, "openai", path, deps);
		}
		// W912: the OpenAI Responses ingress — same openai dialect, the path
		// forwards verbatim (responses-only models are NEVER re-targeted at
		// chat completions; other-dialect hops are ineligible by bridge law).
		if (method === "POST" && path === "/v1/responses") {
			return proxy(req, "openai", path, deps);
		}
		if (method === "POST" && path === "/v1/messages/count_tokens") {
			return proxy(req, "anthropic", path, deps);
		}
		if (method === "POST" && path === "/v1/messages") {
			return proxy(req, "anthropic", path, deps);
		}
		// known path, wrong method → 405 + Allow (admin paths stay 404 here —
		// the gate routes them post-auth, where handleAdmin answers 405).
		if (allowOf(path) !== null && !path.startsWith("/v1/admin")) {
			return methodNotAllowed(path);
		}
		return problem({
			status: 404,
			code: "buckle.no_route",
			why: `no route: ${method} ${path}`,
		});
	}
	return { fetch };
}

function models(deps: AppDeps): Response {
	const data = deps.pool
		.groups()
		.filter((id) => deps.pool.deployments(id).length > 0)
		.map((id) => ({ id, object: "model", owned_by: "buckle" }));
	return Response.json({ object: "list", data });
}
