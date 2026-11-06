// kev-model-pick.e2e.ts — W2677 co-situated proof: a bare `.prefer
// hub=<label>` lane has KEV pick its model from the hub's LIVE /v1/models
// offerings (owner directive 2026-11-03) — the static default_models chain
// becomes the deterministic safety net, never the final answer. Proven at
// three depths: the picker itself (offerings → typed choice → fallback),
// admitModel end-to-end (the pick MOVES the launch model + renders the
// audit + brief line), and the picked-by vocabulary the dispatch table
// renders. Kev is stubbed at the /v1/systemone seam (kevTypedDecision
// contract); the hub catalog rides test-kit serveStub.
import { scratchWorld, serveStub } from "@klh/test-kit";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { RouteAdmission } from "../scripts/lib/dispatch-admission.ts";
import {
	chosenExecutor,
	chosenExecutorLine,
} from "../scripts/lib/dispatch-executor-note.ts";
import { unknownEndpoints } from "../scripts/lib/lane-wire.ts";
import { openStore } from "../hooks/lib/govdb/govdb.ts";
import type { HubLocation } from "../hooks/lib/hub/hub-locate.ts";
import { admitModel } from "../hooks/lib/fleet-loop/model-admission.ts";
import {
	kevModelBriefLines,
	kevModelNote,
	kevModelOptions,
	kevModelPick,
	kevPairFallback,
	kevPairKey,
	kevPairOptions,
	kevPairPick,
} from "../hooks/lib/fleet-loop/kev-model-pick.ts";
import type { HubSurvey } from "../hooks/lib/fleet-loop/kev-hub-survey.ts";

const surveyOf = (
	label: string,
	offerings: string[] | null,
	latencyMs = 100,
): HubSurvey => ({ label, url: `https://${label}.test`, offerings, latencyMs });

const world = scratchWorld({ prefix: "w2677-kev-" });
const realHome = process.env.HOME;
process.env.HOME = world.home;
// scratch HOME isolates settings.json (no hubs → the static-rung lookup
// reads an empty hub table) and pins kev at a stub we control per-test.
const KEV = "SUSPENDERS_KEV_URL";
let savedKev: string | undefined;

const catalog = (ids: string[]) => (_req: Request) =>
	Response.json({ object: "list", data: ids.map((id) => ({ id })) });

/** A pick shaped like execPick's return — only the fields the gates read. */
const pickOf = (
	model: string | null,
	hub: string | null = null,
	modelPin: unknown = null,
) => ({
	name: "claude",
	agent: "claude",
	model,
	bin: "claude",
	hub,
	hubUrls: [] as string[],
	fallbackModels: [] as string[],
	chainLen: 1,
	chainIdx: 0,
	preference: { source: "default" as const, directive: null, line: null },
	modelPin,
});

const resolveAt =
	(url: string) =>
	async (label: string): Promise<HubLocation | null> =>
		label === "ikea" ? { label: "ikea", url, via: "test" } : null;

/** Declare hubs.<label>.default_models in the scratch settings.json — the
 *  static safety net kev's pick falls back to (settings.json is the live
 *  hub source; stackFromSettings projects it into tryLoadStack). */
const declareHubChain = (models: string[]): void => {
	const settings = join(world.home, ".config", "klh", "settings.json");
	mkdirSync(dirname(settings), { recursive: true });
	writeFileSync(
		settings,
		JSON.stringify({ hubs: { ikea: { default_models: models } } }),
	);
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

test("kevModelOptions: caps and dedupes the catalog, order kept @unit", () => {
	expect(kevModelOptions(["glm-5.3", "glm-5.3", "a", "b"])).toEqual([
		"glm-5.3",
		"a",
		"b",
	]);
	expect(
		kevModelOptions(Array.from({ length: 20 }, (_, i) => `m-${i}`)),
	).toHaveLength(12);
});

test("kevModelPick: kev chooses a served offering; exact wire id, reason names kev @unit", async () => {
	const hub = serveStub(catalog(["glm-5.3", "glm-5.3-flash", "gpt-6-sol"]));
	const kev = serveStub((_req) =>
		Response.json({
			model: "kev-latest",
			answers: {
				d: {
					choice: "gpt-6-sol",
					confidence: 0.9,
					probabilities: { "gpt-6-sol": 0.9, "glm-5.3": 0.1 },
				},
			},
			usage: { input_tokens: 10, output_tokens: 5 },
			latency_ms: 1,
		}),
	);
	process.env[KEV] = kev.url;
	try {
		const out = await kevModelPick({
			hubPick: "ikea",
			model: null,
			state: "item W1: port a router",
			resolve: resolveAt(hub.url),
		});
		expect(out?.via).toBe("kev");
		expect(out?.model).toBe("gpt-6-sol");
		expect(out?.reason).toContain("kev");
		expect(out?.offerings).toEqual(["glm-5.3", "glm-5.3-flash", "gpt-6-sol"]);
	} finally {
		hub.close();
		kev.close();
	}
});

test("kevModelPick: kev down → deterministic fallback; static rung stands when served @unit", async () => {
	// settings.json (scratch HOME) declares the hub's static chain — the
	// W2637 default_models head this pick must fall back to.
	declareHubChain(["glm-5.3", "glm-5.3-flash"]);
	const hub = serveStub(catalog(["glm-5.3", "glm-5.3-flash"]));
	const kev = serveStub(() => new Response("nope", { status: 500 }));
	process.env[KEV] = kev.url;
	try {
		const out = await kevModelPick({
			hubPick: "ikea",
			// static chain head — the hub serves it, so it stands
			model: "glm-5.3",
			resolve: resolveAt(hub.url),
		});
		expect(out?.via).toBe("fallback");
		expect(out?.model).toBe("glm-5.3");
		expect(out?.reason).toContain("serves static default");
		// a static rung the hub does NOT serve yields to the live head
		const stale = await kevModelPick({
			hubPick: "ikea",
			model: "glm-9",
			resolve: resolveAt(hub.url),
		});
		expect(stale?.model).toBe("glm-5.3");
		expect(stale?.reason).toContain("catalog order");
	} finally {
		hub.close();
		kev.close();
	}
});

test("kevModelPick: unknown never blocks — catalog down and unresolvable hub fall back @unit", async () => {
	const dead = serveStub(() => new Response("x", { status: 500 }));
	const kev = serveStub((_req) => new Response("gone", { status: 503 }));
	process.env[KEV] = kev.url;
	try {
		const down = await kevModelPick({
			hubPick: "ikea",
			model: "glm-5.3-flash",
			resolve: resolveAt(dead.url),
		});
		expect(down?.via).toBe("fallback");
		expect(down?.model).toBe("glm-5.3-flash");
		expect(down?.reason).toContain("catalog unavailable");
		const lost = await kevModelPick({
			hubPick: "nowhere",
			model: null,
			resolve: async () => null,
		});
		expect(lost?.via).toBe("fallback");
		expect(lost?.reason).toContain("unresolvable");
	} finally {
		dead.close();
		kev.close();
	}
});

test("admitModel: bare hub= lane — kev pick MOVES the model, rides audit + brief + NOTE @unit", async () => {
	const hub = serveStub(catalog(["glm-5.3", "glm-5.3-flash", "gpt-6-sol"]));
	const kev = serveStub((_req) =>
		Response.json({
			model: "kev-latest",
			answers: {
				d: {
					choice: "glm-5.3",
					confidence: 0.8,
					probabilities: { "glm-5.3": 0.8, "gpt-6-sol": 0.2 },
				},
			},
			usage: { input_tokens: 10, output_tokens: 5 },
			latency_ms: 1,
		}),
	);
	process.env[KEV] = kev.url;
	// the W2572 gate validates against the same hub catalog — which serves
	// kev's choice, so the moved model must pass it end-to-end.
	process.env.SUSPENDERS_BUCKLE_FRONT = hub.url;
	let store: ReturnType<typeof openStore> | null = null;
	try {
		store = openStore();
		const routeAdmission = new RouteAdmission(
			false,
			async () => null,
			() => null,
		);
		const out = await admitModel({
			store,
			project: "w2677-proj",
			sid: "w2677-kev",
			item: "W2677T",
			pick: pickOf(null, "ikea"),
			bin: "/usr/local/bin/claude",
			routePin: undefined,
			posture: "steady",
			quota: new Map(),
			wireEndpoints: unknownEndpoints,
			routeName: null,
			routeAdmission,
			governanceRefusals: [],
			launchWaits: [],
			hubPick: "ikea",
			kevResolve: resolveAt(hub.url),
		});
		expect(out.verdict).toBe("proceed");
		if (out.verdict === "proceed") {
			expect(out.pick.model).toBe("glm-5.3");
			expect(out.pick.preference.audit).toContain("kev-chooses: glm-5.3");
			expect(out.kevPick?.model).toBe("glm-5.3");
			// the brief line the lane reads
			const kevPick = out.kevPick;
			expect(kevPick).not.toBeNull();
			if (kevPick) {
				const lines = kevModelBriefLines(kevPick);
				expect(lines[0]).toContain("kev");
				expect(lines[0]).toContain("glm-5.3");
				expect(lines[0]).toContain("safety net");
				// and the dispatch NOTE vocabulary
				expect(kevModelNote("W2677T", kevPick)).toContain("kev-chooses W2677T");
			}
			// the picked-by column names the chooser, not a static line
			const chosen = chosenExecutor({
				item: "W2677T",
				pick: out.pick,
				hub: "ikea",
				route: null,
				routing: undefined,
				repo: "/r",
			});
			expect(chosenExecutorLine(chosen)).toContain("picked-by=kev-chooses");
		}
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		try {
			store?.close();
		} catch {}
		hub.close();
		kev.close();
	}
});

test("admitModel: a dotfile model pin is owner intent — kev never consulted @unit", async () => {
	let kevAsked = 0;
	const hub = serveStub(catalog(["glm-5.3"]));
	const kev = serveStub((_req) => {
		kevAsked++;
		return new Response("x", { status: 500 });
	});
	process.env[KEV] = kev.url;
	process.env.SUSPENDERS_BUCKLE_FRONT = hub.url;
	let store: ReturnType<typeof openStore> | null = null;
	try {
		store = openStore();
		const out = await admitModel({
			store,
			project: "w2677-proj",
			sid: "w2677-kev",
			item: "W2677P",
			pick: pickOf("glm-5.3", "ikea", {
				file: "/repo/.prefer",
				line: 2,
				key: "model",
				target: "glm-5.3",
			}),
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
			hubPick: "ikea",
			kevResolve: resolveAt(hub.url),
		});
		expect(out.verdict).toBe("proceed");
		if (out.verdict === "proceed") {
			expect(out.pick.model).toBe("glm-5.3");
			expect(out.kevPick).toBeUndefined();
		}
		expect(kevAsked).toBe(0);
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		try {
			store?.close();
		} catch {}
		hub.close();
		kev.close();
	}
});

const kevAnswer =
	(choice: string, confidence = 0.9) =>
	(_req: Request) =>
		Response.json({
			model: "kev-latest",
			answers: {
				d: { choice, confidence, probabilities: { [choice]: confidence } },
			},
			usage: { input_tokens: 10, output_tokens: 5 },
			latency_ms: 1,
		});

test("kevPairOptions: down hubs drop, penalized excluded, dupes kept @unit", () => {
	const surveys = [
		surveyOf("nas", ["glm-5.3", "glm-5.3-flash"]),
		surveyOf("zai", ["glm-5.3", "gpt-6-sol"], 40),
		surveyOf("dead", null),
		surveyOf("empty", []),
	];
	const out = kevPairOptions(surveys, (m) => m === "glm-5.3-flash");
	expect(out.excluded).toBe(1);
	expect(out.options).toEqual([
		{ model: "glm-5.3", hub: "nas" },
		{ model: "glm-5.3", hub: "zai" },
		{ model: "gpt-6-sol", hub: "zai" },
	]);
	expect(kevPairKey(out.options[1])).toBe("glm-5.3@zai");
});

test("kevPairPick: kev picks the (model, hub) PAIR — reason names both @unit", async () => {
	const kev = serveStub(kevAnswer("gpt-6-sol@zai"));
	process.env[KEV] = kev.url;
	try {
		const out = await kevPairPick({
			state: "item W1: port a router",
			model: "glm-5.3",
			survey: async () => [
				surveyOf("nas", ["glm-5.3", "glm-5.3-flash"]),
				surveyOf("zai", ["glm-5.3", "gpt-6-sol"], 40),
			],
		});
		expect(out.via).toBe("kev");
		expect(out.model).toBe("gpt-6-sol");
		expect(out.hub).toBe("zai");
		expect(out.reason).toContain("gpt-6-sol@zai");
	} finally {
		kev.close();
	}
});

test("kevPairPick: kev down → static default stands on fastest serving hub @unit", async () => {
	const kev = serveStub(() => new Response("x", { status: 500 }));
	process.env[KEV] = kev.url;
	try {
		const out = await kevPairPick({
			state: "item W1",
			model: "glm-5.3-flash",
			survey: async () => [
				surveyOf("nas", ["glm-5.3", "glm-5.3-flash"], 200),
				surveyOf("zai", ["glm-5.3"], 40),
			],
		});
		expect(out.via).toBe("fallback");
		expect(out.model).toBe("glm-5.3-flash");
		expect(out.hub).toBe("nas");
		expect(out.reason).toContain("fastest serving hub nas");
	} finally {
		kev.close();
	}
});

test("kevPairPick: no live hub — static pick stands, hub undefined @unit", async () => {
	const kev = serveStub(kevAnswer("glm-5.3@nas"));
	process.env[KEV] = kev.url;
	try {
		const out = await kevPairPick({
			state: "item W1",
			model: "glm-5.3",
			survey: async () => [surveyOf("nas", null), surveyOf("zai", [])],
		});
		expect(out.via).toBe("fallback");
		expect(out.model).toBe("glm-5.3");
		expect(out.hub).toBeUndefined();
		expect(out.reason).toContain("no hub serves a live catalog");
	} finally {
		kev.close();
	}
});

test("kevPairFallback: fastest hub head when the static model is unserved @unit", () => {
	const out = kevPairFallback(
		[surveyOf("nas", ["glm-5.3"], 200), surveyOf("zai", ["gpt-6-sol"], 40)],
		"glm-9",
	);
	expect(out?.hub).toBe("zai");
	expect(out?.model).toBe("gpt-6-sol");
});
