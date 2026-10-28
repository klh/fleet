// src/endpoints.ts — W914 front-door parity: the explicit, versioned
// endpoint registry. Every path buckle serves is declared here — method,
// kind, lane-prefix eligibility, and the context-injection verdict with its
// recorded reason (aids apply only to semantically supported text/model
// requests; opaque/binary paths carry an explicit no-injection reason).
// Unregistered paths are rejected (buckle.no_route); LiteLLM
// admin/credential-management routes (e.g. /key/*, /model/info,
// /v1/models/{id} admin variants) are deliberately absent — private by
// omission, never wildcard-opened. W912 landed: /v1/responses is served at
// this head, so the registry carries no pending rows — the pending404 wire
// contract stays wired for the next pending registration.

/** Registry contract version — bump on breaking shape changes. */
export const REGISTRY_VERSION = 1;

/** The dispatch tier for a registered ingress path:
 *  - dialect: rides the existing proxy() ladder (model-bearing JSON).
 *  - passthrough: the litellm-ops byte-faithful pass-through (opaque,
 *    multipart/binary, or model-less envelopes — files, batches, audio
 *    multipart). */
export type EndpointDispatch = "dialect" | "passthrough";

export type EndpointKind = "ingress" | "observability" | "public" | "admin";

export interface EndpointSpec {
	method: "GET" | "POST";
	/** Literal path, or an {id} template for parametric entries. */
	path: string;
	/** Anchored matcher for template entries; required iff path has {..}. */
	pattern?: RegExp;
	kind: EndpointKind;
	/** How the entry dispatches. Absent = not dispatched here (public/
	 *  observability/admin surfaces served elsewhere). */
	dispatch?: EndpointDispatch;
	/** Ingress dialect for dispatch:"dialect" entries (proxy() leg). */
	dialect?: "openai" | "anthropic";
	/** /w/<slug> ingress applies (attribution only — never widens surface:
	 *  admin/public entries are lane:false). */
	lane: boolean;
	/** Context-injection verdict: semantic = the aid pass may rewrite the
	 *  body; none = no injection, and `why` records the reason. */
	injection: "semantic" | "none";
	/** Required when injection === "none" (registry contract test pins it). */
	why?: string;
	/** Registered but the handler lands elsewhere (versioned, not served —
	 *  the wire answers pending404 instead of advertising). */
	pending?: string;
}

/** W914 registry v1 — the one front-door table (handlers + OPTIONS/405
 *  introspection derive from it; LiteLLM admin/credential routes are
 *  absent = private). Order matters for template entries: longest first,
 *  so /v1/files/{id}/content wins over /v1/files/{id}. */
export const ENDPOINTS: EndpointSpec[] = [
	// ── dialect ingress (proxy() ladder) ──────────────────────────────
	{
		method: "POST",
		path: "/v1/messages",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "anthropic",
		lane: true,
		injection: "semantic",
	},
	{
		method: "POST",
		path: "/v1/messages/count_tokens",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "anthropic",
		lane: true,
		injection: "none",
		why: "token count only — no generative output; an aid rewrite corrupts a count-only body",
	},
	{
		method: "POST",
		path: "/v1/chat/completions",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "openai",
		lane: true,
		injection: "semantic",
	},
	{
		method: "POST",
		path: "/v1/responses",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "openai",
		lane: true,
		injection: "semantic",
	},
	// ── litellm ops, JSON + model-bearing (proxy() ladder) ───────────
	{
		method: "POST",
		path: "/v1/completions",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "openai",
		lane: true,
		injection: "none",
		why: "legacy prompt-shape body — the aid pass speaks messages[] only",
	},
	{
		method: "POST",
		path: "/v1/embeddings",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "openai",
		lane: true,
		injection: "none",
		why: "non-generative — vectors over client text; context injection is inapplicable",
	},
	{
		method: "POST",
		path: "/v1/rerank",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "openai",
		lane: true,
		injection: "none",
		why: "non-generative — relevance ranking; context injection is inapplicable",
	},
	{
		method: "POST",
		path: "/v1/moderations",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "openai",
		lane: true,
		injection: "none",
		why: "non-generative — classification only; context injection is inapplicable",
	},
	{
		method: "POST",
		path: "/v1/images/generations",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "openai",
		lane: true,
		injection: "none",
		why: "media path — image bytes out; the aid pass speaks chat text only",
	},
	{
		method: "POST",
		path: "/v1/audio/speech",
		kind: "ingress",
		dispatch: "dialect",
		dialect: "openai",
		lane: true,
		injection: "none",
		why: "media path — audio bytes out; the aid pass speaks messages[] chat bodies only",
	},
	{
		method: "POST",
		path: "/v1/audio/transcriptions",
		kind: "ingress",
		dispatch: "passthrough",
		lane: true,
		injection: "none",
		why: "multipart/binary — opaque bytes in, text out; no injection into opaque bodies",
	},
	{
		method: "POST",
		path: "/v1/audio/translations",
		kind: "ingress",
		dispatch: "passthrough",
		lane: true,
		injection: "none",
		why: "multipart/binary — opaque bytes in; no injection into opaque bodies",
	},
	{
		method: "POST",
		path: "/v1/images/edits",
		kind: "ingress",
		dispatch: "passthrough",
		lane: true,
		injection: "none",
		why: "multipart/binary — opaque bytes in; no injection into opaque bodies",
	},
	{
		method: "POST",
		path: "/v1/files",
		kind: "ingress",
		dispatch: "passthrough",
		lane: true,
		injection: "none",
		why: "multipart upload — opaque file bytes; no model text rides the envelope",
	},
	{
		method: "POST",
		path: "/v1/batches",
		kind: "ingress",
		dispatch: "passthrough",
		lane: true,
		injection: "none",
		why: "async job envelope — no generative text rides the envelope",
	},
	{
		method: "GET",
		path: "/v1/files",
		kind: "ingress",
		dispatch: "passthrough",
		lane: true,
		injection: "none",
		why: "file listing — no model text rides a listing fetch",
	},
	{
		method: "GET",
		path: "/v1/batches",
		kind: "ingress",
		dispatch: "passthrough",
		lane: true,
		injection: "none",
		why: "batch listing — async jobs, no model text in a listing",
	},
	{
		method: "GET",
		path: "/v1/models",
		kind: "observability",
		lane: true,
		injection: "none",
		why: "model listing — introspection, no model invocation",
	},
	{
		method: "GET",
		path: "/v1/endpoints",
		kind: "observability",
		lane: true,
		injection: "none",
		why: "this registry — introspection, no model invocation",
	},
	{
		method: "GET",
		path: "/health",
		kind: "public",
		lane: false,
		injection: "none",
		why: "liveness literal — pre-gate, no model plane",
	},
	{
		method: "GET",
		path: "/.well-known/jwks.json",
		kind: "public",
		lane: false,
		injection: "none",
		why: "public key set — pre-cred spoke bootstrap, no model plane",
	},
	{
		method: "GET",
		path: "/status",
		kind: "public",
		lane: false,
		injection: "none",
		why: "servicemon telemetry — served outside the app router",
	},
	{
		method: "GET",
		path: "/metrics",
		kind: "public",
		lane: false,
		injection: "none",
		why: "servicemon telemetry — served outside the app router",
	},
	{
		method: "GET",
		path: "/federation",
		kind: "public",
		lane: false,
		injection: "none",
		why: "hub/spoke federation seam — deliberate auth handling, no model plane",
	},
	{
		method: "POST",
		path: "/aids/preseed",
		kind: "observability",
		lane: false,
		injection: "none",
		why: "knowledge-aid metering surface — no model invocation",
	},
	{
		method: "GET",
		path: "/aids/status",
		kind: "observability",
		lane: false,
		injection: "none",
		why: "knowledge-aid metering surface — no model invocation",
	},
	{
		method: "GET",
		path: "/aids/rollup",
		kind: "observability",
		lane: false,
		injection: "none",
		why: "knowledge-aid metering surface — no model invocation",
	},
	{
		method: "GET",
		path: "/aids/events",
		kind: "observability",
		lane: false,
		injection: "none",
		why: "knowledge-aid metering surface — no model invocation",
	},
	{
		method: "POST",
		path: "/pipeline/in",
		kind: "observability",
		lane: false,
		injection: "none",
		why: "prompt-pipeline sidestore — no model invocation",
	},
	{
		method: "GET",
		path: "/repo-policy/manifest",
		kind: "observability",
		lane: false,
		injection: "none",
		why: "repo-policy gate surface — no model invocation",
	},
	{
		method: "POST",
		path: "/repo-policy/check",
		kind: "observability",
		lane: false,
		injection: "none",
		why: "repo-policy gate surface — no model invocation",
	},
	{
		method: "GET",
		path: "/v1/admin/keys",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "credential management — private, gate-administered",
	},
	{
		method: "POST",
		path: "/v1/admin/keys",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "credential management — private, gate-administered",
	},
	{
		method: "POST",
		path: "/v1/admin/keys/verify",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "credential management — private, gate-administered",
	},
	{
		method: "GET",
		path: "/v1/admin/teams",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "credential management — private, gate-administered",
	},
	{
		method: "POST",
		path: "/v1/admin/teams",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "credential management — private, gate-administered",
	},
	{
		method: "GET",
		path: "/v1/admin/spokes",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "spoke fleet management — private, gate-administered",
	},
	{
		method: "POST",
		path: "/v1/admin/spokes/enroll",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "spoke fleet management — private, gate-administered",
	},
	{
		method: "GET",
		path: "/v1/admin/requests",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "per-request audit inspection — private, gate-administered",
	},
	{
		method: "GET",
		path: "/v1/admin/budgets",
		kind: "admin",
		lane: false,
		injection: "none",
		why: "budget administration — private, gate-administered",
	},
];

/** Parametric entries: anchored patterns, longest first (content before
 *  bare id), compiled once. */
const PARAM_ENDPOINTS: { spec: EndpointSpec; re: RegExp }[] = [
	{
		spec: {
			method: "GET",
			path: "/v1/files/{id}/content",
			kind: "ingress",
			dispatch: "passthrough",
			lane: true,
			injection: "none",
			why: "binary file content — opaque bytes; no injection into opaque paths",
		},
		re: /^\/v1\/files\/[^/]+\/content$/,
	},
	{
		spec: {
			method: "GET",
			path: "/v1/files/{id}",
			kind: "ingress",
			dispatch: "passthrough",
			lane: true,
			injection: "none",
			why: "file metadata — no model text rides a metadata fetch",
		},
		re: /^\/v1\/files\/[^/]+$/,
	},
	{
		spec: {
			method: "GET",
			path: "/v1/batches/{id}",
			kind: "ingress",
			dispatch: "passthrough",
			lane: true,
			injection: "none",
			why: "async job status — no model text rides a status fetch",
		},
		re: /^\/v1\/batches\/[^/]+$/,
	},
	{
		spec: {
			method: "GET",
			path: "/pipeline/in/{rid}",
			kind: "observability",
			lane: false,
			injection: "none",
			why: "prompt-pipeline sidestore — no model invocation",
		},
		re: /^\/pipeline\/in\/[^/]+$/,
	},
	{
		spec: {
			method: "GET",
			path: "/diet/{rid}",
			kind: "observability",
			lane: false,
			injection: "none",
			why: "trajectory-pruning sidestore — no model invocation",
		},
		re: /^\/diet\/[^/]+$/,
	},
	{
		spec: {
			method: "POST",
			path: "/v1/admin/keys/{id}/revoke",
			kind: "admin",
			lane: false,
			injection: "none",
			why: "credential management — private, gate-administered",
		},
		re: /^\/v1\/admin\/keys\/[0-9a-f]{12}\/revoke$/,
	},
];

/** W918 contract: per-agent wire compatibility — the agent recipes' native
 *  paths this gateway governs (src/agents.ts is the recipe source: claude =
 *  anthropic wire, codex/copilot = openai wire). Status derives from the
 *  registry's pending flags: any pending governed path demotes the agent to
 *  "partial" (codex rode /v1/responses — served since W912 landed) so CLI
 *  lanes can read their governance coverage live off this document. */
const AGENT_WIRES: {
	agent: string;
	wire: "anthropic" | "openai";
	governed_paths: string[];
}[] = [
	{
		agent: "claude",
		wire: "anthropic",
		governed_paths: ["/v1/messages", "/v1/messages/count_tokens"],
	},
	{
		agent: "codex",
		wire: "openai",
		governed_paths: ["/v1/chat/completions", "/v1/responses"],
	},
	{
		agent: "copilot",
		wire: "openai",
		governed_paths: ["/v1/chat/completions"],
	},
];

export interface RegistryDoc {
	registry_version: number;
	service: string;
	agents: {
		agent: string;
		wire: string;
		governed_paths: string[];
		status: string;
		note?: string;
	}[];
	endpoints: {
		method: string;
		path: string;
		kind: EndpointKind;
		lane: boolean;
		injection: "semantic" | "none";
		why?: string;
		status: string;
	}[];
}

interface AgentWireRow {
	agent: string;
	wire: string;
	governed_paths: string[];
	status: string;
	note?: string;
}

function rowOf(e: EndpointSpec) {
	return {
		method: e.method,
		path: e.path,
		kind: e.kind,
		lane: e.lane,
		injection: e.injection,
		...(e.why === undefined ? {} : { why: e.why }),
		status: e.pending === undefined ? "served" : `pending:${e.pending}`,
	};
}

function pendingByPath(): Map<string, string> {
	const m = new Map<string, string>();
	for (const e of [...ENDPOINTS, ...PARAM_ENDPOINTS.map((p) => p.spec)]) {
		if (e.pending !== undefined) m.set(e.path, e.pending);
	}
	return m;
}

/** Registry v1 render: the document GET /v1/endpoints serves — versioned,
 *  explicit, with no-injection reasons in the payload itself. */
export function registryDocument(): RegistryDoc {
	const rows = rowOf;
	const pendings = pendingByPath();
	const agents = AGENT_WIRES.map((a) => {
		const pendingRows = a.governed_paths
			.map((p) => pendings.get(p))
			.filter((w): w is string => w !== undefined);
		return {
			agent: a.agent,
			wire: a.wire,
			governed_paths: a.governed_paths,
			status: pendingRows.length === 0 ? "full" : "partial",
			...(pendingRows.length === 0
				? {}
				: { note: `pending: ${pendingRows.join(", ")}` }),
		} satisfies AgentWireRow;
	});
	return {
		registry_version: REGISTRY_VERSION,
		service: "buckle",
		agents,
		endpoints: [...ENDPOINTS, ...PARAM_ENDPOINTS.map((p) => p.spec)].map(rows),
	};
}

/** (method, path) → spec, or null = unregistered (404 territory). Literal
 *  table first, then the anchored parametric patterns (longest-first
 *  order preserved from the array). */
export function matchEndpoint(
	method: string,
	path: string,
): EndpointSpec | null {
	for (const e of ENDPOINTS) {
		if (e.path === path && e.method === method) return e;
	}
	for (const p of PARAM_ENDPOINTS) {
		if (p.re.test(path) && p.spec.method === method) return p.spec;
	}
	return null;
}

/** Every method the registry declares for a path (allowOf derivation:
 *  OPTIONS/405 introspection off the ONE table). */
export function methodsOf(path: string): string[] {
	const out: string[] = [];
	for (const e of ENDPOINTS) {
		if (e.path === path) out.push(e.method);
	}
	for (const p of PARAM_ENDPOINTS) {
		if (p.re.test(path)) out.push(p.spec.method);
	}
	return out;
}
