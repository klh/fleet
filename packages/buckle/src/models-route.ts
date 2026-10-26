// src/models-route.ts — W1265.2: the account-bound /v1/models face. Every
// route arm (named base, /w/<lane> prefix, legacy bare) resolves the
// account-discovery verdict before listing: anonymous/unknown keys refuse
// (typed 403, zero outbound), lane slugs bind, root rides, and the listing
// filters to the class's entitled groups (null = unfiltered).
import { discoveryFilter, globMatch, REPO_CLAIM_HEADER } from "./account-policy.ts";
import { problem } from "./citizenship.ts";
import type { AppDeps } from "./handlers.ts";
import type { IngressLocal } from "./ingress-routes.ts";
import { principalOf } from "./gov/federation.ts";

export function modelsRoute(
	deps: AppDeps,
	req: Request,
	lane: string | null,
): Response {
	const principal = principalOf(req);
	const verdict = discoveryFilter(deps.accountPolicy ?? null, {
		kind: principal?.kind ?? null,
		keyName: principal?.name ?? null,
		claimRepo: req.headers.get(REPO_CLAIM_HEADER),
		lane,
	});
	if (!verdict.ok)
		return problem({
			status: verdict.status,
			code: verdict.code,
			why: verdict.why,
		});
	const groups = verdict.groups;
	const data = deps.pool
		.groups()
		.filter((id) => deps.pool.deployments(id).length > 0)
		.filter((id) => groups === null || groups.some((g) => globMatch(g, id)))
		.map((id) => ({ id, object: "model", owned_by: "buckle" }));
	return Response.json({ object: "list", data });
}

export const modelsFace: IngressLocal = (req, lane, d) =>
	modelsRoute(d, req, lane);
