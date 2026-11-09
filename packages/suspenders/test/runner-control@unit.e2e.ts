import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	ControlJobSchema,
	digestOf,
	RunnerSpecSchema,
} from "../hooks/lib/runners/control/control-state.ts";
import {
	assertTransition,
	canTransition,
	TRANSITIONS,
} from "../hooks/lib/runners/control/lifecycle.ts";

const digest = () => digestOf(`fixture-${Math.random()}`);

/** Root-shaped durable spec (the W2869.1 contract the controller admits). */
const specInput = () => ({
	version: 1 as const,
	runId: crypto.randomUUID(),
	owner: "lane-witness",
	generation: 1,
	kind: "coding" as const,
	seedDigest: digest(),
	policyDigest: digest(),
	provider: "belt",
	model: "glm-5.3",
});

test.describe("runner job identity (W2869.2)", () => {
	test("digestOf mints sha256 hex (node:crypto — no Bun globals)", () => {
		const d = digestOf("probe");
		expect(d).toMatch(/^[0-9a-f]{64}$/);
		expect(digestOf("probe")).toBe(d);
	});

	test("RunnerSpec admits the W2869.1 durable shape and strict-refuses drift", () => {
		const spec = RunnerSpecSchema.parse(specInput());
		expect(spec.generation).toBe(1);
		const bad = RunnerSpecSchema.safeParse({
			...specInput(),
			sneaky: true,
		});
		expect(bad.success).toBe(false);
	});

	test("ControlJob carries only controller closure state with defaults", () => {
		const job = ControlJobSchema.parse({
			runId: crypto.randomUUID(),
			generation: 1,
			state: "cold",
			created_at: 1,
			updated_at: 1,
		});
		expect(job.auto_park).toBe(true);
		expect(job.held_interrupts).toEqual([]);
		expect(job.cursor_base).toBe(0);
		const bad = ControlJobSchema.safeParse({
			runId: crypto.randomUUID(),
			generation: 1,
			state: "cold",
			created_at: 1,
			updated_at: 1,
			sneaky: true,
		});
		expect(bad.success).toBe(false);
	});

	test("malformed digests and bad generation refuse at the boundary", () => {
		expect(
			RunnerSpecSchema.safeParse({ ...specInput(), seedDigest: "nope" })
				.success,
		).toBe(false);
		expect(
			RunnerSpecSchema.safeParse({ ...specInput(), generation: 0 }).success,
		).toBe(false);
	});
});

test.describe("runner lifecycle (W2869.2)", () => {
	test("legal paths: coldstart, park/resume, stop", () => {
		expect(canTransition("cold", "running")).toBe(true);
		expect(canTransition("cold", "parked")).toBe(true);
		expect(canTransition("running", "parked")).toBe(true);
		expect(canTransition("parked", "running")).toBe(true);
		expect(canTransition("parked", "stopping")).toBe(true);
		expect(canTransition("stopping", "stopped")).toBe(true);
		expect(canTransition("stopping", "failed")).toBe(true);
	});

	test("terminal states never transition; illegal jumps throw loud", () => {
		for (const terminal of ["stopped", "failed"] as const) {
			expect(TRANSITIONS[terminal].length).toBe(0);
		}
		expect(canTransition("running", "cold")).toBe(false);
		expect(canTransition("stopped", "running")).toBe(false);
		expect(() => assertTransition("running", "cold")).toThrow(
			/illegal lifecycle transition running → cold/,
		);
		assertTransition("parked", "running");
	});

	test("scratchWorld isolation stays honest (kit rides every new suite)", () => {
		const w = scratchWorld({ prefix: "runner-control-" });
		try {
			expect(w.home).toContain("runner-control-");
		} finally {
			w.clean();
		}
	});
});
