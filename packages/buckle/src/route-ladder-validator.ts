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
}

export interface LiteLlmRouteConfig {
	id: string;
	origins: string[];
	config: unknown;
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
		| "invalid_config";
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
					else services.set(origin, { layer, id: item.id });
				}
			}
	}
	const link = (
		from: string,
		rawUrl: string,
		model: string,
		requireService = false,
	) => {
		const origin = originOf(rawUrl);
		if (!origin) {
			finding("invalid_config", "fleet", from, `invalid target URL ${rawUrl}`);
			return;
		}
		const service = services.get(origin);
		if (!service) {
			if (requireService || (localUrl(rawUrl) && !terminals.has(origin)))
				finding(
					"unmapped_local_target",
					"fleet",
					from,
					`target ${origin} has no config in this snapshot`,
				);
			return;
		}
		const to = `${service.layer}:${service.id}:${model}`;
		addEdge(from, to);
	};
	for (const buckle of inputs.buckles) {
		const groups = new Set(buckle.pool.groups());
		for (const group of groups) {
			const node = `buckle:${buckle.id}:${group}`;
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
					const target = services.get(originOf(dep.url) ?? "");
					if (
						target?.layer === "litellm" &&
						dep.adapter_config?.proxy_kind !== "litellm"
					)
						finding(
							"invalid_config",
							"buckle",
							node,
							`deployment ${dep.url} targets configured LiteLLM ${target.id} without adapter_config.proxy_kind: litellm`,
						);
					link(node, dep.url, dep.model ?? rung, dep.buckle === true);
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
			addNode(node);
			const params = recordOf(row?.litellm_params);
			if (typeof params?.api_base === "string") {
				const upstreamModel =
					typeof params.model === "string"
						? params.model.replace(/^[^/]+\//, "")
						: group;
				link(node, params.api_base, upstreamModel);
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
	const visit = (node: string, path: string[]) => {
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
		seen.add(node);
		stack.add(node);
		for (const next of edges.get(node) ?? []) visit(next, [...path, node]);
		stack.delete(node);
	};
	for (const node of edges.keys()) visit(node, []);
	return { errors, checkedNodes: edges.size };
}
