// test/admin-schemas.test.ts — W1238.4: the /v1/admin/* body schemas are
// the single source of truth for the wire shape; drift fails loud. These
// tests pin the shape contracts: valid bodies parse to the exact fields
// the routes consume, drift (missing/wrong-typed/non-object bodies)
// rejects instead of coercing, and defaults match the old hand-parse.
import { describe, expect, test } from "bun:test";
import {
	AdminDrainSchema,
	AdminEnrollSchema,
	AdminIssueKeySchema,
	AdminTeamSchema,
	AdminVerifySchema,
} from "../src/gov/admin-schemas.ts";

describe("admin body schemas (W1238.4)", () => {
	test("drain: valid body parses; grace_ms optional", () => {
		const r = AdminDrainSchema.safeParse({ reason: "deploy" });
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.reason).toBe("deploy");
			expect(r.data.grace_ms).toBeUndefined();
		}
		const full = AdminDrainSchema.safeParse({
			reason: "deploy",
			grace_ms: 5000,
		});
		expect(full.success).toBe(true);
	});

	test("drain: missing/empty/non-string reason rejects", () => {
		expect(AdminDrainSchema.safeParse({}).success).toBe(false);
		expect(AdminDrainSchema.safeParse({ reason: "" }).success).toBe(false);
		expect(AdminDrainSchema.safeParse({ reason: 5 }).success).toBe(false);
	});

	test("non-object bodies reject (the silent-cast hazard)", () => {
		expect(AdminDrainSchema.safeParse(null).success).toBe(false);
		expect(AdminDrainSchema.safeParse("deploy").success).toBe(false);
		expect(AdminDrainSchema.safeParse([]).success).toBe(false);
	});

	test("verify: key required non-empty", () => {
		expect(AdminVerifySchema.safeParse({ key: "local-test-key" }).success).toBe(
			true,
		);
		expect(AdminVerifySchema.safeParse({ key: "" }).success).toBe(false);
		expect(AdminVerifySchema.safeParse({}).success).toBe(false);
	});

	test("issueKey: scopes default to [] and reject non-string entries", () => {
		const absent = AdminIssueKeySchema.safeParse({ name: "lane" });
		expect(absent.success).toBe(true);
		if (absent.success) expect(absent.data.scopes).toEqual([]);
		const drift = AdminIssueKeySchema.safeParse({
			name: "lane",
			scopes: ["buckle:proxy:READ_", 7],
		});
		expect(drift.success).toBe(false);
	});

	test("issueKey: optional numerics reject non-finite values", () => {
		expect(
			AdminIssueKeySchema.safeParse({ name: "k", rpm_limit: Number.NaN })
				.success,
		).toBe(false);
		const ok = AdminIssueKeySchema.safeParse({ name: "k", rpm_limit: 60 });
		expect(ok.success).toBe(true);
	});

	test("enroll: spoke_id required, ttl_s optional", () => {
		const r = AdminEnrollSchema.safeParse({ spoke_id: "nas" });
		expect(r.success).toBe(true);
		expect(AdminEnrollSchema.safeParse({}).success).toBe(false);
		const full = AdminEnrollSchema.safeParse({
			spoke_id: "nas",
			ttl_s: 3600,
		});
		expect(full.success).toBe(true);
	});

	test("team: team_id required, ceilings optional; unknown keys stripped", () => {
		const r = AdminTeamSchema.safeParse({
			team_id: "platform",
			rpm_ceiling: 100,
			extra: "ignored",
		});
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.rpm_ceiling).toBe(100);
			expect((r.data as Record<string, unknown>).extra).toBeUndefined();
		}
		expect(AdminTeamSchema.safeParse({}).success).toBe(false);
		expect(
			AdminTeamSchema.safeParse({ team_id: "t", spend_ceiling: "no" }).success,
		).toBe(false);
	});
});
