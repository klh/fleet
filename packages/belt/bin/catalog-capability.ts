// bin/catalog-capability.ts — W258: per-machine model capability auto-assessment.
// Conservative-range predictions (magnitude shape) over the fleet catalog —
// registry.ts entries + remotes.json machines — upgrading the hand-measured
// routing table (docs/routing.md, measured on ONE machine 2026-09-04) with a
// per-machine forecast for every row the catalog knows.
//
// DOCTRINE (route-policy law): unproven is not fast. Predictions never outrank
// measured data — every row carries the conservative band [lo, hi] tok/s with
// the LOW end as the safe claim; measured avg_ms from metrics.db rides
// alongside when it exists; cloud rows stay unclocked (network-bound).
// Anchors: benchmarks.md §1 fleet medians (M5 Max 128GB, nonce-cold,
// single-stream): 4B→158.9, 9B→85.2, 30B-A3B→123.7, 35B-A3B→123.6,
// dense 27B→27.0, dense 27B-coder→89.3 — banded by ACTIVE parameters (MoE
// computes with its active slice; bands stay wide, the floor is the claim).
//
// CLI: catalog-capability.ts [--json] — markdown per-machine table (default)
// or the raw rows. The dashboard serves the same payload at GET /api/catalog.
import {
	loadStatic,
	type RemoteMachine,
	type RemoteEndpoint,
} from "./remotes.ts";
import { LOCAL_NAME, metricsFor } from "./metrics.ts";
import { registryEntries, type RegistryEntry } from "./registry.ts";

/** metrics.db is best-effort — a missing/unreadable db (fresh install,
 *  scratch HOME) reads as never-routed (null), never a crash. */
function measuredOf(
	machine: string,
	port: number,
	model: string,
): CapabilityRow["measured"] {
	try {
		const met = metricsFor(machine, port, model);
		return met.calls > 0 ? { avg_ms: met.avg_ms, calls: met.calls } : null;
	} catch {
		return null;
	}
}

// ─── model-id signature (pure, deterministic) ───
export type Purpose =
	| "code"
	| "reason"
	| "embed"
	| "re-rank"
	| "classify"
	| "vision"
	| "instruct"
	| "general";

export interface ModelSig {
	/** total parameters (billions); null = id carries no size marker */
	paramsB: number | null;
	/** MoE active parameters; null = dense (or unknown) */
	activeB: number | null;
	/** quantization tag from the id, lowercase (4bit, optiq, …) */
	quant: string | null;
	purposes: Purpose[];
}

/** "A3B" → 3 (MoE active slice); the params pass strips it first. */
const RE_ACTIVE = /a(\d+(?:\.\d+)?)b(?![a-z0-9])/i;
const RE_PARAMS = /(?<![a-z])(\d+(?:\.\d+)?)b(?![a-z0-9])/;
const RE_QUANT = /(4bit|5bit|6bit|8bit|optiq|gguf|q4_k|q8_0|int4|int8|dwq)/;

/** Parse a model id into its magnitude signature. Pure grammar — hostile
 *  input degrades to nulls (never throws, never guesses a size). */
export function parseModelSignature(id: string): ModelSig {
	const withoutActive = id.replace(RE_ACTIVE, "-");
	const params = [
		...withoutActive.matchAll(new RegExp(RE_PARAMS.source, "gi")),
	];
	const paramsB = params.length
		? Number.parseFloat(params[params.length - 1][1])
		: null;
	const active = RE_ACTIVE.exec(id);
	const activeB = active ? Number.parseFloat(active[1]) : null;
	const quant = RE_QUANT.exec(id.toLowerCase())?.[1] ?? null;
	const purposes = new Set<Purpose>();
	const add = (re: RegExp, p: Purpose): void => {
		if (re.test(id)) purposes.add(p);
	};
	add(/coder|codegen/i, "code");
	add(/reason|thinking/i, "reason");
	add(/embed/i, "embed");
	add(/rerank/i, "re-rank");
	add(/systemone|classify/i, "classify");
	add(/vision|-vl\b|-vl-|ocr/i, "vision");
	add(/instruct|chat|\bit\b|base\b/i, "instruct");
	if (purposes.size === 0) purposes.add("general");
	return { paramsB, activeB, quant, purposes: [...purposes] };
}

// ─── magnitude bands (tok/s, nonce-cold single-stream, the anchor machine) ───
export type SpeedBasis = "anchored" | "conservative" | "none";
export type DepthTier =
	| "menial"
	| "standard"
	| "heavy"
	| "frontier"
	| "special"
	| "unknown";

// Anchored bands keyed by ACTIVE parameter count. Dense rows use
// paramsB as active. Each band cites its benchmark.md §1 anchor(s).
const bandFor = (sig: ModelSig): [number, number] | null => {
	const active = sig.activeB ?? sig.paramsB;
	if (active === null) return null;
	if (sig.activeB !== null) {
		// MoE: 30B-A3B→123.7, 35B-A3B→123.6; capped below the small-dense
		// anchor (158.9) so more total params never outrank the small dense
		if (active <= 8) return [60, 155];
		return [20, 60]; // big-active MoE — unmeasured here, wide + low
	}
	// dense: 0.6B rerank…1B→[80,250]; 4B→158.9; 9B→85.2; 27B dense→22.7–27.0
	if (active <= 1) return [80, 250];
	if (active <= 5) return [80, 200];
	if (active <= 13) return [45, 120];
	if (active <= 40) return [15, 35];
	return null; // >40B dense never serves on the anchor machine class
};

/** Depth tier from total params — the quality ceiling the weights can reach
 *  (speed is the band's business). Rank-only rows (embed/rerank/classify —
 *  from the id OR the serving role) never claim a chat tier. */
export function depthTier(
	sig: ModelSig,
	cloud: boolean,
	roles: string | string[] = [],
): DepthTier {
	const list = Array.isArray(roles) ? roles : [roles];
	const special =
		sig.purposes.some(
			(p) => p === "embed" || p === "re-rank" || p === "classify",
		) || list.some((r) => ["embed", "rerank", "classify"].includes(r));
	if (special) return "special";
	if (sig.paramsB === null) return cloud ? "frontier" : "unknown";
	if (sig.paramsB <= 5) return "menial";
	if (sig.paramsB <= 15) return "standard";
	if (sig.paramsB <= 40) return "heavy";
	return "frontier";
}

// ─── rows ───
export interface CapabilityRow {
	machine: string;
	kind: "local" | "remote" | "cloud";
	port: number | null;
	model: string;
	roles: string[];
	good_at: string;
	paramsB: number | null;
	activeB: number | null;
	quant: string | null;
	depth: DepthTier;
	speed_range: [number, number] | null;
	speed_basis: SpeedBasis;
	/** real traffic metrics when the endpoint has been routed to (null = never) */
	measured: { avg_ms: number; calls: number } | null;
	context_tokens: number | null;
	confidence: "anchored" | "low";
	source: "registry" | "remotes.json";
}

/** Assess one registry entry (local machine). */
export function assessRegistryEntry(e: RegistryEntry): CapabilityRow {
	const sig = parseModelSignature(e.model);
	const special =
		sig.purposes.some(
			(p) => p === "embed" || p === "re-rank" || p === "classify",
		) || ["embed", "rerank", "classify"].includes(e.role);
	const band = special ? null : bandFor(sig);
	const met = measuredOf(LOCAL_NAME, e.port, e.model);
	return {
		machine: LOCAL_NAME,
		kind: "local",
		port: e.port,
		model: e.model,
		roles: [e.role],
		good_at: e.good_at,
		paramsB: sig.paramsB,
		activeB: sig.activeB,
		quant: sig.quant,
		depth: depthTier(sig, false, [e.role]),
		speed_range: band,
		speed_basis: band === null ? "none" : "anchored",
		measured: met,
		context_tokens: e.contextTokens,
		confidence: band === null && sig.paramsB === null ? "low" : "anchored",
		source: "registry",
	};
}

/** Assess one remotes.json endpoint row. LAN machines have unverified
 *  hardware → the band floor halves (conservative); cloud rows are
 *  network-bound (no single-machine tok/s claim at all). */
export function assessRemoteEndpoint(
	m: RemoteMachine,
	ep: RemoteEndpoint,
): CapabilityRow {
	const sig = parseModelSignature(ep.model ?? "");
	const cloud = m.cloud === true;
	const special =
		sig.purposes.some(
			(p) => p === "embed" || p === "re-rank" || p === "classify",
		) || ["embed", "rerank", "classify"].some((r) => ep.roles.includes(r));
	const raw = special ? null : bandFor(sig);
	const band =
		raw === null || raw === undefined
			? null
			: cloud
				? null
				: ([Math.round(raw[0] / 2), raw[1]] as [number, number]);
	const model = ep.model ?? `(roles: ${ep.roles.join(", ")})`;
	const met = measuredOf(m.name, ep.port, ep.model ?? "");
	return {
		machine: m.name,
		port: ep.port,
		kind: cloud ? "cloud" : "remote",
		model,
		roles: ep.roles,
		good_at: ep.roles.join(", "),
		paramsB: sig.paramsB,
		activeB: sig.activeB,
		quant: sig.quant,
		depth: depthTier(sig, cloud, ep.roles),
		speed_range: band,
		speed_basis: raw === null ? "none" : cloud ? "none" : "conservative",
		measured: met,
		context_tokens: null,
		confidence: "low",
		source: "remotes.json",
	};
}

/** The whole-fleet forecast: registry rows for this machine + one row per
 *  remotes.json endpoint. Injection params keep tests in-process-safe. */
export function capabilityRows(
	entries?: RegistryEntry[],
	machines?: RemoteMachine[],
): CapabilityRow[] {
	const locals = (entries ?? registryEntries()).map(assessRegistryEntry);
	const remotes = (machines ?? loadStatic()).flatMap((m) =>
		m.endpoints.map((ep) => assessRemoteEndpoint(m, ep)),
	);
	return [...locals, ...remotes];
}

export interface CapabilityPayload {
	ts: string;
	doctrine: string[];
	rows: CapabilityRow[];
}

/** The doctrine lines every surface (CLI, dashboard) states with the rows. */
export const CAPABILITY_DOCTRINE: string[] = [
	"Predicted magnitude bands [lo, hi] tok/s, nonce-cold single-stream — the LOW end is the safe claim (route-policy law: unproven is not fast).",
	"Anchors: benchmarks.md §1 fleet medians (M5 Max 128GB): 4B→158.9, 9B→85.2, 30B-A3B→123.7, 35B-A3B→123.6, dense 27B→22.7–27.0 tok/s.",
	"Remote LAN rows halve the floor — hardware is unverified; cloud rows are network-bound and carry no single-machine tok/s claim.",
	"Verdicts are decision-grade measurements and live in benchmarks.md — this forecast never overrides a measured row.",
];

export function capabilityPayload(
	entries?: RegistryEntry[],
	machines?: RemoteMachine[],
): CapabilityPayload {
	return {
		ts: new Date().toISOString(),
		doctrine: CAPABILITY_DOCTRINE,
		rows: capabilityRows(entries, machines),
	};
}

// ─── markdown rendering — the routing-table upgrade view ───
const range = (r: [number, number] | null): string =>
	r === null ? "—" : `${r[0]}–${r[1]}`;
const measured = (m: CapabilityRow["measured"]): string =>
	m === null ? "—" : `${m.avg_ms}ms avg / ${m.calls} calls`;
const roles = (r: string[]): string => r.join(", ");

export function renderMarkdown(p: CapabilityPayload): string {
	const out: string[] = [
		"# Fleet capability forecast — per machine (predicted, conservative)",
		"",
		...p.doctrine.map((d) => `- ${d}`),
		"",
	];
	const machines = [...new Set(p.rows.map((r) => r.machine))];
	for (const machine of machines) {
		const rows = p.rows.filter((r) => r.machine === machine);
		const kind = rows[0]?.kind ?? "local";
		out.push(`## ${machine} (${kind})`, "");
		out.push(
			"| model | roles | depth | predicted tok/s | context | measured | confidence |",
		);
		out.push("|---|---|---|---|---|---|---|");
		for (const r of rows) {
			out.push(
				`| ${r.model} | ${roles(r.roles)} | ${r.depth} | ${range(r.speed_range)} | ${
					r.context_tokens ?? "—"
				} | ${measured(r.measured)} | ${r.confidence} |`,
			);
		}
		out.push("");
	}
	return out.join("\n");
}

// ─── CLI ───
const isCli = process.argv[1]?.endsWith("catalog-capability.ts") === true;

if (isCli) {
	const payload = capabilityPayload();
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(payload, null, "\t"));
	} else {
		console.log(renderMarkdown(payload));
	}
}
