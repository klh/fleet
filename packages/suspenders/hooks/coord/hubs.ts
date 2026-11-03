// hooks/coord/hubs.ts — `coord hubs` (W356): the hub topology read verb.
// Merges the two operator configs — the label→candidates lookup
// (~/.claude/local-llm/hubs.json, what resolveHub walks) and the deploy
// truth (~/.config/klh/stack.json, what hubctl renders) — and health-probes
// every declared candidate so lanes and users SEE the topology instead of
// guessing which label reaches what. Read-only: probes, never mutates.
//   coord hubs [--label name] [--json]
// W2635: --json also carries each up hub's model offerings with the
// concurrency/connection numbers users map.prefer model pins against
// (hub= picks the hub, must=/prefer= picks the model; the numbers show
// whether a pin will queue or shed) — sourced from the hub buckle
// /v1/models face, which rides the router's admission pool snapshots.
import { arg, die, dim, green, red } from "./shared.ts";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { alive, readRegistry, REGISTRY_PATH } from "../lib/hub/hub-locate.ts";
import { loadStack, STACK_PATH, type HubProfile } from "../lib/stack-config.ts";

/** W2635: one model row from a hub's /v1/models face — the admission block
 *  is present only for models bound to an explicit provider pool. */
export interface HubModelRow {
	id: string;
	admission?: HubPoolNumbers;
}

export interface HubPoolNumbers {
	provider_pool: string;
	concurrency: number;
	concurrency_ceiling: number;
	outstanding: number;
	queued: number;
	active: number;
	max_outstanding: number;
	rate_per_interval: number;
	interval_ms: number;
}

/** W2635: hub-level pool aggregate — every member model shares one pool's
 *  admission, so the hub row names the pool once with its member models. */
export interface HubPoolRow extends HubPoolNumbers {
	models: string[];
}

type Registry = ReturnType<typeof readRegistry>;

interface Candidate {
	url: string;
	source: string;
	up: boolean;
	ms: number;
}

interface HubView {
	label: string;
	up: boolean;
	url: string | null;
	via: string | null;
	candidates: Candidate[];
}

// stack-declared service ports become candidates in this order — the buckle
// front is the hub's canonical door, health sidecars trail last
const PORT_FIELDS: Array<[keyof HubProfile, string]> = [
	["buckle_port", "buckle"],
	["board_port", "board"],
	["store_port", "store"],
	["belt_port", "belt"],
	["buckle_health_port", "buckle-health"],
	["board_health_port", "board-health"],
	["store_health_port", "store-health"],
	["belt_health_port", "belt-health"],
	["model_store_port", "model-store"],
	["model_store_health_port", "model-store-health"],
];

// stack host fields may carry an ssh user (kk@nas.example) — the contact
// address is the bare host
const hostOf = (hub: HubProfile): string =>
	(hub.host ?? "").replace(/^[^@]+@/, "");

const stackCandidates = (hub: HubProfile): Candidate[] => {
	const host = hostOf(hub);
	if (!host) return [];
	const out: Candidate[] = [];
	for (const [field, svc] of PORT_FIELDS) {
		const port = hub[field];
		if (typeof port === "number")
			out.push({
				url: `http://${host}:${port}`,
				source: `stack.json ${svc}`,
				up: false,
				ms: 0,
			});
	}
	return out;
};

const probe = async (c: Candidate): Promise<Candidate> => {
	const t0 = performance.now();
	const up = await alive(c.url);
	return { ...c, up, ms: Math.round(performance.now() - t0) };
};

/** Merge both configs into per-label candidate lists (case-insensitive
 *  labels, resolveHub precedent). stack.json first (the truth), then
 *  registry-only labels; registry candidates walk before stack-derived
 *  ones — same precedence the resolver uses. */
export function hubTopology(): {
	labels: Map<string, string>;
	candidates: Map<string, Candidate[]>;
	registry: Registry;
	stackLoaded: boolean;
} {
	const registry = readRegistry();
	let stackHubs: Record<string, HubProfile> = {};
	let stackLoaded = false;
	try {
		stackHubs = loadStack().hubs;
		stackLoaded = true;
	} catch {} // missing/unparseable stack.json = a registry-only machine
	const key = (l: string): string => l.toLowerCase();
	const labels = new Map<string, string>();
	const candidates = new Map<string, Candidate[]>();
	for (const [label, hub] of Object.entries(stackHubs)) {
		labels.set(key(label), label);
		candidates.set(key(label), stackCandidates(hub));
	}
	for (const [label, entry] of Object.entries(registry)) {
		const k = key(label);
		if (!labels.has(k)) labels.set(k, label);
		const regCands = entry.candidates?.map(
			(url): Candidate => ({ url, source: "hubs.json", up: false, ms: 0 }),
		);
		candidates.set(k, [...(regCands ?? []), ...(candidates.get(k) ?? [])]);
	}
	return { labels, candidates, registry, stackLoaded };
}

/** W2635: parse a hub /v1/models payload — unknown shapes degrade to a null
 *  listing (never guessed rows), malformed admission blocks are dropped
 *  (the row passes bare, the block never reaches HubModelRow). */
export function parseHubModels(payload: unknown): HubModelRow[] | null {
	const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(payload);
	if (!parsed.success) return null;
	const rows: HubModelRow[] = [];
	for (const entry of parsed.data.data) {
		// id alone admits a row; a malformed admission degrades to bare (the
		// block is advisory, the listing must never lose the model)
		const bare = z
			.object({ id: z.string().min(1), admission: z.unknown().optional() })
			.safeParse(entry);
		if (!bare.success) continue;
		const admission = hubPoolNumbersSchema
			.nullish()
			.safeParse(bare.data.admission);
		rows.push(
			admission.success && admission.data
				? { id: bare.data.id, admission: admission.data }
				: { id: bare.data.id },
		);
	}
	return rows;
}

/** W2635.1 (Schema law): the admission block shape a hub /v1/models row may
 *  carry — one zod source of truth instead of hand-cast property probes, so
 *  a wire-shape drift fails loud at parse, never silently coerces. */
const hubPoolNumbersSchema = z.object({
	provider_pool: z.string().min(1),
	concurrency: z.number(),
	concurrency_ceiling: z.number(),
	outstanding: z.number(),
	queued: z.number(),
	active: z.number(),
	max_outstanding: z.number(),
	rate_per_interval: z.number(),
	interval_ms: z.number(),
});

/** W2635: collapse model rows into hub-level pool aggregates — every member
 *  model of one pool reports identical numbers (they share one admission
 *  core), so the FIRST sighting is the aggregate; the pool id is the key,
 *  never a numbers hash (divergent copies under one id are a hub-side bug
 *  and stay collapsed into that one row — the source is one snapshot). */
export function poolRowsOf(models: HubModelRow[]): HubPoolRow[] {
	const pools = new Map<string, HubPoolRow>();
	for (const row of models) {
		const a = row.admission;
		if (!a) continue;
		const existing = pools.get(a.provider_pool);
		if (existing) {
			existing.models.push(row.id);
			continue;
		}
		const { provider_pool: id, ...numbers } = a;
		pools.set(id, { id, ...numbers, models: [row.id] });
	}
	return [...pools.values()];
}

/** Stack hub profiles by lowercased label (hubTopology's keying). */
function stackHubsByLabel(): Map<string, HubProfile> {
	const out = new Map<string, HubProfile>();
	try {
		for (const [label, hub] of Object.entries(loadStack().hubs))
			out.set(label.toLowerCase(), hub);
	} catch {} // unparseable stack.json already reported via stackLoaded=false
	return out;
}

/** W2635: fetch one up hub's model listing from its buckle front — the
 *  stack token_file is the credential (the belt hubProviderObservations
 *  precedent); no credential or unreachable face = null, never a guess. */
export async function fetchHubModels(
	base: string,
	tokenFile: string | undefined,
): Promise<HubModelRow[] | null> {
	if (!tokenFile) return null;
	try {
		const key = readFileSync(tokenFile, "utf8").trim();
		if (!key) return null;
		const response = await fetch(new URL("/v1/models", base), {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) return null;
		return parseHubModels(await response.json());
	} catch {
		return null;
	}
}

export async function cmdHubs(rest: string[]): Promise<void> {
	const wantLabel = arg("--label");
	const asJson = rest.includes("--json");
	const { labels, candidates, stackLoaded } = hubTopology();
	if (wantLabel && !labels.has(wantLabel.toLowerCase()))
		die(
			`hub "${wantLabel}" not in hubs.json or stack.json — known: ${[...labels.values()].join(", ") || "none"}`,
		);

	const probed: HubView[] = [];
	for (const [k, cands] of candidates) {
		if (wantLabel && k !== wantLabel.toLowerCase()) continue;
		const done: Candidate[] = [];
		for (const c of cands) done.push(await probe(c));
		const win = done.find((c) => c.up);
		probed.push({
			label: labels.get(k) ?? k,
			up: Boolean(win),
			url: win?.url ?? null,
			via: win?.source ?? null,
			candidates: done,
		});
	}

	if (asJson) {
		// W2635: each UP hub carries its model listing + pool aggregates in
		// parallel (bounded wait; a down hub or missing credential simply
		// reports models: null). The listing rides the BUCKLE front — the
		// first up hubs.json candidate or stack.json buckle port, never a
		// probe winner that happens to be the board/store.
		const stackHubs = stackHubsByLabel();
		const offerings = await Promise.all(
			probed.map(async (hub) => {
				const buckle = hub.candidates.find(
					(c) =>
						c.up &&
						(c.source === "hubs.json" || c.source === "stack.json buckle"),
				)?.url;
				if (!buckle) return null;
				const profile = stackHubs.get(hub.label.toLowerCase());
				return fetchHubModels(buckle, profile?.token_file);
			}),
		);
		const hubs = probed.map((hub, i) => {
			const models = offerings[i];
			return models === null || models === undefined
				? { ...hub, models: null, pools: [] }
				: { ...hub, models, pools: poolRowsOf(models) };
		});
		console.log(
			JSON.stringify({
				hubs,
				sources: {
					registry: REGISTRY_PATH(),
					stack: stackLoaded ? STACK_PATH() : null,
				},
			}),
		);
		return;
	}
	if (!probed.length) {
		console.log(
			dim("no hubs declared — hubs.json and stack.json missing or empty"),
		);
		return;
	}
	for (const h of probed) {
		const up = h.candidates.filter((c) => c.up).length;
		const dot = h.up ? green("●") : red("○");
		const head = h.up
			? `${dot} ${h.label} — ${h.url} (${h.via}) · ${up}/${h.candidates.length} up`
			: `${dot} ${h.label} — down · 0/${h.candidates.length} up`;
		console.log(head);
		for (const c of h.candidates)
			console.log(
				`  ${c.up ? green("✓") : dim("✗")} ${dim(`${c.url} — ${c.source} · ${c.ms}ms`)}`,
			);
	}
}
