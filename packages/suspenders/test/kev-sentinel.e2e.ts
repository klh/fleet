// test/kev-sentinel.e2e.ts — W2593 co-situated proof: the kev model
// sentinel rules 1-8. execPick classifies the .prefer chain into a kev
// plan (choose all/hub/glob · noop · misconfig); kevModelGate resolves the
// plan against stub hub catalogs with an injected kev decision; admitModel
// runs the gate FIRST so every later gate validates the resolved model.
// Catalogs ride test-kit serveStub; kev itself is injected (no :8912
// dependency — the client contract is already covered by kev.test.ts).

import { serveStub, scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import type { KevDecision } from "../hooks/lib/knowledge/kev.ts";
import {
	kevModelGate,
	kevCandidates,
} from "../hooks/lib/fleet-loop/kev-model.ts";
import type { HubLocation } from "../hooks/lib/hub/hub-locate.ts";
import {
	globFilter,
	isModelGlob,
	kevPlanOf,
	stripKevDirectives,
	type KevChainView,
} from "../scripts/lib/kev-sentinel.ts";
import { execPick } from "../scripts/lib/exec-chain.ts";
import { admitModel } from "../hooks/lib/fleet-loop/model-admission.ts";
import { openStore } from "../hooks/lib/govdb/govdb.ts";
import { unknownEndpoints } from "../scripts/lib/lane-wire.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Stubbed kev answer (injected decide) — no :8912 dependency. */
const kevAnswer =
	(choice: string) => async (): Promise<KevDecision | null> => ({
		model: "kev-latest",
		choice,
		confidence: 0.9,
		probabilities: { [choice]: 0.9 },
		inputTokens: 10,
		outputTokens: 5,
		latencyMs: 100,
	});

const world = scratchWorld({ prefix: "w2593-kev-" });
const realHome = process.env.HOME;
process.env.HOME = world.home;
// pin kev to a dead port for the tests that exercise the REAL client
// path (kevModelGate without an injected decide) — deterministic null.
const realKevUrl = process.env.SUSPENDERS_KEV_URL;
process.env.SUSPENDERS_KEV_URL = "http://127.0.0.1:1";
const REPO = mkdtempSync(join(tmpdir(), "w2593-kev-repo-"));

test.afterAll(() => {
	process.env.HOME = realHome;
	if (realKevUrl === undefined) delete process.env.SUSPENDERS_KEV_URL;
	else process.env.SUSPENDERS_KEV_URL = realKevUrl;
	world.clean();
	rmSync(REPO, { recursive: true, force: true });
});

const catalog = (ids: string[]) => (_req: Request) =>
	Response.json({ object: "list", data: ids.map((id) => ({ id })) });

const view = (v: Partial<KevChainView>): KevChainView => ({
	hub: null,
	hubUrls: [],
	directives: [],
	can: null,
	...v,
});

test("grammar: isModelGlob accepts partial-* only; globFilter prefixes @unit", () => {
	expect(isModelGlob("glm-*")).toBe(true);
	expect(isModelGlob("*")).toBe(false); // bare * is ALL, not a glob
	expect(isModelGlob("glm-5.3")).toBe(false);
	expect(globFilter(["glm-5.3", "fable-5"], ["glm-"])).toEqual(["glm-5.3"]);
	expect(globFilter(["glm-5.3"], [])).toEqual(["glm-5.3"]); // no glob = all
});

test("rules 1-8: kevPlanOf classifies each configuration @unit", () => {
	// 1
	expect(kevPlanOf(view({}))).toEqual({
		kind: "choose",
		scope: "all",
		hub: null,
		prefixes: [],
	});
	// 2
	expect(kevPlanOf(view({ hub: "ikea" }))).toEqual({
		kind: "choose",
		scope: "hub",
		hub: "ikea",
		prefixes: [],
	});
	// 3
	expect(
		kevPlanOf(
			view({ hub: "ikea", directives: [{ value: "glm-*", kind: "prefer" }] }),
		),
	).toMatchObject({ kind: "choose", prefixes: ["glm-"] });
	// 4
	expect(
		kevPlanOf(
			view({ hub: "ikea", directives: [{ value: "glm-5.3", kind: "prefer" }] }),
		),
	).toMatchObject({ kind: "noop" });
	// 5
	expect(
		kevPlanOf(
			view({ hub: "ikea", directives: [{ value: "glm-*", kind: "must" }] }),
		),
	).toMatchObject({ kind: "choose", prefixes: ["glm-"] });
	// 6a full-model must
	expect(
		kevPlanOf(
			view({ hub: "ikea", directives: [{ value: "glm-5.3", kind: "must" }] }),
		),
	).toMatchObject({ kind: "noop" });
	// 6b multiple musts
	expect(
		kevPlanOf(
			view({
				hub: "ikea",
				directives: [
					{ value: "glm-5.3", kind: "must" },
					{ value: "fable", kind: "must" },
				],
			}),
		),
	).toMatchObject({ kind: "noop" });
	// 7
	expect(
		kevPlanOf(
			view({
				hub: "ikea",
				directives: [
					{ value: "glm-5.3", kind: "must" },
					{ value: "fable", kind: "prefer" },
				],
			}),
		),
	).toMatchObject({ kind: "misconfig" });
	// 8
	expect(
		kevPlanOf(
			view({
				hub: "ikea",
				directives: [{ value: "glm-5.3", kind: "must" }],
				can: { value: "glm-flash" },
			}),
		),
	).toMatchObject({ kind: "noop" });
});

test("stripKevDirectives: must=kev is the trigger, not a rule-6 full-model must @unit", () => {
	const stripped = stripKevDirectives(
		view({ hub: "ikea", directives: [{ value: "kev", kind: "must" }] }),
	);
	expect(stripped.directives).toEqual([]);
	expect(kevPlanOf(stripped)).toMatchObject({ kind: "choose", scope: "hub" });
});

test("execPick: rule-1 bare model=kev stamps a choose-all plan on the pick @unit", () => {
	writeFileSync(join(REPO, ".prefer"), "model=kev\n");
	const p = execPick(0, REPO);
	expect(p.name).toBe("kev");
	expect(p.model).toBeNull();
	expect(p.kevPlan).toEqual({
		kind: "choose",
		scope: "all",
		hub: null,
		prefixes: [],
	});
	rmSync(join(REPO, ".prefer"), { force: true });
});

test("execPick: rule-7 misconfig throws; rule-4/6 noop keeps today's pin @unit", () => {
	writeFileSync(
		join(REPO, ".prefer"),
		"hub=ikea\nmodel=kev\nmust=glm-5.3-flash\nprefer=fable\n",
	);
	expect(() => execPick(0, REPO)).toThrow("cannot coexist");
	rmSync(join(REPO, ".prefer"), { force: true });
	writeFileSync(join(REPO, ".prefer"), "hub=ikea\nprefer=glm-5.3-flash\n");
	const p = execPick(0, REPO);
	expect(p.kevPlan).toBeUndefined();
	expect(p.model).toBe("glm-5.3-flash");
	rmSync(join(REPO, ".prefer"), { force: true });
});

const _kevAnswerUnused = undefined;

test("kevCandidates: scope hub reads the pinned hub's own catalog @unit", async () => {
	const hub = serveStub(catalog(["gpt-6-sol"]));
	const belt = serveStub(catalog(["glm-5.3-flash"]));
	const resolve = async (l: string): Promise<HubLocation | null> =>
		l === "ikea" ? { label: "ikea", url: hub.url, via: "test" } : null;
	try {
		const got = await kevCandidates({
			plan: { kind: "choose", scope: "hub", hub: "ikea", prefixes: [] },
			env: { SUSPENDERS_BUCKLE_FRONT: belt.url },
			resolve,
		});
		expect(got).toEqual(["gpt-6-sol"]); // the BELT list never leaks in
		const globbed = await kevCandidates({
			plan: { kind: "choose", scope: "hub", hub: "ikea", prefixes: ["gp"] },
			env: { SUSPENDERS_BUCKLE_FRONT: belt.url },
			resolve,
		});
		expect(globbed).toEqual(["gpt-6-sol"]);
	} finally {
		hub.close();
		belt.close();
	}
});

test("kevCandidates: scope all unions every known hub's catalog deduped @unit", async () => {
	const belt = serveStub(catalog(["glm-5.3", "shared-x"]));
	const hubA = serveStub(catalog(["gpt-6-sol", "shared-x"]));
	const resolve = async (l: string): Promise<HubLocation | null> =>
		l === "huba" ? { label: "huba", url: hubA.url, via: "test" } : null;
	process.env.SUSPENDERS_HUBS_FILE = join(world.home, "no-hubs.json");
	try {
		// one registry hub + the belt front: union dedupes shared-x
		writeFileSync(
			join(world.home, "no-hubs.json"),
			JSON.stringify({ huba: { candidates: [hubA.url] } }),
		);
		const got = await kevCandidates({
			plan: { kind: "choose", scope: "all", hub: null, prefixes: [] },
			env: { SUSPENDERS_BUCKLE_FRONT: belt.url },
			resolve,
		});
		expect(got).toEqual(["glm-5.3", "shared-x", "gpt-6-sol"]);
	} finally {
		delete process.env.SUSPENDERS_HUBS_FILE;
		hubA.close();
		belt.close();
	}
});

test("kevModelGate: kev pick, out-of-set answer, and deterministic fallback @unit", async () => {
	const belt = serveStub(catalog(["glm-5.3", "gpt-6-sol"]));
	const env = { SUSPENDERS_BUCKLE_FRONT: belt.url };
	const plan = {
		kind: "choose",
		scope: "all",
		hub: null,
		prefixes: [],
	} as const;
	try {
		const kev = await kevModelGate({
			plan,
			env,
			decide: kevAnswer("gpt-6-sol"),
		});
		expect(kev).toMatchObject({
			verdict: "model",
			model: "gpt-6-sol",
			via: "kev",
		});
		// out-of-set answer → deterministic first candidate
		const off = await kevModelGate({
			plan,
			env,
			decide: kevAnswer("not-a-model"),
		});
		expect(off).toMatchObject({
			verdict: "model",
			model: "glm-5.3",
			via: "deterministic",
		});
		// kev down (null) → deterministic
		const down = await kevModelGate({
			plan,
			env,
			decide: async () => null,
		});
		expect(down).toMatchObject({ verdict: "model", via: "deterministic" });
	} finally {
		belt.close();
	}
});

test("kevModelGate: noop skips, misconfig refuses, empty candidates WAIT @unit", async () => {
	const noop = await kevModelGate({
		plan: { kind: "noop", reason: "multiple must= — kev does nothing" },
	});
	expect(noop).toMatchObject({ verdict: "skip" });
	const bad = await kevModelGate({
		plan: { kind: "misconfig", why: "must= and prefer= cannot coexist" },
	});
	expect(bad).toMatchObject({ verdict: "refused" });
	const empty = await kevModelGate({
		plan: { kind: "choose", scope: "all", hub: null, prefixes: ["nope-"] },
		env: { SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1" },
		timeoutMs: 200,
	});
	expect(empty).toMatchObject({ verdict: "wait" });
});

test("end-to-end: admitModel runs the kev gate first and sets the model @unit", async () => {
	const belt = serveStub(catalog(["glm-5.3", "gpt-6-sol"]));
	const store = openStore();
	try {
		writeFileSync(join(REPO, ".prefer"), "model=kev\n");
		const pick = execPick(0, REPO);
		if (!pick.kevPlan) throw new Error("expected a kev plan on the pick");
		// kev pinned dead (module env) → deterministic first candidate
		// glm-5.3; the gate reads the belt front from env, so point it here
		process.env.SUSPENDERS_BUCKLE_FRONT = belt.url;
		const out = await admitModel({
			store,
			project: "w2593-test",
			sid: "test-kev-lane",
			item: "W2593",
			pick,
			bin: "/usr/bin/claude",
			routePin: undefined,
			posture: "steady",
			quota: new Map(),
			wireEndpoints: unknownEndpoints,
			routeName: null,
			routeAdmission: {
				check: async () => ({ pause: false, failures: 0 }),
			} as never,
			governanceRefusals: [],
			launchWaits: [],
			hubPick: null,
		});
		// the belt serves both candidates; kev dead → deterministic first
		expect(out.verdict).toBe("proceed");
		if (out.verdict === "proceed") expect(out.pick.model).toBe("glm-5.3");
	} finally {
		delete process.env.SUSPENDERS_BUCKLE_FRONT;
		store.close();
		belt.close();
		rmSync(join(REPO, ".prefer"), { force: true });
	}
});
