import { expect, test } from "@playwright/test";
import { resolvePosture } from "./posture.resolve.ts";
import {
	postureDocument,
	postureLayer,
	partialRuleOverlay,
} from "./posture.fixtures.ts";
import type { PostureOverlay } from "./posture.zod.ts";

test("nearer layers replace only specified nested fields and record provenance", {
	tag: "@unit",
}, () => {
	const resolved = resolvePosture(postureDocument(), [
		postureLayer("parent/.prefer", partialRuleOverlay(2)),
		postureLayer("repo/.prefer", partialRuleOverlay(3)),
	]);

	expect(resolved.entries).toContainEqual({
		hub: "example",
		model: "coder",
		policy: "MUST",
		lanes: 3,
	});
	expect(
		resolved.sources["hubs.example.profiles.plaid.models.coder.lanes"],
	).toBe("repo/.prefer");
	expect(
		resolved.sources["hubs.example.profiles.plaid.models.coder.policy"],
	).toBe("base");
});

test("validates references after merging local definitions and selection", {
	tag: "@unit",
}, () => {
	const resolved = resolvePosture(postureDocument(), [
		postureLayer("repo/.prefer", {
			version: 1,
			hubs: {
				local: {
					profiles: {
						nearby: {
							models: {
								localcoder: { policy: "MUST" },
							},
						},
					},
				},
			},
			fleets: {
				fleet: {
					postures: { local: ["local.nearby"] },
				},
			},
		}),
		postureLayer("worktree/.prefer", {
			version: 1,
			hubs: {
				local: {
					profiles: {
						nearby: {
							models: {
								localcoder: { lanes: 4 },
							},
						},
					},
				},
			},
			fleets: {
				fleet: {
					postures: { local: ["local.nearby"] },
				},
			},
			selection: { posture: "local" },
		}),
	]);

	expect(resolved.selection.posture).toBe("local");
	expect(resolved.entries).toEqual([
		{
			hub: "local",
			model: "localcoder",
			policy: "MUST",
			lanes: 4,
		},
	]);
	expect(
		resolved.sources["hubs.local.profiles.nearby.models.localcoder.policy"],
	).toBe("repo/.prefer");
	expect(
		resolved.sources["hubs.local.profiles.nearby.models.localcoder.lanes"],
	).toBe("worktree/.prefer");
});

test("repeated references do not multiply identical hub/model rules", {
	tag: "@unit",
}, () => {
	const resolved = resolvePosture(postureDocument(), [
		postureLayer("repo/.prefer", {
			version: 1,
			fleets: {
				fleet: {
					postures: { plaid: ["example.plaid", "example.plaid"] },
				},
			},
		}),
	]);

	expect(
		resolved.entries.filter((entry) => entry.model === "coder"),
	).toHaveLength(1);
});

test("nearer posture arrays replace rather than concatenate", {
	tag: "@unit",
}, () => {
	const resolved = resolvePosture(postureDocument(), [
		postureLayer("repo/.prefer", {
			version: 1,
			fleets: {
				fleet: {
					postures: { plaid: ["example.development"] },
				},
			},
		}),
	]);

	expect(resolved.entries).toEqual([
		{
			hub: "example",
			model: "coder",
			policy: "CAN",
			lanes: 2,
		},
	]);
	expect(resolved.sources["fleets.fleet.postures.plaid"]).toBe("repo/.prefer");
});

test("deduplicates identical rules across profiles and preserves OFF and zero", {
	tag: "@unit",
}, () => {
	const base = postureDocument();
	base.fleets.fleet.postures.plaid = ["example.plaid", "example.minimal"];
	base.hubs.example.profiles.plaid.models.coder = {
		policy: "MUST",
		lanes: 1,
	};
	const resolved = resolvePosture(base, []);

	expect(
		resolved.entries.filter((entry) => entry.model === "coder"),
	).toHaveLength(1);
	expect(resolved.entries).toContainEqual({
		hub: "example",
		model: "disabled",
		policy: "OFF",
		lanes: 0,
	});
});

test("rejects conflicting rules and unresolved references with both sources", {
	tag: "@unit",
}, () => {
	const conflict = postureDocument();
	conflict.fleets.fleet.postures.plaid = ["example.plaid", "example.minimal"];
	expect(() => resolvePosture(conflict, [])).toThrow(
		/base.*example\.plaid.*example\.minimal/,
	);
	const layeredConflict = postureDocument();
	layeredConflict.fleets.fleet.postures.plaid = [
		"example.plaid",
		"example.minimal",
	];
	expect(() =>
		resolvePosture(layeredConflict, [
			postureLayer("repo/.prefer", {
				version: 1,
				hubs: {
					example: {
						profiles: {
							minimal: {
								models: { coder: { lanes: 3 } },
							},
						},
					},
				},
			}),
		]),
	).toThrow(
		/example\.plaid from base.*example\.minimal from base, repo\/\.prefer/,
	);

	const unknown = postureDocument();
	unknown.fleets.fleet.postures.plaid = ["missing.profile"];
	expect(() =>
		resolvePosture(unknown, [
			postureLayer("repo/.prefer", {
				version: 1,
				fleets: { fleet: { postures: { plaid: ["missing.profile"] } } },
			}),
		]),
	).toThrow(/repo\/\.prefer.*missing\.profile/);
});

test("merges only safe own keys and rejects prototype-polluting names", {
	tag: "@unit",
}, () => {
	const hubs: NonNullable<PostureOverlay["hubs"]> = {};
	Object.defineProperty(hubs, "__proto__", {
		value: {
			profiles: {
				p: {
					models: { m: { policy: "MUST", lanes: 2 } },
				},
			},
		},
		enumerable: true,
	});
	const overlay: PostureOverlay = { version: 1, hubs };

	expect(() =>
		resolvePosture(postureDocument(), [
			postureLayer("hostile/.prefer", overlay),
		]),
	).toThrow(/hostile\/\.prefer/);
	expect(Object.prototype).not.toHaveProperty("polluted");
});
