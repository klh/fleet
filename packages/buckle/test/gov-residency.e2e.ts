// test/gov-residency.test.ts — W235 locked residency floors: the compiled
// floor is the LOOSEST posture; inputs (env/overlay) may only tighten
// (subset law, fail-closed at boot); enforcement is structural — candidates
// outside the resolved policy never become healthy rows.
import { expect, test } from "@playwright/test";
import {
	RESIDENCY_FLOOR,
	parseResidencyInput,
	residencyAllowsCandidate,
	residencyFromEnv,
	residencyOfTags,
	resolveResidency,
} from "../src/gov/residency.ts";
import { CandidateTable } from "../src/candidates.ts";
import { Cooldowns } from "../src/cooldown.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

test.describe({ tag: "@unit" }, () => {
	const cd = new Cooldowns(3, 30);

	test.describe("residency — floor + resolution", () => {
		test("floor is the loosest posture: everything admitted, telemetry off", () => {
			expect(RESIDENCY_FLOOR).toEqual({
				regions: ["*"],
				locality: ["cloud", "hub-local"],
				telemetry: "off",
			});
		});
		test("inputs tighten: pin regions, restrict locality, telemetry explicit", () => {
			const p = resolveResidency({
				regions: ["eu-central"],
				locality: ["hub-local"],
				telemetry: "on",
			});
			expect(p.regions).toEqual(["eu-central"]);
			expect(p.locality).toEqual(["hub-local"]);
			expect(p.telemetry).toBe("on");
		});
		test("malformed inputs throw (fail closed) — nothing loosens the floor", () => {
			expect(() => resolveResidency({ locality: ["galaxy" as never] })).toThrow(
				/loosens the locked floor/,
			);
			expect(() => parseResidencyInput({ regions: "eu" })).toThrow(
				"string array",
			);
			expect(() => parseResidencyInput({ telemetry: "maybe" })).toThrow(
				'"off" | "on"',
			);
		});
		test("env inputs parse CSV; empty stays undefined", () => {
			const e = residencyFromEnv({
				BUCKLE_RESIDENCY_REGIONS: " eu-central, eu-north ",
			});
			expect(e.regions).toEqual(["eu-central", "eu-north"]);
			expect(e.locality).toBeUndefined();
			expect(
				residencyFromEnv({ BUCKLE_RESIDENCY_TELEMETRY: "on" }).telemetry,
			).toBe("on");
		});
	});

	test.describe("residency — candidate admission", () => {
		test("tags carry residency claims (region:/locality: words)", () => {
			expect(
				residencyOfTags(["region:eu-central", "locality:cloud", "gpu"]),
			).toEqual({
				regions: ["eu-central"],
				localities: ["cloud"],
			});
		});
		test("admission: local needs hub-local; cloud needs cloud; pinned proves region", () => {
			const loose = resolveResidency({});
			const hubOnly = resolveResidency({ locality: ["hub-local"] });
			const pinned = resolveResidency({ regions: ["eu-central"] });
			expect(
				residencyAllowsCandidate({
					host: "127.0.0.1",
					groupTags: [],
					residency: loose,
				}),
			).toBe(true);
			expect(
				residencyAllowsCandidate({
					host: "127.0.0.1",
					groupTags: [],
					residency: hubOnly,
				}),
			).toBe(true);
			expect(
				residencyAllowsCandidate({
					host: "api.example.com",
					groupTags: [],
					residency: loose,
				}),
			).toBe(true);
			expect(
				residencyAllowsCandidate({
					host: "api.example.com",
					groupTags: [],
					residency: hubOnly,
				}),
			).toBe(false);
			expect(
				residencyAllowsCandidate({
					host: "api.example.com",
					groupTags: [],
					residency: pinned,
				}),
			).toBe(false);
			expect(
				residencyAllowsCandidate({
					host: "api.example.com",
					groupTags: ["region:eu-central"],
					residency: pinned,
				}),
			).toBe(true);
		});
		test("candidate table benches residency outsiders", () => {
			const poolOf = (entries: Array<[string, string[]]>): UpstreamPool => {
				const map = new Map(entries);
				return {
					groups: () => [...map.keys()],
					deployments: (g) =>
						(map.get(g) ?? []).map((url) => ({
							group: g,
							url,
							dialect: "openai" as const,
						})),
				};
			};
			const hubOnly = resolveResidency({ locality: ["hub-local"] });
			const table = new CandidateTable({
				pool: poolOf([
					["hub-model", ["http://127.0.0.1:8902"]],
					["cloud-model", ["https://api.example.com/v1"]],
				]),
				policy: { tags: {} } as never,
				cooldowns: cd,
				residency: hubOnly,
			});
			const rows = table.snapshot();
			expect(rows.find((r) => r.group === "hub-model")?.healthy).toBe(true);
			expect(rows.find((r) => r.group === "cloud-model")?.healthy).toBe(false);
		});
	});
});
