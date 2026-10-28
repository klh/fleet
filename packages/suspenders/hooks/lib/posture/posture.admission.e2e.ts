import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { openStore } from "../govdb/govdb.ts";
import {
	admitPostureLaunch,
	entryKey,
	postureOccupancy,
	resolveDispatchPosture,
	stackPostureDocument,
} from "./posture.admission.ts";
import { postureDocument } from "./posture.fixtures.ts";
import type { ResolvedPosture } from "./posture.zod.ts";

const entry = (hub: string, model: string, lanes: number): ResolvedPosture => ({
	selection: { fleet: "fleet", posture: "test", developmentOverride: false },
	entries: [{ hub, model, policy: "MUST", lanes }],
	sources: {},
});

const world = scratchWorld({ prefix: "posture-admission-" });
const realHome = process.env.HOME;
process.env.HOME = world.home;
const store = openStore();

test.afterAll(() => {
	store.close();
	process.env.HOME = realHome;
	world.clean();
});

test("stackPostureDocument passes a valid section through, throws loud on malformed", () => {
	expect(
		stackPostureDocument({ hubs: {}, postures: postureDocument() }),
	).toEqual(postureDocument());
	const bad = postureDocument();
	bad.version = 2;
	expect(() => stackPostureDocument({ hubs: {}, postures: bad })).toThrow(
		/stack\.json postures: version/,
	);
});

test("resolveDispatchPosture returns null without a configured posture", () => {
	expect(resolveDispatchPosture(null, world.repo)).toBeNull();
	expect(resolveDispatchPosture({ hubs: {} }, world.repo)).toBeNull();
});

test("admission claims under the ceiling and refuses past it", () => {
	const minimal = entry("example", "coder", 1);
	const first = admitPostureLaunch({ store, resolved: minimal, sid: "s1" });
	expect(first).toEqual({
		ok: true,
		entry: { hub: "example", model: "coder", policy: "MUST", lanes: 1 },
	});
	// second admission, same shared pool — no unlisted fallback
	const second = admitPostureLaunch({ store, resolved: minimal, sid: "s2" });
	expect(second.ok).toBe(false);
	if (second.ok) return;
	expect(second.reason).toMatch(/ceilings exhausted/);
	expect(second.reason).toMatch(/no unlisted fallback/);
});

test("the ceiling is shared across projects — running lanes on any project count", () => {
	store.run(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
		"p2:s-shared",
		"other/project",
		Date.now(),
		Date.now(),
	);
	store.run(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
		"lane.p2:s-shared.entry",
		entryKey({ hub: "example", model: "shared" }),
		Date.now(),
	);
	const occupancy = postureOccupancy(store);
	expect(occupancy.get(entryKey({ hub: "example", model: "shared" }))).toBe(1);
	const blocked = admitPostureLaunch({
		store,
		resolved: entry("example", "shared", 1),
		sid: "s-blocked",
	});
	expect(blocked.ok).toBe(false);
});

test("stale entry facts never count — dead lanes drain, never block", () => {
	store.run(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
		"lane.dead:stale.entry",
		entryKey({ hub: "example", model: "ghost" }),
		Date.now() - 61 * 60_000,
	);
	const occupancy = postureOccupancy(store);
	expect(occupancy.has(entryKey({ hub: "example", model: "ghost" }))).toBe(
		false,
	);
});

test("the blocked reason names the exhausted hub/model ceiling", () => {
	const ceiling = entry("example", "rare", 1);
	admitPostureLaunch({ store, resolved: ceiling, sid: "s-rare" });
	const next = admitPostureLaunch({
		store,
		resolved: ceiling,
		sid: "s-next",
	});
	expect(next.ok).toBe(false);
	if (next.ok) return;
	expect(next.reason).toContain("example/rare 1/1");
});
