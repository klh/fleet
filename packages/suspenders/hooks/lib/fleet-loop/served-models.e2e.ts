// served-models.e2e.ts — W2572 co-situated proof: dispatch-time
// served-model validation refuses a pick the DESTINATION does not serve
// (the W1.1 503-loop class) before any claim, client-agnostically, without
// bypass under SUSPENDERS_MODEL_HEALTH=0; unknown (catalog unreadable)
// never refuses. The destination rides test-kit serveStub (fake hub/belt
// /v1/models faces); admitModel is driven end-to-end so the gate order
// (after every model-mutating gate) is proven, not assumed.

import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { RouteAdmission } from "../../../scripts/lib/dispatch-admission.ts";
import { unknownEndpoints } from "../../../scripts/lib/lane-wire.ts";
import { openStore } from "../govdb/govdb.ts";
import type { HubLocation } from "../hub/hub-locate.ts";
import { admitModel } from "./model-admission.ts";
import { servedModelsGate, servedModelsVerdict } from "./served-models.ts";

const world = scratchWorld({ prefix: "w2572-served-" });
const realHome = process.env.HOME;
process.env.HOME = world.home;

const catalog = (ids: string[]) => (_req: Request) =>
	Response.json({ object: "list", data: ids.map((id) => ({ id })) });

/** A pick shaped like execPick's return — only the fields the gates read. */
const pickOf = (model: string | null, hub: string | null = null) => ({
	name: "claude",
	agent: "claude",
	model,
	bin: "claude",
	hub,
	hubUrls: [],
	fallbackModels: [],
	chainLen: 1,
	chainIdx: 0,
	preference: { source: "default" as const, directive: null, line: null },
});

test.afterAll(() => {
	process.env.HOME = realHome;
	world.clean();
});

test("servedModelsVerdict: class match, prefix fold, refusal excerpt @unit", () => {
	const served = ["glm-5.3", "zai-glm-5.3-flash", "gpt-6-sol"];
	expect(servedModelsVerdict("glm-5.3-flash", served)).toEqual({
		ok: true,
		servedBy: "zai-glm-5.3-flash",
	});
	expect(servedModelsVerdict("GLM.5.3", served)).toEqual({
		ok: true,
		servedBy: "glm-5.3",
	});
	const miss = servedModelsVerdict("claude-sonnet-5.5", served);
	expect(miss.ok).toBe(false);
	if (!miss.ok)
		expect(miss.why).toContain("served: glm-5.3, zai-glm-5.3-flash");
	// excerpt truncates long lists with the remainder count
	const many = Array.from({ length: 12 }, (_, i) => `m-${i}`);
	const cut = servedModelsVerdict("none", many);
	if (!cut.ok) expect(cut.why).toContain("(+4 more)");
});

test("servedModelsGate: belt-direct validates the spoke catalog (the W1.1 class) @unit", async () => {
	const spoke = serveStub(catalog(["gpt-6-sol"]));
	try {
		const pass = await servedModelsGate({
			model: "gpt-6-sol",
			hubPick: null,
			hubUrls: [],
			env: { SUSPENDERS_BUCKLE_FRONT: spoke.url },
		});
		expect(pass.verdict).toBe("pass");
		// the exact incident: a glm pin the destination never served
		const refused = await servedModelsGate({
			model: "glm-5.3-flash",
			hubPick: null,
			hubUrls: [],
			env: { SUSPENDERS_BUCKLE_FRONT: spoke.url },
		});
		expect(refused).toEqual({
			verdict: "refused",
			why: expect.stringContaining("does not serve glm-5.3-flash"),
		});
		if (refused.verdict === "refused")
			expect(refused.why).toContain("gpt-6-sol");
	} finally {
		spoke.close();
	}
});

test("servedModelsGate: hub= lanes validate the HUB's list; unresolvable label degrades to belt @unit", async () => {
	const hub = serveStub(catalog(["gpt-6-sol"]));
	const belt = serveStub(catalog(["glm-5.3-flash"]));
	const resolve = async (label: string): Promise<HubLocation | null> =>
		label === "ikea" ? { label: "ikea", url: hub.url, via: "test" } : null;
	try {
		// the IKEA incident shape: hub serves none of the glm family
		const refused = await servedModelsGate({
			model: "glm-5.3",
			hubPick: "ikea",
			hubUrls: [],
			env: { SUSPENDERS_BUCKLE_FRONT: belt.url },
			resolve,
		});
		expect(refused.verdict).toBe("refused");
		if (refused.verdict === "refused") {
			expect(refused.why).toContain("hub ikea");
			expect(refused.why).toContain(hub.url);
		}
		// an unresolvable hub label degrades to the local belt — whose list
		// then decides (parity with the launch path's fallthrough)
		const degraded = await servedModelsGate({
			model: "glm-5.3-flash",
			hubPick: "nas-dark",
			hubUrls: [],
			env: { SUSPENDERS_BUCKLE_FRONT: belt.url },
			resolve,
		});
		expect(degraded.verdict).toBe("pass");
		// hub token resolution rides hubCredential — proven by the request's
		// bearer once a token env is set for the label
		const authed = serveStub(catalog(["gpt-6-sol"]));
		try {
			await servedModelsGate({
				model: "gpt-6-sol",
				hubPick: "ikea",
				hubUrls: [],
				env: {
					SUSPENDERS_BUCKLE_FRONT: belt.url,
					SUSPENDERS_HUB_IKEA_TOKEN: "hub-secret",
				},
				resolve: async (l) =>
					l === "ikea" ? { label: "ikea", url: authed.url, via: "test" } : null,
			});
			expect(authed.requests[0]?.auth).toBe("Bearer hub-secret");
		} finally {
			authed.close();
		}
	} finally {
		hub.close();
		belt.close();
	}
});

test("servedModelsGate: unknown (catalog down / no-belt) never refuses @unit", async () => {
	const dead = serveStub(() => new Response("nope", { status: 500 }));
	try {
		const down = await servedModelsGate({
			model: "glm-5.3-flash",
			hubPick: null,
			hubUrls: [],
			env: { SUSPENDERS_BUCKLE_FRONT: dead.url },
		});
		expect(down.verdict).toBe("unknown");
		expect(
			await servedModelsGate({
				model: "anything",
				hubPick: null,
				hubUrls: [],
				noBelt: true,
			}),
		).toEqual({ verdict: "unknown", note: expect.any(String) });
	} finally {
		dead.close();
	}
});

test("admitModel: W2572 gate refuses pre-claim and MODEL_HEALTH=0 does not bypass it @unit", async () => {
	// scratch HOME = no settings.json → tryLoadStack() finds no pools or
	// hubs, so pool placement is inert and admission reaches the W2572 gate.
	let store: ReturnType<typeof openStore> | null = null;
	try {
		store = openStore();
		const spoke = serveStub(catalog(["gpt-6-sol"]));
		// the distinction under test: health-fact repin bypass must NOT
		// bypass served-models (served list is ground truth)
		const healthSaved = process.env.SUSPENDERS_MODEL_HEALTH;
		process.env.SUSPENDERS_MODEL_HEALTH = "0";
		process.env.SUSPENDERS_BUCKLE_FRONT = spoke.url;
		const routeAdmission = new RouteAdmission(
			false,
			async () => null,
			() => null,
		);
		const refusals: string[] = [];
		const waits: string[] = [];
		try {
			const out = await admitModel({
				store,
				project: "test-proj",
				sid: "w2572-test",
				item: "W2572T",
				pick: pickOf("glm-5.3-flash"),
				bin: "/usr/local/bin/claude",
				routePin: undefined,
				posture: "steady",
				quota: new Map(),
				wireEndpoints: unknownEndpoints,
				routeName: null,
				routeAdmission,
				governanceRefusals: refusals,
				launchWaits: waits,
			});
			expect(out.verdict).toBe("refused");
			if (out.verdict === "refused") {
				expect(out.reason).toContain("does not serve glm-5.3-flash");
				expect(out.reason).toContain("gpt-6-sol");
			}
			expect(refusals).toEqual(["W2572T"]);
			expect(waits).toEqual([]);
			// and the same destination PASSES a model it does serve
			const pass = await admitModel({
				store,
				project: "test-proj",
				sid: "w2572-test",
				item: "W2572T2",
				pick: pickOf("gpt-6-sol"),
				bin: "/usr/local/bin/claude",
				routePin: undefined,
				posture: "steady",
				quota: new Map(),
				wireEndpoints: unknownEndpoints,
				routeName: null,
				routeAdmission,
				governanceRefusals: refusals,
				launchWaits: waits,
				hubPick: null,
			});
			expect(pass.verdict).toBe("proceed");
			spoke.close();
			// belt front down = catalog unavailable = unknown = proceed
			const dead = serveStub(() => new Response("x", { status: 500 }));
			process.env.SUSPENDERS_BUCKLE_FRONT = dead.url;
			const unknownOut = await admitModel({
				store,
				project: "test-proj",
				sid: "w2572-test",
				item: "W2572T3",
				pick: pickOf("glm-5.3-flash"),
				bin: "/usr/local/bin/claude",
				routePin: undefined,
				posture: "steady",
				quota: new Map(),
				wireEndpoints: unknownEndpoints,
				routeName: null,
				routeAdmission,
				governanceRefusals: refusals,
				launchWaits: waits,
			});
			expect(unknownOut.verdict).toBe("proceed");
			dead.close();
		} finally {
			if (healthSaved === undefined) delete process.env.SUSPENDERS_MODEL_HEALTH;
			else process.env.SUSPENDERS_MODEL_HEALTH = healthSaved;
			delete process.env.SUSPENDERS_BUCKLE_FRONT;
		}
	} finally {
		// admitModel's refused path closes the store itself (verbatim from
		// lane-launch); the local binding tolerates a second close no-op —
		// still guard it so a throw here never masks the test verdict.
		try {
			store?.close();
		} catch {}
	}
});
