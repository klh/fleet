export interface PlaidRoute {
	/** Route key — `ikea-*` is reserved for Copilot-provider rides. */
	name: string;
	/** Honest human label (the board shows it verbatim). */
	label: string;
	/** Executor chain token ("codex", "claude"); adapterFor resolves the bin. */
	executor: string;
	/** Belt model/group pin; null = the executor CLI rides its own config. */
	model: string | null;
	/** exec-quota provider key the route's health reads; null = exempt. */
	provider: string | null;
}

/** Owner definition 2026-10-19; W989 truthfulness pass 2026-10-20: the
 *  codex executor rides the PERSONAL Codex CLI seat — it never touches the
 *  Copilot provider through Buckle — so it carries no ikea-* name and no
 *  pool provider (a personal seat is never pool capacity; bin-probed only,
 *  dispatchable only where a route pick reaches it outside the pools). The
 *  Copilot ride is the claude CLI pinned to claude-sonnet-5 (the Copilot
 *  seat serves the Anthropic wire). Table order IS the defined fallback:
 *  Copilot → glm (glm-flash the floor) → personal codex. */
export const PLAID_ROUTES: PlaidRoute[] = [
	{
		name: "ikea-sonnet",
		label: "IKEA Copilot Sonnet",
		executor: "claude",
		model: "claude-sonnet-5",
		provider: "copilot",
	},
	{
		name: "glm-5.3-flash",
		label: "GLM 5.3 Flash",
		executor: "claude",
		model: "glm-5.3-flash",
		provider: "zai",
	},
	{
		name: "codex-personal",
		label: "Codex (personal seat)",
		executor: "codex",
		model: null,
		provider: null,
	},
];

/** Route rows → validated table; junk rows/fields fall back to defaults
 *  (fail-safe narrow, same doctrine as readPosture). */
export const parsePlaidRoutes = (rows?: unknown): PlaidRoute[] => {
	if (!Array.isArray(rows) || rows.length === 0) return PLAID_ROUTES;
	const out: PlaidRoute[] = [];
	for (const raw of rows) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			return PLAID_ROUTES;
		const r = raw as Partial<PlaidRoute>;
		if (typeof r.name !== "string" || !r.name.trim()) return PLAID_ROUTES;
		if (typeof r.executor !== "string" || !r.executor.trim())
			return PLAID_ROUTES;
		if (r.name.toLowerCase().startsWith("ikea-") && r.provider !== "copilot")
			return PLAID_ROUTES; // the IKEA label is reserved (honesty law)
		const label =
			typeof r.label === "string" && r.label.trim()
				? r.label.trim()
				: r.name.trim();
		out.push({
			name: r.name.trim(),
			label,
			executor: r.executor.trim(),
			model:
				typeof r.model === "string" && r.model.trim() ? r.model.trim() : null,
			provider:
				typeof r.provider === "string" && r.provider.trim()
					? r.provider.trim()
					: null,
		});
	}
	return out;
};

/** Explicit operator routes are authoritative; invalid rows never re-enable defaults. */
export function validatePlaidRoutes(value: unknown): PlaidRoute[] {
	if (!Array.isArray(value) || value.length > 64)
		throw new Error("plaid_routes: expected an array of at most 64 routes");
	if (value.length === 0) return [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error("plaid_routes: each route must be an object");
		const row = raw as Record<string, unknown>;
		for (const key of ["name", "executor"] as const)
			if (
				typeof row[key] !== "string" ||
				!row[key].trim() ||
				row[key].length > 200
			)
				throw new Error(
					`plaid_routes: ${key} must be a nonempty string (max 200 chars)`,
				);
		for (const key of ["label", "model", "provider"] as const)
			if (
				row[key] !== undefined &&
				row[key] !== null &&
				(typeof row[key] !== "string" || row[key].length > 200)
			)
				throw new Error(`plaid_routes: invalid ${key}`);
	}
	const routes = parsePlaidRoutes(value);
	if (
		routes === PLAID_ROUTES ||
		new Set(routes.map((route) => route.name)).size !== routes.length
	)
		throw new Error("plaid_routes: invalid or duplicate route identities");
	return routes;
}
