// kev-pair-admission.e2e.ts — W2777 co-situated proof: a HUBLESS lane (no
// .prefer hub=, no policy hub) has kev pick the (model, hub) PAIR across
// all machine-conf hubs under per-hub load; the chosen hub MOVES the
// destination (pick.hub) so the wire/served gates grade the real hub.
// Kev is stubbed at the /v1/systemone seam; the hub catalog rides
// test-kit serveStub; the conf survey reads the scratch settings.json.
import { scratchWorld, serveStub } from "@klh/test-kit";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { RouteAdmission } from "../scripts/lib/dispatch-admission.ts";
import { unknownEndpoints } from "../scripts/lib/lane-wire.ts";
import { openStore } from "../hooks/lib/govdb/govdb.ts";
import { admitModel } from "../hooks/lib/fleet-loop/model-admission.ts";

const world = scratchWorld({ prefix: "w2777-pair-" });
const realHome = process.env.HOME;
process.env.HOME = world.home;
const KEV = "SUSPENDERS_KEV_URL";
let savedKev: string | undefined;

const catalog = (ids: string[]) => (_req: Request) =>
	Response.json({ object: "list", data: ids.map((id) => ({ id })) });

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

const pickOf = (model: string | null, hub: string | null = null) => ({
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
	modelPin: null,
});

test.beforeAll(() => {
	savedKev = process.env[KEV];
});
test.afterAll(() => {
	if (savedKev === undefined) delete process.env[KEV];
	else process.env[KEV] = savedKev;
	process.env.HOME = realHome;
	world.clean();
});

test("admitModel: hubless lane — kev picks the PAIR, the chosen hub moves the destination @unit", async () => {
	const hubNas = serveStub(catalog(["glm-5.3", "glm-5.3-flash"]));
	const kev = serveStub(kevAnswer("glm-5.3-flash@nas"));
	process.env[KEV] = kev.url;
	process.env.SUSPENDERS_BUCKLE_FRONT = hubNas.url;
	// scratch settings.json declares hub nas with the stub url — the conf
	// survey source AND the served-models gate resolution target.
	const settings = join(world.home, ".config", "klh", "settings.json");
	mkdirSync(dirname(settings), { recursive: true });
	writeFileSync(
		settings,
		JSON.stringify({ hubs: { nas: { url: hubNas.url } } }),
	);
	let store: ReturnType<typeof openStore> | null = null;
	try {
		store = openStore();
		const out = await admitModel({
			store,
			project: "w2777-proj",
			sid: "w2777-kev",
			item: "W2777T",
			pick: pickOf(null, null),
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
			hubPick: null,
		});
		expect(out.verdict).toBe("proceed");
		if (out.verdict === "proceed") {
			expect(out.pick.model).toBe("glm-5.3-flash");
			expect(out.pick.hub).toBe("nas");
			expect(out.kevPick?.hub).toBe("nas");
			expect(out.kevPick?.reason).toContain("across");
		}
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		try {
			store?.close();
		} catch {}
		hubNas.close();
		kev.close();
	}
});

test("admitModel: hubless lane with every catalog down — static pick, destination unmoved @unit", async () => {
	const kev = serveStub(kevAnswer("glm-5.3@nas"));
	process.env[KEV] = kev.url;
	const settings = join(world.home, ".config", "klh", "settings.json");
	writeFileSync(
		settings,
		JSON.stringify({ hubs: { nas: { url: "https://dead.invalid" } } }),
	);
	let store: ReturnType<typeof openStore> | null = null;
	try {
		store = openStore();
		const out = await admitModel({
			store,
			project: "w2777-proj",
			sid: "w2777-kev",
			item: "W2777D",
			pick: pickOf(null, null),
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
			hubPick: null,
		});
		expect(out.verdict).toBe("proceed");
		if (out.verdict === "proceed") {
			expect(out.pick.hub).toBeNull();
			expect(out.kevPick?.hub).toBeUndefined();
			expect(out.kevPick?.reason).toContain("no hub serves a live catalog");
		}
	} finally {
		try {
			store?.close();
		} catch {}
		kev.close();
	}
});
