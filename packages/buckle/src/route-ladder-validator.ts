// A static, config-derived view of nested routing. Buckle's own fallback
// list is a bounded walk; only a deployment into another service (or an
// inner LiteLLM fallback) creates a recursive edge.
import type { GatewayPolicy } from "./policy.ts";
import type { UpstreamPool } from "./upstreams.ts";

export interface BuckleRouteConfig {
	id: string;
	origins: string[];
	policy: GatewayPolicy;
	pool: UpstreamPool;
	/** W1094: loopback leaves THIS pool's own inventory declares (a hub's
	 * rendered ollama/swarm rows) — resolved on that device, exempt from the
	 * local-unmapped check. Committed-base specialist rows are NOT terminals:
	 * owner law routes local models via Belt (trace b73f8a2d, review #55637). */
	terminals?: string[];
}

export interface LiteLlmRouteConfig {
	id: string;
	origins: string[];
	config: unknown;
	/** W1094: true = the origin is a known engine but this snapshot holds NO
	 *  config proof (a hub-side engine seen from the Mac). Rows targeting it
	 *  are reported unverified_engine — never silently green, never failed
	 *  on checks the absent config cannot answer. */
	unverified?: boolean;
	/**
	 * Deployment URLs the buckle front serves through this engine (W1094):
	 * a row pointing at a litellm origin must declare
	 * `adapter_config.proxy_kind: "litellm"` — without it the front's
	 * x-litellm-num-retries / stream-timeout headers never reach the engine,
	 * so its fallbacks stay unbounded. Rows that do NOT name a litellm origin
	 * must NOT carry the kind (a wrong marker routes a plain provider as an
	 * engine and strands the ladder).
	 */
	litellmOriginUrls?: string[];
}

export interface BeltRouteConfig {
	id: string;
	origins: string[];
	/** Configured local serving endpoint for a model-preserving Belt proxy. */
	upstream?: string;
	escalation?: { url: string; model: string };
	/** Request model IDs for which the Belt ingress never enters its cloud leg. */
	noEscalationModels?: string[];
}

export interface RouteLadderInputs {
	buckles: BuckleRouteConfig[];
	litellms?: LiteLlmRouteConfig[];
	belts?: BeltRouteConfig[];
	/** Local models and other leaf endpoints declared by the serving registry. */
	terminalOrigins?: string[];
	/** The real client's end-to-end deadline, when one is known. */
	requestDeadlineMs?: number;
	/** Effective selections from Fleet's execPick, in its own directive order. */
	laneSelections?: Array<{ path: string; model: string }>;
}

export interface RouteLadderFinding {
	code:
		| "cycle"
		| "unmapped_local_target"
		| "missing_fallback"
		| "unroutable_group"
		| "deadline_budget"
		| "missing_proxy_kind"
		| "unknown_engine_model"
		| "invalid_config"
		/** W1094: one bounded ladder revisits an origin it already walked —
		 *  the live walk re-enters a rate-limited origin (trace audit #55796:
		 *  429 twice on one origin, then twice on the next). */
		| "repeat_origin"
		/** W1094: a group name that asserts a model family is served by a
		 *  primary deployment of a DIFFERENT family — a pinned gpt-6-sol
		 *  request silently rides zai-glm (trace audit #55799). */
		| "model_family_mismatch"
		/** W1094 unverified face — reported, never silently green, non-gating
		 *  (the proof lives on another device). */
		| "unverified_engine"
		| "unverified_target"
		| "unverified_catalog";
	layer: "buckle" | "litellm" | "belt" | "fleet";
	path: string;
	detail: string;
}

type Layer = RouteLadderFinding["layer"];
type Target = { layer: Layer; id: string };

function originOf(raw: string): string | null {
	try {
		return new URL(raw).origin;
	} catch {
		return null;
	}
}

function localUrl(raw: string): boolean {
	try {
		const host = new URL(raw).hostname.toLowerCase();
		return (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "[::1]" ||
			host.endsWith(".local") ||
			/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
		);
	} catch {
		return false;
	}
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

// W1094 model-family preflight (#55799): the family token a group name or
// model id asserts — the first alpha segment that is not a provider prefix.
// "gpt-6-sol" → gpt · "zai-glm-5.3-flash" → glm · "claude-sonnet-5" →
// claude. Unmatched names derive nothing (no family asserted → no check).
const PROVIDER_PREFIXES = new Set([
	"openai",
	"anthropic",
	"azure",
	"bedrock",
	"vertex",
	"openrouter",
	"zai",
	"github",
	"copilot",
	"litellm",
	"aws",
	"google",
	"groq",
	"together",
	"fireworks",
	"dashscope",
	"local",
]);

/** The asserted model family of a group/model name, or null when the name
 *  derives nothing (unknown tokens, bare ids). */
export function familyOf(name: string): string | null {
	for (const token of name.toLowerCase().split(/[-._/]/)) {
		if (!/^[a-z]+$/.test(token) || PROVIDER_PREFIXES.has(token)) continue;
		return token;
	}
	return null;
}

function fallbackRows(value: unknown): Record<string, string[]> {
	const rows: Record<string, string[]> = {};
	const entries = Array.isArray(value) ? value : [value];
	for (const entry of entries) {
		const doc = recordOf(entry);
		if (!doc) continue;
		for (const [group, targets] of Object.entries(doc)) {
			if (Array.isArray(targets))
				rows[group] = targets.filter(
					(target): target is string => typeof target === "string",
				);
		}
	}
	return rows;
}

export function validateRouteLadders(inputs: RouteLadderInputs): {
	errors: RouteLadderFinding[];
	checkedNodes: number;
} {
	const errors: RouteLadderFinding[] = [];
	const services = new Map<string, Target>();
	// W1094 repeat_origin: prefix (layer:id) -> the origins that serve it.
	// The walk flags a RE-ingress: leaving a service and entering it again
	// later in one walk is the recursive gateway visit owner law forbids.
	const serviceOrigins = new Map<string, Set<string>>();
	// Full node string -> its service prefix (ids embed ":port", so the
	// prefix cannot be re-derived from the node by splitting).
	const nodePrefix = new Map<string, string>();
	const terminals = new Set(
		(inputs.terminalOrigins ?? [])
			.map(originOf)
			.filter((origin): origin is string => origin !== null),
	);
	const edges = new Map<string, Set<string>>();
	const addNode = (node: string) => {
		if (!edges.has(node)) edges.set(node, new Set());
	};
	const addEdge = (from: string, to: string) => {
		addNode(from);
		addNode(to);
		edges.get(from)?.add(to);
	};
	const finding = (
		code: RouteLadderFinding["code"],
		layer: Layer,
		path: string,
		detail: string,
	) => {
		errors.push({ code, layer, path, detail });
	};
	for (const [layer, list] of [
		["buckle", inputs.buckles],
		["litellm", inputs.litellms ?? []],
		["belt", inputs.belts ?? []],
	] as const) {
		for (const item of list)
			for (const raw of item.origins) {
				const origin = originOf(raw);
				if (!origin)
					finding(
						"invalid_config",
						layer,
						item.id,
						`invalid service origin ${raw}`,
					);
				else {
					const previous = services.get(origin);
					if (previous && (previous.layer !== layer || previous.id !== item.id))
						finding(
							"invalid_config",
							layer,
							item.id,
							`service origin ${origin} is ambiguous with ${previous.layer}:${previous.id}`,
						);
					else {
						services.set(origin, { layer, id: item.id });
						const prefix = `${layer}:${item.id}`;
						const known = serviceOrigins.get(prefix);
						if (known) known.add(origin);
						else serviceOrigins.set(prefix, new Set([origin]));
					}
				}
			}
	}
	// W1094 engine-kind preflight: a deployment into a litellm origin must
	// declare adapter_config.proxy_kind=litellm — without it the front's
	// x-litellm-num-retries / stream-timeout headers are inert and the
	// engine's own fallbacks stay unbounded. The effective wire model
	// (dep.model ?? group — the id the front sends the engine) must exist in
	// the engine's model_list; engine rows unreferenced by buckle are fine
	// (broad catalogs).
	const engineOrigins = new Set<string>();
	for (const lite of inputs.litellms ?? [])
		for (const origin of lite.origins.map(originOf))
			if (origin !== null) engineOrigins.add(origin);
	// W1094: a hub-side engine this snapshot has no config for is reported
	// unverified, not silently treated as configured.
	const unverifiedEngines = new Set<string>();
	for (const lite of inputs.litellms ?? []) {
		if (!lite.unverified) continue;
		for (const origin of lite.origins.map(originOf))
			if (origin !== null) unverifiedEngines.add(origin);
	}
	const engineModels = new Map<string, Set<string>>();
	for (const lite of inputs.litellms ?? []) {
		if (lite.unverified) continue;
		const doc = recordOf(lite.config);
		const rows = Array.isArray(doc?.model_list) ? doc?.model_list : [];
		const names = new Set<string>();
		for (const row of rows.map(recordOf))
			if (typeof row?.model_name === "string") names.add(row.model_name);
		for (const origin of lite.origins.map(originOf))
			if (origin !== null) engineModels.set(origin, names);
	}
	for (const buckle of inputs.buckles) {
		for (const rung of buckle.pool.groups()) {
			for (const dep of buckle.pool.deployments(rung)) {
				const origin = originOf(dep.url);
				const kind = recordOf(dep.adapter_config)?.proxy_kind;
				if (origin !== null && unverifiedEngines.has(origin)) {
					finding(
						"unverified_engine",
						"buckle",
						`buckle:${buckle.id}:${rung}`,
						`engine row ${origin} has no config in this snapshot — membership unverified`,
					);
					continue;
				}
				if (origin !== null && engineOrigins.has(origin)) {
					if (kind !== "litellm")
						finding(
							"missing_proxy_kind",
							"buckle",
							`buckle:${buckle.id}:${rung}`,
							`engine row ${origin} lacks adapter_config.proxy_kind=litellm`,
						);
					else {
						const names = engineModels.get(origin);
						if (names && !names.has(dep.model ?? rung))
							finding(
								"unknown_engine_model",
								"buckle",
								`buckle:${buckle.id}:${rung}`,
								`engine wire model ${dep.model ?? rung} absent from the engine model_list`,
							);
					}
				} else if (kind === "litellm")
					finding(
						"invalid_config",
						"buckle",
						`buckle:${buckle.id}:${rung}`,
						`proxy_kind=litellm on a non-engine row ${origin ?? dep.url}`,
					);
			}
		}
	}
	const buckleGroups = new Map<string, Set<string>>();
	const perPoolTerminals = new Map<string, Set<string>>();
	for (const buckle of inputs.buckles) {
		buckleGroups.set(buckle.id, new Set(buckle.pool.groups()));
		perPoolTerminals.set(
			buckle.id,
			new Set(
				(buckle.terminals ?? [])
					.map(originOf)
					.filter((origin): origin is string => origin !== null),
			),
		);
	}
	const link = (
		from: string,
		rawUrl: string,
		model: string,
		requireService = false,
		poolTerminals?: Set<string>,
	) => {
		const origin = originOf(rawUrl);
		if (!origin) {
			finding("invalid_config", "fleet", from, `invalid target URL ${rawUrl}`);
			return;
		}
		const service = services.get(origin);
		if (!service) {
			// W1094: a loopback leaf the DECLARING pool's own inventory
			// renders (e.g. the hub's ollama) is resolved on that device;
			// a global terminal set would let one device's Belt vouch for
			// another's port (trace b73f8a2d, review #55637).
			const exempt = terminals.has(origin) || poolTerminals?.has(origin);
			if (requireService || (localUrl(rawUrl) && !exempt))
				finding(
					"unmapped_local_target",
					"fleet",
					from,
					`target ${origin} has no config in this snapshot`,
				);
			return;
		}
		// W1094: an inter-Buckle edge selects a GROUP on the target hub —
		// the model string must be a group that hub actually serves, or the
		// walk strands there (unroutable, not silently accepted).
		if (service.layer === "buckle" && !buckleGroups.get(service.id)?.has(model))
			finding(
				"unroutable_group",
				"fleet",
				from,
				`target buckle ${service.id} has no group ${model}`,
			);
		const to = `${service.layer}:${service.id}:${model}`;
		nodePrefix.set(to, `${service.layer}:${service.id}`);
		addEdge(from, to);
	};
	for (const buckle of inputs.buckles) {
		const groups = new Set(buckle.pool.groups());
		for (const group of groups) {
			const node = `buckle:${buckle.id}:${group}`;
			nodePrefix.set(node, `buckle:${buckle.id}`);
			addNode(node);
			const ladder = [group, ...(buckle.policy.fallbacks?.[group] ?? [])];
			let configured = 0;
			for (const rung of ladder) {
				if (!groups.has(rung)) {
					finding(
						"missing_fallback",
						"buckle",
						node,
						`fallback ${rung} has no group`,
					);
					continue;
				}
				for (const dep of buckle.pool.deployments(rung)) {
					configured++;
					// W1094 (#55799): the PRIMARY rung serves the group's own
					// asserted family — a pinned gpt-6-sol request must never
					// silently ride zai-glm. Fallback rungs may cross families.
					if (rung === group) {
						const asserted = familyOf(group);
						const served = familyOf(dep.model ?? rung);
						if (asserted && served && served !== asserted)
							finding(
								"model_family_mismatch",
								"buckle",
								node,
								`primary rung serves family ${served} for group ${group} (asserts ${asserted})`,
							);
					}
					link(
						node,
						dep.url,
						dep.model ?? rung,
						dep.buckle === true,
						perPoolTerminals.get(buckle.id),
					);
				}
			}
			if (configured === 0)
				finding(
					"unroutable_group",
					"buckle",
					node,
					"no configured deployment in bounded ladder",
				);
			const deadline = inputs.requestDeadlineMs;
			const firstByteBudget = buckle.policy.first_byte_budget_s ?? 240;
			const attemptTimeout = buckle.policy.request_timeout_s ?? 120;
			if (!Number.isFinite(firstByteBudget) || firstByteBudget < attemptTimeout)
				finding(
					"deadline_budget",
					"buckle",
					node,
					"first_byte_budget_s must cover one full request_timeout_s attempt",
				);
			if (deadline !== undefined && Number.isFinite(deadline) && deadline > 0) {
				const worstMs = firstByteBudget * 1000;
				if (worstMs > deadline)
					finding(
						"deadline_budget",
						"buckle",
						node,
						`${worstMs}ms configured upper bound exceeds ${deadline}ms client deadline`,
					);
			}
		}
	}
	for (const lite of inputs.litellms ?? []) {
		// W1094: an unverified engine carries NO config in this snapshot —
		// there is nothing to shape-check; its rows report unverified_engine
		// in the buckle loop above.
		if (lite.unverified) continue;
		const doc = recordOf(lite.config);
		const modelRows = doc?.model_list;
		if (!Array.isArray(modelRows)) {
			finding("invalid_config", "litellm", lite.id, "model_list is missing");
			continue;
		}
		const models = new Set<string>();
		for (const item of modelRows) {
			const row = recordOf(item);
			const group = row?.model_name;
			if (typeof group !== "string") continue;
			models.add(group);
			const node = `litellm:${lite.id}:${group}`;
			nodePrefix.set(node, `litellm:${lite.id}`);
			addNode(node);
			const params = recordOf(row?.litellm_params);
			if (typeof params?.api_base === "string") {
				const upstreamModel =
					typeof params.model === "string"
						? params.model.replace(/^[^/]+\//, "")
						: group;
				link(node, params.api_base, upstreamModel);
			}
			// W1094 (#55799): an engine row whose wire model serves a different
			// family than its group name asserts — the pinned request rides the
			// wrong family INSIDE the engine, where this ladder cannot see it.
			const wire = typeof params?.model === "string" ? params.model : null;
			if (wire !== null) {
				const asserted = familyOf(group);
				const served = familyOf(wire);
				if (asserted && served && served !== asserted)
					finding(
						"model_family_mismatch",
						"litellm",
						node,
						`engine row ${group} serves family ${served} (asserts ${asserted})`,
					);
			}
		}
		const settings = recordOf(doc?.litellm_settings);
		for (const kind of ["fallbacks", "context_window_fallbacks"] as const) {
			for (const [group, targets] of Object.entries(
				fallbackRows(settings?.[kind]),
			)) {
				const node = `litellm:${lite.id}:${group}`;
				if (!models.has(group))
					finding(
						"missing_fallback",
						"litellm",
						node,
						`${kind} source group absent from model_list`,
					);
				for (const target of targets) {
					if (!models.has(target))
						finding(
							"missing_fallback",
							"litellm",
							node,
							`${kind} target ${target} absent from model_list`,
						);
					else addEdge(node, `litellm:${lite.id}:${target}`);
				}
			}
		}
	}
	for (const belt of inputs.belts ?? []) {
		const prefix = `belt:${belt.id}:`;
		const localOnly = new Set(belt.noEscalationModels ?? []);
		if (belt.escalation) {
			const target = services.get(originOf(belt.escalation.url) ?? "");
			if (target?.layer !== "buckle")
				finding(
					"invalid_config",
					"belt",
					belt.id,
					`cloud escalation target ${belt.escalation.url} must be a configured Buckle gate`,
				);
		}
		for (const node of [...edges.keys()]) {
			if (!node.startsWith(prefix)) continue;
			if (belt.upstream) link(node, belt.upstream, node.slice(prefix.length));
			if (belt.escalation && !localOnly.has(node.slice(prefix.length)))
				link(node, belt.escalation.url, belt.escalation.model, true);
		}
	}
	for (const selection of inputs.laneSelections ?? []) {
		const configured = [...edges.keys()].some(
			(node) =>
				(node.startsWith("buckle:") || node.startsWith("litellm:")) &&
				node.endsWith(`:${selection.model}`),
		);
		if (!configured)
			finding(
				"unroutable_group",
				"fleet",
				selection.path,
				`effective selected model ${selection.model} has no configured route`,
			);
	}
	const seen = new Set<string>();
	const stack = new Set<string>();
	const visit = (node: string, path: string[], origins: string[]): void => {
		if (stack.has(node)) {
			const cycle = [...path.slice(path.indexOf(node)), node];
			finding(
				"cycle",
				cycle.every((part) => part.startsWith("litellm:"))
					? "litellm"
					: "fleet",
				node,
				cycle.join(" -> "),
			);
			return;
		}
		if (seen.has(node)) return;
		// W1094 repeat_origin (#55796): flag a RE-ingress — leaving a service
		// and entering it again later in one walk. Consecutive hops on the
		// same service are one visit (an engine's internal fallback list),
		// not a repeat.
		const prefix = nodePrefix.get(node);
		const own =
			prefix === undefined ? null : (serviceOrigins.get(prefix) ?? null);
		const last = origins[origins.length - 1];
		if (own !== null && own.size > 0 && !own.has(last)) {
			const repeated = [...own].find((origin) => origins.includes(origin));
			if (repeated !== undefined) {
				finding(
					"repeat_origin",
					"fleet",
					node,
					`walk re-enters ${repeated}: ${[...path, node].join(" -> ")}`,
				);
				return;
			}
		}
		seen.add(node);
		stack.add(node);
		const fresh = own === null ? [] : [...own].filter((o) => o !== last);
		for (const next of edges.get(node) ?? [])
			visit(next, [...path, node], [...origins, ...fresh]);
		stack.delete(node);
	};
	for (const node of edges.keys()) visit(node, [], []);
	return { errors, checkedNodes: edges.size };
}
