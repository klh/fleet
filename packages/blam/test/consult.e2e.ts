// consult.e2e.ts — W447 (W1294.12 sweep-I port from consult.test.ts):
// consult evaluation harness tests — plane behaviors, policy matrix,
// determinism, bench properties.
import { expect, test } from "@playwright/test";
import {
	checkProperties,
	DROP_FIRST,
	FRESH,
	runPolicy,
	STALE,
} from "../bench/consult/harness.ts";
import { ConsultPlane } from "../bench/consult/plane.ts";
import {
	DEFAULT_POLICY_COSTS,
	POLICIES,
	runTask,
} from "../bench/consult/policies.ts";
import {
	addMetrics,
	emptyMetrics,
	type TaskInstance,
	type TaskProfile,
} from "../bench/consult/types.ts";

function task(profile: string): TaskInstance {
	return {
		id: "t",
		// the bun original indexed the profile field's type; useLiteralKeys
		// prefers the imported name for the same type
		profile: profile as TaskProfile,
		codeVersion: "v2",
	};
}

test.describe("@unit", () => {
	test.describe("consult plane", () => {
		test("kbLookup reports staleness, never hides it", () => {
			const p = new ConsultPlane({
				experts: [{ scope: "s1", live: true }],
				kb: [
					{
						id: "k1",
						scope: "s1",
						codeVersion: "v1",
						answer: "a",
						verified: true,
					},
				],
				currentVersion: "v2",
				delivery: "ok",
				latencyMin: 6,
			});
			const hit = p.kbLookup("s1");
			expect(hit?.stale).toBe(true);
		});

		test("ask returns no-expert when no live expert covers the scope", () => {
			const p = new ConsultPlane({
				experts: [],
				kb: [],
				currentVersion: "v2",
				delivery: "ok",
				latencyMin: 6,
			});
			expect(p.ask("t", "s1").kind).toBe("no-expert");
		});
	});

	test.describe("consult policies", () => {
		test("arm A burns duplicate investigation and fails conflicting-assumptions", () => {
			const a = runPolicy("current-instructions", FRESH);
			expect(a.total.duplicateInvestigationUnits).toBe(6);
			const ca = a.perTask.find((t) => t.profile === "conflicting-assumptions");
			expect(ca?.correct).toBe(false);
		});

		test("trigger applies the stale row on the stale plane (H8)", () => {
			const b = runPolicy("trigger", STALE);
			expect(b.total.staleAnswers).toBe(1);
			const mk = b.perTask.find((t) => t.profile === "migration-knowledge");
			expect(mk?.correct).toBe(false);
			expect(mk?.staleApplied).toBe(true);
		});

		test("verified-reuse falls through to a live consult on a stale row", () => {
			const c = runPolicy("trigger+verified-reuse", STALE);
			expect(c.total.staleAnswers).toBe(0);
			expect(c.total.correctTasks).toBe(4);
			expect(c.total.attemptedCalls).toBe(3);
		});

		test("delivery failures are counted and retried once", () => {
			const c = runPolicy("trigger+verified-reuse", DROP_FIRST);
			expect(c.total.deliveryFailures).toBe(2);
			expect(c.total.retries).toBe(2);
			expect(c.total.correctTasks).toBe(4);
		});
	});

	test.describe("harness properties and metrics", () => {
		test("all six bench properties hold", () => {
			expect(checkProperties()).toEqual([]);
		});

		test("identical runs are byte-identical (no RNG)", () => {
			const a = runPolicy("trigger", FRESH);
			const b = runPolicy("trigger", FRESH);
			expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		});

		test("addMetrics sums every counter", () => {
			const m = addMetrics(emptyMetrics(), emptyMetrics());
			expect(m.consultationOpportunities).toBe(0);
			const x = { ...emptyMetrics(), attemptedCalls: 2 };
			const y = { ...emptyMetrics(), attemptedCalls: 3 };
			expect(addMetrics(x, y).attemptedCalls).toBe(5);
		});

		test("control group is never consulted by any arm", () => {
			for (const arm of Object.keys(POLICIES) as Array<keyof typeof POLICIES>) {
				const r = runTask(
					{
						plane: new ConsultPlane({
							experts: [],
							kb: [],
							currentVersion: "v2",
							delivery: "ok",
							latencyMin: 6,
						}),
						task: task("no-consult-control"),
						costs: DEFAULT_POLICY_COSTS,
					},
					POLICIES[arm],
				);
				expect(r.metrics.attemptedCalls).toBe(0);
				expect(r.metrics.correctTasks).toBe(1);
			}
		});
	});
});
