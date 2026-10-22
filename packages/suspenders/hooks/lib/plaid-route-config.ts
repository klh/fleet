export interface PlaidRoute {
	/** Route key — `ikea-*` is reserved for Copilot-provider rides. */
	name: string;
	/** Honest human label (the board shows it verbatim). */
	label: string;
	/** Executor chain token ("codex", "claude"); adapterFor resolves the bin. */
	executor: string;
	/** Belt model/group pin; null = the executor CLI rides its own config. */
	model: string | null;
	/** exec-quota provider key the route's health reads; null = exempt.
	 *  Known set: copilot | zai | local — anything else is a junk row.
	 *  `local` = a Buckle-backed ride on THIS host's Belt models: it MUST
	 *  pin a model (the model IS the ride — nothing unpinned is verifiable
	 *  through the front's catalog) and its health is the live model probe
	 *  plus the measured host-capacity gate, never a copilot/zai quota
	 *  fact. Local lanes are their own pool — never copilot/zai capacity. */
	provider: string | null;
}

/** The pool provider set a route may declare (schema truth — plaid.ts's
 *  POOL_PROVIDERS is this tuple; one source, DRY). */
export const PLAID_PROVIDERS = ["copilot", "zai", "local"] as const;

/** Owner definition 2026-10-19; W989 truthfulness pass 2026-10-20: the
 *  codex executor rides the PERSONAL Codex CLI seat — it never touches the
 *  Copilot provider through Buckle — so it carries no ikea-* name and no
 *  pool provider (a personal seat is never pool capacity; bin-probed only,
 *  dispatchable only where a route pick reaches it outside the pools). The
 *  Copilot ride is the claude CLI via the Buckle front, pinned to
 *  claude-sonnet-5 (the Copilot seat serves the Anthropic wire). Table order
 *  IS the defined fallback: Copilot → glm (glm-flash the floor) → personal
 *  codex. The host's Belt local coder is NOT a default row — operator
 *  config (suspenders-board.json plaid_routes) declares it when the host
 *  carries the capacity; a declared local route is a full pool member. */
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
		const model =
			typeof r.model === "string" && r.model.trim() ? r.model.trim() : null;
		const provider =
			typeof r.provider === "string" && r.provider.trim()
				? r.provider.trim()
				: null;
		// honesty law, symmetric to the ikea- reservation: a `local-` name
		// never rides a cloud provider, and a provider outside the known set
		// is a junk row (an unknown pool is a dead route, never capacity)
		if (r.name.toLowerCase().startsWith("local-") && provider !== "local")
			return PLAID_ROUTES;
		if (
			provider !== null &&
			!(PLAID_PROVIDERS as readonly string[]).includes(provider)
		)
			return PLAID_ROUTES;
		// a local route is Buckle-backed: unpinned = unverifiable = junk
		if (provider === "local" && !model) return PLAID_ROUTES;
		const label =
			typeof r.label === "string" && r.label.trim()
				? r.label.trim()
				: r.name.trim();
		out.push({
			name: r.name.trim(),
			label,
			executor: r.executor.trim(),
			model,
			provider,
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
		const provider =
			typeof row.provider === "string" && row.provider.trim()
				? row.provider.trim()
				: null;
		if (
			provider !== null &&
			!(PLAID_PROVIDERS as readonly string[]).includes(provider)
		)
			throw new Error(
				`plaid_routes: provider must be one of ${PLAID_PROVIDERS.join(", ")} (or null)`,
			);
		const model =
			typeof row.model === "string" && row.model.trim()
				? row.model.trim()
				: null;
		if (provider === "local" && !model)
			throw new Error(
				'plaid_routes: provider "local" must pin a model (the Belt/Buckle-served model id the health probe verifies)',
			);
		if (
			typeof row.name === "string" &&
			row.name.toLowerCase().startsWith("local-") &&
			provider !== "local"
		)
			throw new Error(
				"plaid_routes: a local-* route name is reserved for provider local (honesty law)",
			);
	}
	const routes = parsePlaidRoutes(value);
	if (
		routes === PLAID_ROUTES ||
		new Set(routes.map((route) => route.name)).size !== routes.length
	)
		throw new Error("plaid_routes: invalid or duplicate route identities");
	return routes;
}
