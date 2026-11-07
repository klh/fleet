// test/hub-dataplane.spec.ts — W2624.1: the dataplane coverage-proof spec.
// The Sinai proof (hooks/lib/gates/coverage-proof.ts) runs plain `bun test`,
// which never collects @playwright/test *.e2e.ts specs — so the W2329
// dataplane face had NO bun-collectable test and review #105474 graded
// no-coverage (failed=0 passed=5: only hub-knowledge-sink.test.ts ran, and
// the playwright dataplane suite passes at reverted main too, pinning
// nothing). A *.spec.ts is bun-collectable yet invisible to playwright's
// **/*.e2e.ts glob — the dual-runner channel, no *.test.ts ratchet impact
// (tests/test-framework-guard.test.ts counts .test.ts only). This spec
// imports deploy/hub-profiles.ts (the branch's own extraction): without
// the change the module does not resolve and the suite fails right there.
import { describe, expect, test } from "bun:test";
import { pushProfileEnv } from "../deploy/hub-profiles.ts";
import { HubProfileSchema } from "../hooks/lib/stack-config.ts";

type Row = { key: string; value: string };

const rendered = (hub: Record<string, unknown>): Row[] => {
	const rows: Row[] = [];
	pushProfileEnv(hub as never, (key, value) => {
		if (value !== undefined) rows.push({ key, value: String(value) });
	});
	return rows;
};

const row = (rows: readonly Row[], key: string): string | undefined =>
	rows.find((r) => r.key === key)?.value;

describe("W2624.1 — hub-profiles.ts carries the dataplane profile", () => {
	test("declared dataplane block enables the profile + port rows", () => {
		const rows = rendered({
			dataplane: { port: 7804, health_port: 7805 },
		});
		expect(row(rows, "HUB_DATAPLANE_PORT")).toBe("7804");
		expect(row(rows, "HUB_DATAPLANE_HEALTH_PORT")).toBe("7805");
		expect(row(rows, "COMPOSE_PROFILES")).toBe("dataplane");
	});

	test("every optional profile accumulates into ONE COMPOSE_PROFILES row", () => {
		const rows = rendered({
			belt_model: {
				port: 8914,
				health_port: 8915,
				upstream: "http://127.0.0.1:11434",
			},
			knowledge: { port: 7802, health_port: 7803 },
			litellm: { port: 4100, health_port: 4110 },
			dataplane: { port: 7804, health_port: 7805 },
		});
		expect(row(rows, "COMPOSE_PROFILES")).toBe(
			"belt-model,knowledge,litellm,dataplane",
		);
		// one declaration never clobbers another (W1217): exactly one row
		const profileRows = rows.filter((r) => r.key === "COMPOSE_PROFILES");
		expect(profileRows).toHaveLength(1);
	});

	test("nothing declared keeps the solo posture: no COMPOSE_PROFILES row", () => {
		expect(rendered({})).toEqual([]);
	});

	test("undeclared knobs fall through — the block still enables the profile", () => {
		const rows = rendered({ dataplane: {} });
		expect(row(rows, "COMPOSE_PROFILES")).toBe("dataplane");
		expect(row(rows, "HUB_DATAPLANE_PORT")).toBeUndefined();
	});

	test("malformed belt_model upstream fails loud, never half-declared", () => {
		expect(() =>
			rendered({
				belt_model: {
					port: 8914,
					health_port: 8915,
					upstream: "file:///etc/passwd",
				},
			}),
		).toThrow(/must be an HTTP URL/);
	});

	test("HubProfileSchema accepts the branch-only dataplane block", () => {
		const parsed = HubProfileSchema.safeParse({
			host: "127.0.0.1",
			dataplane: { port: 7804, health_port: 7805 },
		});
		expect(parsed.success).toBe(true);
		// the zod block is loose-shaped, knobs optional — the render decides
		expect(
			HubProfileSchema.safeParse({ host: "127.0.0.1", dataplane: {} }).success,
		).toBe(true);
	});
});
