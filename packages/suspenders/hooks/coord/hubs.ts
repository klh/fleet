// hooks/coord/hubs.ts — `coord hubs` (W356): the hub topology read verb.
// Merges the two operator configs — the label→candidates lookup
// (~/.claude/local-llm/hubs.json, what resolveHub walks) and the deploy
// truth (~/.config/klh/stack.yaml, what hubctl renders) — and health-probes
// every declared candidate so lanes and users SEE the topology instead of
// guessing which label reaches what. Read-only: probes, never mutates.
//   coord hubs [--label name] [--json]
import { arg, die, dim, green, red } from "./shared.ts";
import { alive, readRegistry, REGISTRY_PATH } from "../lib/hub-locate.ts";
import { loadStack, STACK_PATH, type HubProfile } from "../lib/stack-config.ts";

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
				source: `stack.yaml ${svc}`,
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
 *  labels, resolveHub precedent). stack.yaml first (the truth), then
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
	} catch {} // missing/unparseable stack.yaml = a registry-only machine
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

export async function cmdHubs(rest: string[]): Promise<void> {
	const wantLabel = arg("--label");
	const asJson = rest.includes("--json");
	const { labels, candidates, stackLoaded } = hubTopology();
	if (wantLabel && !labels.has(wantLabel.toLowerCase()))
		die(
			`hub "${wantLabel}" not in hubs.json or stack.yaml — known: ${[...labels.values()].join(", ") || "none"}`,
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
		console.log(
			JSON.stringify({
				hubs: probed,
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
			dim("no hubs declared — hubs.json and stack.yaml missing or empty"),
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
