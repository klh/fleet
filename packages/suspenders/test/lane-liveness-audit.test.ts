// W652.1 — the liveness projections are shared, not re-derived: auditLanes
// is THE registry audit shape (`work lanes` renders it; coord fleet and
// dispatch registry render the same verdict), and verdictBySid is the
// claim-sid join projection faces use. Hermetic: lane-liveness.ts has no
// db imports, so the process table is the only environment here.
import { describe, expect, test } from "bun:test";
import {
	auditLanes,
	type LaneRef,
	verdictBySid,
} from "../hooks/lib/lane-liveness.ts";

const foreignRow = (sid: string): LaneRef => ({
	sid,
	item: "W1",
	host: "elsewhere",
});

describe("auditLanes", () => {
	test("local pid-less row reads dead (no process, no transcript)", () => {
		const rows = auditLanes([{ sid: "t-local", item: "W1" }]);
		expect(rows).toHaveLength(1);
		expect(rows[0].verdict).toBe("dead");
		expect(rows[0].live).toBe(false);
		expect(rows[0].host).toBeNull();
	});

	test("foreign-host row without a transcript reads unknown, never dead", () => {
		const rows = auditLanes([foreignRow(`t-foreign-${Date.now()}`)]);
		expect(rows[0].verdict).toBe("unknown");
		expect(rows[0].live).toBe(false);
	});

	test("live stays the collapsed verdict — never an independent term", () => {
		const rows = auditLanes([{ sid: "t-collapse", item: "W1" }]);
		expect(rows[0].live).toBe(rows[0].verdict === "alive");
	});
});

describe("verdictBySid", () => {
	const registry: LaneRef[] = [
		{ sid: "autow1-abcdef0123456789", item: "W1" },
		{ sid: "autow2", item: "W2" },
	];

	test("exact sid joins", () => {
		const v = verdictBySid(["autow2"], registry);
		expect(v.get("autow2")).toBe("dead");
	});

	test("short claim sid joins a longer registry sid (and reverse)", () => {
		const v = verdictBySid(["autow1"], registry);
		expect(v.get("autow1")).toBe("dead");
		const rev = verdictBySid(
			["autow1-abcdef0123456789"],
			[{ sid: "autow1", item: "W1" }],
		);
		expect(rev.get("autow1-abcdef0123456789")).toBe("dead");
	});

	test("unmatched claims join to nothing — no verdict invented", () => {
		const v = verdictBySid(["nobody"], registry);
		expect(v.has("nobody")).toBe(false);
	});
});
