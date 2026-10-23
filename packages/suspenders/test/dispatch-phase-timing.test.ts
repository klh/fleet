import { beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	aggregatePhases,
	dispatchToolName,
	endDispatchPhases,
	recordPhase,
	resetDispatchPhases,
	timedDispatchSpawn,
} from "../scripts/lib/dispatch-phase-timing.ts";

// A store that must never be touched: query() throws, so tests proving
// read-only behavior get a loud failure instead of a silent pass.
const untouchedStore = () =>
	({
		query: () => {
			throw new Error("store must never be touched");
		},
	}) as unknown as GovernorStore;

const tmpFleet = () => mkdtempSync(join(tmpdir(), "w1176-phases-"));

// Fake store: query() throws on any non-events INSERT (loud signal for
// "store never touched" tests) and captures ts/scope/payload for the
// flush assertions.
const fakeStore = () => {
	const inserted: {
		ts: number;
		scope: string;
		payload: Record<string, unknown>;
	}[] = [];
	const store = {
		local: true,
		query: (sql: string) => {
			if (!sql.includes("INSERT INTO events"))
				throw new Error(`unexpected sql: ${sql}`);
			return {
				run: (...args: unknown[]) => {
					inserted.push({
						ts: args[0] as number,
						scope: args[1] as string,
						payload: JSON.parse(args[2] as string),
					});
					return {};
				},
			};
		},
		run: () => ({}),
		transaction: <T>(fn: () => T) => fn,
		close: () => {},
	} as unknown as GovernorStore;
	return { store, inserted };
};

beforeEach(() => resetDispatchPhases());

test("dry flush prints only — no loop.log, no store", () => {
	const dir = tmpFleet();
	recordPhase("brief.compose", 5);
	const log = spyOn(console, "log").mockImplementation(() => {});
	let line = "";
	try {
		endDispatchPhases({ fleet: dir, dry: true }, untouchedStore());
		line = String(log.mock.calls[0]?.[0] ?? "");
	} finally {
		log.mockRestore();
	}
	expect(line).toContain("PHASE-TIMING");
	expect(line).toContain("brief.compose×1=5ms");
	expect(existsSync(join(dir, "loop.log"))).toBe(false);
});

test("dispatchToolName derives <script> <verb> argv identity", () => {
	expect(dispatchToolName(["bun", "/x/bin/work.ts", "take", "W1"])).toBe(
		"work take",
	);
	expect(
		dispatchToolName(["git", "-C", "/repo", "status", "--porcelain"]),
	).toBe("git status");
	expect(dispatchToolName(["bun", "/x/work.ts", "/some/dir", "take"])).toBe(
		"work take",
	);
	expect(
		dispatchToolName(["/bin/docker", "compose", "-f", "/x.yml", "ps"]),
	).toBe("docker compose");
	// flags-only tail and a bare binary fall back to script/base name
	expect(dispatchToolName(["bun", "/x/y.ts", "--json"])).toBe("y");
	expect(dispatchToolName(["docker", "ps"])).toBe("docker ps");
	// fail-soft on degenerate argv
	expect(dispatchToolName([])).toBe("");
});

test("timedDispatchSpawn records the ok span of a successful run", () => {
	const out = timedDispatchSpawn(
		(cmd) => cmd.join(" "),
		["bun", "/x/work.ts", "take", "W1"],
	);
	expect(out).toBe("bun /x/work.ts take W1");
	const { store, inserted } = fakeStore();
	const dir = tmpFleet();
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		endDispatchPhases({ fleet: dir, item: "W1" }, store);
	} finally {
		log.mockRestore();
	}
	const spans = inserted[0].payload.spans as Record<string, unknown>[];
	expect(spans).toHaveLength(1);
	expect(spans[0].phase).toBe("tool");
	expect(spans[0].name).toBe("work take");
	expect(spans[0].ok).toBe(true);
	expect(spans[0].ms).toBeGreaterThanOrEqual(0);
});

test("timedDispatchSpawn marks failing runs ok:false and propagates", () => {
	const boom = new Error("boom");
	expect(() =>
		timedDispatchSpawn(() => {
			throw boom;
		}, ["git", "status"]),
	).toThrow(boom);
	const { store, inserted } = fakeStore();
	const dir = tmpFleet();
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		endDispatchPhases({ fleet: dir, item: "W1" }, store);
	} finally {
		log.mockRestore();
	}
	const spans = inserted[0].payload.spans as Record<string, unknown>[];
	expect(spans).toHaveLength(1);
	expect(spans[0].name).toBe("git status");
	expect(spans[0].ok).toBe(false);
});

test("recordPhase names in-process phases after themselves", () => {
	recordPhase("probe.buckle-front", 12.4);
	recordPhase("admission.audit", 3.6, false);
	const { store, inserted } = fakeStore();
	const dir = tmpFleet();
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		endDispatchPhases({ fleet: dir }, store);
	} finally {
		log.mockRestore();
	}
	const spans = inserted[0].payload.spans as Record<string, unknown>[];
	expect(spans).toEqual([
		{
			phase: "probe.buckle-front",
			name: "probe.buckle-front",
			ms: 12,
			ok: true,
		},
		{
			phase: "admission.audit",
			name: "admission.audit",
			ms: 4,
			ok: false,
		},
	]);
	// no item/sid → scope falls back to "dispatch"
	expect(inserted[0].scope).toBe("dispatch");
});

test("aggregatePhases surfaces N+1 as count and a blocker as maxMs", () => {
	const rows = [
		{ phase: "tool", name: "work take", ms: 100, ok: true },
		{ phase: "tool", name: "work take", ms: 50, ok: true },
		{ phase: "tool", name: "git status", ms: 10, ok: false },
	];
	expect(aggregatePhases(rows).get("work take")).toEqual({
		count: 2,
		ms: 150,
		maxMs: 100,
		failed: 0,
	});
	expect(aggregatePhases(rows).get("git status")).toEqual({
		count: 1,
		ms: 10,
		maxMs: 10,
		failed: 1,
	});
	// the N+1 probe repeat pattern: three identical probes → count 3
	const probes = [1, 2, 3].map((n) => ({
		phase: "probe.buckle-front",
		name: "probe.buckle-front",
		ms: n,
		ok: true,
	}));
	expect(aggregatePhases(probes).get("probe.buckle-front")?.count).toBe(3);
});

test("live flush appends loop.log and inserts one dispatch.phase row", () => {
	const dir = tmpFleet();
	recordPhase("probe.buckle-front", 12.4);
	const { store, inserted } = fakeStore();
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		endDispatchPhases({ fleet: dir, item: "W1176", sid: "autow1176-x" }, store);
	} finally {
		log.mockRestore();
	}
	const txt = readFileSync(join(dir, "loop.log"), "utf8");
	expect(txt).toContain("PHASE-TIMING");
	expect(txt).toContain("item=W1176");
	// leading ISO timestamp parses as a real instant
	const iso = txt.slice(0, txt.indexOf(" "));
	expect(Number.isNaN(Date.parse(iso))).toBe(false);
	expect(inserted).toHaveLength(1);
	expect(inserted[0].scope).toBe("W1176");
	expect(inserted[0].ts).toBeGreaterThan(0);
	expect(inserted[0].payload.item).toBe("W1176");
	expect(inserted[0].payload.sid).toBe("autow1176-x");
	expect(inserted[0].payload.totalMs).toBeGreaterThan(0);
});

test("telemetry is fail-soft: a throwing store never kills the flush", () => {
	const dir = tmpFleet();
	recordPhase("brief.compose", 2);
	const bad = {
		query: () => {
			throw new Error("db shut");
		},
	} as unknown as GovernorStore;
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		expect(() =>
			endDispatchPhases({ fleet: dir, item: "W1" }, bad),
		).not.toThrow();
	} finally {
		log.mockRestore();
	}
	// the loop.log line already landed before the store attempt
	expect(readFileSync(join(dir, "loop.log"), "utf8")).toContain("PHASE-TIMING");
});

test("span buffer saturates at the cap — dropped count survives", () => {
	const dir = tmpFleet();
	for (let i = 0; i < 650; i++) recordPhase(`p${i}`, 1);
	const { store, inserted } = fakeStore();
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		endDispatchPhases({ fleet: dir, item: "W1" }, store);
	} finally {
		log.mockRestore();
	}
	const payload = inserted[0].payload;
	expect(payload.dropped).toBe(50);
	expect(payload.spans as unknown[]).toHaveLength(600);
});
