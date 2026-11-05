// test/prefer-pick-matrix.e2e.ts — W2767: the owner's R1–R7 permutation
// matrix for .prefer model/hub routing, pinned end-to-end per row: a real
// scratch .prefer tree → preferOf/execPick (scripts/lib/exec-chain.ts) →
// admitModel (hooks/lib/fleet-loop/model-admission.ts kev-chooses
// engagement) → kevModelPick (hooks/lib/fleet-loop/kev-model-pick.ts), with
// the routing plane (scripts/lib/prefer-routing.ts) riding R6. Kev is
// stubbed at the SUSPENDERS_KEV_URL seam, the hub catalog at serveStub
// (kev-model-pick.e2e.ts precedent).
//
// OWNER CONTRACT (work item W2767, authoritative rows):
//  R1  hub=<label> + NO model pin + kev reachable → kev chooses from the
//      hub's LIVE /v1/models offerings (picked-by=kev-chooses).
//  R2  hub=<label> + NO model + kev absent/unreachable → the hub's static
//      default stands (every hub always has a default).
//  R3  any explicit model pin = owner intent; kev never consulted.
//  R4  hub-url= without hub= is NOT a standalone pin — default ladder,
//      hub=-, URLs still ride (W1470: hub-url rides with its hub).
//  R5  W1470 nearest-file walk: per key, the nearest file wins; ranks
//      order the chain (nearer file first, later line within a file).
//  R6  JSON overlay = posture plane only (both planes ignore it);
//      key=value lines are the executor plane, quoted values the routing
//      plane.
//  R7  can=/must=/prefer= model keys ALWAYS win; kev-chooses engages ONLY
//      when the chain carries no model key at all.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { RouteAdmission } from "../scripts/lib/dispatch-admission.ts";
import {
	chosenExecutor,
	chosenExecutorLine,
} from "../scripts/lib/dispatch-executor-note.ts";
import { execPick, preferOf } from "../scripts/lib/exec-chain.ts";
import { unknownEndpoints } from "../scripts/lib/lane-wire.ts";
import { resolveRoutingPrefer } from "../scripts/lib/prefer-routing.ts";
import { openStore } from "../hooks/lib/govdb/govdb.ts";
import type { HubLocation } from "../hooks/lib/hub/hub-locate.ts";
import { admitModel } from "../hooks/lib/fleet-loop/model-admission.ts";

const world = scratchWorld({ prefix: "w2767-matrix-" });
const realHome = process.env.HOME;
process.env.HOME = world.home;
// scratch HOME isolates settings.json + suspenders-board.json: one known
// hub (ikea) with a static default_models chain (the R2 safety net) and a
// deterministic one-entry default ladder for the unpinned rows.
const KEV = "SUSPENDERS_KEV_URL";
let savedKev: string | undefined;

const HUB_DEFAULTS = ["glm-5.3", "gpt-6-sol"];
const settings = join(world.home, ".config", "klh", "settings.json");
mkdirSync(join(settings, ".."), { recursive: true });
writeFileSync(
	settings,
	JSON.stringify({ hubs: { ikea: { default_models: HUB_DEFAULTS } } }),
);
const boardSettings = join(
	world.home,
	".claude",
	"local-llm",
	"suspenders-board.json",
);
mkdirSync(join(boardSettings, ".."), { recursive: true });
writeFileSync(boardSettings, JSON.stringify({ default_executors: ["claude"] }));

const catalog = (ids: string[]) => (_req: Request) =>
	Response.json({ object: "list", data: ids.map((id) => ({ id })) });
const CATALOG = ["glm-5.3-flash", "glm-5.3", "gpt-6-sol"];

/** kev typed-choice stub answering `choice` (kevTypedDecision contract). */
const kevAnswering = (choice: string) =>
	serveStub((_req) =>
		Response.json({
			model: "kev-latest",
			answers: {
				d: {
					choice,
					confidence: 0.9,
					probabilities: { [choice]: 0.9 },
				},
			},
			usage: { input_tokens: 10, output_tokens: 5 },
			latency_ms: 1,
		}),
	);

/** A scratch .prefer tree: `<base>/tree/.prefer` over `<base>/tree/repo`. */
const preferTree = (treeFile: string, repoFile: string | null): string => {
	const repo = join(
		world.repo,
		`t-${Math.random().toString(36).slice(2, 8)}`,
		"tree",
		"repo",
	);
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(repo, "..", ".prefer"), treeFile);
	if (repoFile !== null) writeFileSync(join(repo, ".prefer"), repoFile);
	return repo;
};

const resolveAt =
	(url: string) =>
	async (label: string): Promise<HubLocation | null> =>
		label === "ikea" ? { label: "ikea", url, via: "test" } : null;

/** execPick on a scratch repo, then admitModel over the REAL pick — the
 *  one seam the matrix rows assert engagement through. */
const admit = async (o: {
	item: string;
	repo: string;
	hubPick?: string | null;
	cvOf?: Map<string, number>;
	kevResolve?: (label: string, oneOff: string[]) => Promise<HubLocation | null>;
}): Promise<{
	pick: ReturnType<typeof execPick>;
	verdict: string;
	kevPick?: { model: string; via: string; reason: string };
}> => {
	const pick = execPick(0, o.repo, o.cvOf, new Map());
	const store = openStore();
	try {
		const out = await admitModel({
			store,
			project: "w2767-matrix",
			sid: "w2767-matrix",
			item: o.item,
			pick,
			bin: "/usr/local/bin/claude",
			routePin: undefined,
			posture: "steady",
			quota: new Map(),
			wireEndpoints: unknownEndpoints,
			routeName: null,
			routeAdmission: new RouteAdmission(
				false,
				async () => null,
				() => null,
			),
			governanceRefusals: [],
			launchWaits: [],
			...(o.hubPick !== undefined ? { hubPick: o.hubPick } : {}),
			...(o.kevResolve ? { kevResolve: o.kevResolve } : {}),
		});
		expect(out.verdict).toBe("proceed");
		return out.verdict === "proceed"
			? { pick, verdict: out.verdict, kevPick: out.kevPick }
			: { pick, verdict: out.verdict };
	} finally {
		store.close();
	}
};

test.beforeAll(() => {
	savedKev = process.env[KEV];
});
test.afterAll(() => {
	if (savedKev === undefined) delete process.env[KEV];
	else process.env[KEV] = savedKev;
	process.env.HOME = realHome;
	world.clean();
});

test("R1 hub= + no model pin + kev reachable → kev-chooses from live offerings @unit", async () => {
	const hub = serveStub(catalog(CATALOG));
	const kev = kevAnswering("gpt-6-sol");
	process.env[KEV] = kev.url;
	process.env.SUSPENDERS_BUCKLE_FRONT = hub.url;
	try {
		const repo = preferTree("hub=ikea\n", null);
		const { pick, kevPick } = await admit({
			item: "W2767R1",
			repo,
			kevResolve: resolveAt(hub.url),
		});
		// execPick composed the static hub default; no model pin anywhere
		expect(pick.hub).toBe("ikea");
		expect(pick.model).toBe("glm-5.3");
		expect(pick.modelPin).toBeNull();
		expect(pick.preference.source).toBe("default");
		// kev examined the live catalog and moved the model
		expect(kevPick?.via).toBe("kev");
		expect(kevPick?.model).toBe("gpt-6-sol");
		expect(pick.model).toBe("glm-5.3"); // input pick unchanged…
		const line = chosenExecutorLine(
			chosenExecutor({
				item: "W2767R1",
				pick: {
					...pick,
					model: kevPick?.model,
					preference: {
						...pick.preference,
						audit: `kev-chooses: ${kevPick?.model} (kev)`,
					},
				},
				hub: pick.hub,
				route: null,
				routing: undefined,
				repo,
			}),
		);
		expect(line).toContain("picked-by=kev-chooses");
		expect(line).toContain("hub=ikea");
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		hub.close();
		kev.close();
	}
});

test("R2 hub= + no model + kev unreachable → the hub's static default stands @unit", async () => {
	const hub = serveStub(catalog(CATALOG));
	const kev = serveStub(() => new Response("down", { status: 500 }));
	process.env[KEV] = kev.url;
	process.env.SUSPENDERS_BUCKLE_FRONT = hub.url;
	try {
		const repo = preferTree("hub=ikea\n", null);
		const { pick, kevPick } = await admit({
			item: "W2767R2",
			repo,
			kevResolve: resolveAt(hub.url),
		});
		expect(pick.model).toBe("glm-5.3");
		expect(kevPick?.via).toBe("fallback");
		expect(kevPick?.model).toBe("glm-5.3");
		expect(kevPick?.reason).toContain("serves static default");
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		hub.close();
		kev.close();
	}
});

test("R3/R7 explicit model keys win — must=/prefer=/can= never consult kev @unit", async () => {
	let kevAsked = 0;
	const hub = serveStub(catalog(CATALOG));
	const kev = serveStub((_req) => {
		kevAsked++;
		return new Response("x", { status: 500 });
	});
	process.env[KEV] = kev.url;
	process.env.SUSPENDERS_BUCKLE_FRONT = hub.url;
	try {
		const resolve = resolveAt(hub.url);
		// must=<full model> — owner intent, picked verbatim
		const must = preferTree("hub=ikea\nmust=glm-5.3\n", null);
		const mustPick = execPick(0, must);
		expect(mustPick.model).toBe("glm-5.3");
		expect(mustPick.modelPin?.key).toBe("must");
		expect(mustPick.preference.directive).toBe("must");
		// prefer=<full model> — same owner-intent law
		const pref = preferTree("hub=ikea\nprefer=glm-5.3-flash\n", null);
		const prefPick = execPick(0, pref);
		expect(prefPick.model).toBe("glm-5.3-flash");
		expect(prefPick.modelPin?.key).toBe("prefer");
		// can=<proven model> invalidates the must line and heads the chain
		const can = preferTree("hub=ikea\nmust=glm-9\ncan=glm-5.3\n", null);
		const canPick = execPick(0, can, new Map([["glm-5.3", 2]]));
		expect(canPick.model).toBe("glm-5.3");
		expect(canPick.modelPin?.key).toBe("can");
		expect(canPick.preference.can).toBe("active");
		// none of the three reached kev — admission runs on the must row
		const { kevPick } = await admit({
			item: "W2767R3",
			repo: must,
			kevResolve: resolve,
		});
		expect(kevPick).toBeUndefined();
		expect(kevAsked).toBe(0);
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		hub.close();
		kev.close();
	}
});

test("R7 contrapositive: executor-only chain (no model key) still engages kev @unit", async () => {
	const hub = serveStub(catalog(CATALOG));
	const kev = kevAnswering("glm-5.3");
	process.env[KEV] = kev.url;
	process.env.SUSPENDERS_BUCKLE_FRONT = hub.url;
	try {
		const repo = preferTree("hub=ikea\nmust=claude\n", null);
		const pick = execPick(0, repo);
		// a spawnable executor token carries NO model key: modelPin null
		expect(pick.preference.directive).toBe("must");
		expect(pick.modelPin).toBeNull();
		const { kevPick } = await admit({
			item: "W2767R7",
			repo,
			kevResolve: resolveAt(hub.url),
		});
		expect(kevPick?.via).toBe("kev");
		expect(kevPick?.model).toBe("glm-5.3");
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		hub.close();
		kev.close();
	}
});

test("R4 hub-url= alone is no hub pin — default ladder, hub=-, kev never asked @unit", async () => {
	let kevAsked = 0;
	const hub = serveStub(catalog(CATALOG));
	const kev = serveStub((_req) => {
		kevAsked++;
		return new Response("x", { status: 500 });
	});
	process.env[KEV] = kev.url;
	process.env.SUSPENDERS_BUCKLE_FRONT = hub.url;
	try {
		const repo = preferTree("hub-url=https://alt.example:4101\n", null);
		const { pick, kevPick } = await admit({
			item: "W2767R4",
			repo,
			hubPick: null,
		});
		// no hub label — the URLs ride, the pick falls to the default ladder
		expect(pick.hub).toBeNull();
		expect(pick.hubUrls).toEqual(["https://alt.example:4101"]);
		expect(pick.preference.source).toBe("default");
		expect(pick.modelPin).toBeNull();
		expect(kevPick).toBeUndefined();
		expect(kevAsked).toBe(0);
		// the live-evidence line: picked-by=default ladder … hub=-
		const line = chosenExecutorLine(
			chosenExecutor({
				item: "W2767R4",
				pick,
				hub: pick.hub,
				route: null,
				routing: undefined,
				repo,
			}),
		);
		expect(line).toContain("picked-by=default ladder");
		expect(line).toContain("hub=-");
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		hub.close();
		kev.close();
	}
});

test("R5 W1470 nearest-file walk: per key the nearest file wins; ranks order the chain @unit", () => {
	const repo = preferTree(
		"hub=ikea\nmust=glm-5.3\nmodel=glm-tree\n",
		"prefer=glm-5.3-flash\nmodel=glm-repo\n",
	);
	const merged = preferOf(repo);
	expect(merged.hub).toBe("ikea"); // tree file — the only hub=
	expect(merged.model).toBe("glm-repo"); // nearer file wins model=
	expect(merged.directives).toEqual([
		{
			value: "glm-5.3",
			kind: "must",
			line: 2,
			rank: 1,
			file: join(repo, "..", ".prefer"),
		},
		{
			value: "glm-5.3-flash",
			kind: "prefer",
			line: 1,
			rank: 0,
			file: `${repo}/.prefer`,
		},
	]);
	const head = execPick(0, repo);
	expect(head.preference.directive).toBe("prefer");
	expect(head.model).toBe("glm-5.3-flash");
	expect(head.modelPin?.key).toBe("prefer");
	// attempt 1 walks to the tree's must=; the same-bin tail rides --fallback-model
	const next = execPick(1, repo);
	expect(next.model).toBe("glm-5.3");
	expect(next.modelPin?.key).toBe("must");
	expect(head.fallbackModels).toEqual(["glm-5.3"]);
});

test("R6 JSON overlay is posture-only on both planes; quoted vs unquoted split them @unit", () => {
	const repo = preferTree('{"selection":{"posture":"minimal"}}', null);
	// executor plane: the overlay never becomes chain/hub garbage
	const chain = preferOf(repo);
	expect(chain.directives).toEqual([]);
	expect(chain.hub).toBeNull();
	expect(execPick(0, repo).preference.source).toBe("default");
	// routing plane: the overlay is not routing lines either
	expect(resolveRoutingPrefer(repo)).toEqual({
		prefer: null,
		must: null,
		mustSource: null,
		preferSource: null,
		errors: [],
	});
	// quoted key=value = routing plane only — the executor plane skips it
	writeFileSync(
		join(repo, ".prefer"),
		'must = "ikea llms"\nprefer="local distill"\n',
	);
	const routing = resolveRoutingPrefer(repo);
	expect(routing.must).toBe("ikea llms");
	expect(routing.prefer).toBe("local distill");
	const quoted = preferOf(repo);
	expect(quoted.directives).toEqual([]);
	expect(quoted.hub).toBeNull();
	// unquoted single token = executor plane only — routing skips it
	writeFileSync(join(repo, ".prefer"), "must=glm-5.3\n");
	expect(execPick(0, repo).model).toBe("glm-5.3");
	const plain = resolveRoutingPrefer(repo);
	expect(plain.must).toBeNull();
	expect(plain.prefer).toBeNull();
});
