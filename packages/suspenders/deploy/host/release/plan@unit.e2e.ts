import { imageMetadata } from "./test-fixture.ts";
import { expect, test } from "@playwright/test";
import { acceptanceFor, releasePlan, registryPreflight } from "./plan.ts";
import { fixture, request, now } from "./test-fixture.ts";

test("plan pins independent version/source/recipe and emits no invented digest @unit", () => {
	const plan = releasePlan(request, fixture().acceptance, imageMetadata, now);
	expect(plan.tag).toBe(
		"ghcr.io/klh/fleet/supervisor-seed:0.1.2-experimental.w29904",
	);
	expect(plan.publication).toBe("not-published");
	expect(plan).not.toHaveProperty("image");
	expect(plan.argv).toContain("--push");
	expect(plan.argv).not.toContain("--load");
	expect(plan.argv).toContain(`SOURCE_COMMIT=${request.sourceCommit}`);
	expect(plan.argv).toContain(`RECIPE_COMMIT=${request.recipeCommit}`);
});
test("missing/basic/stale/future acceptance and identity drift refuse @unit", () => {
	const { acceptance } = fixture();
	const receipt = acceptance[0];
	for (const candidate of [
		undefined,
		[{ ...receipt, kind: "basic-wiring" }],
		[{ ...receipt, completedAt: "2026-11-10T11:00:00Z" }],
		[{ ...receipt, completedAt: "2026-11-12T13:00:00Z" }],
		[{ ...receipt, sourceCommit: "f".repeat(40) }],
		[{ ...receipt, recipeCommit: "f".repeat(40) }],
		[{ ...receipt, version: "0.2.0-experimental.drift" }],
		[{ ...receipt, platform: "linux/amd64" }],
		[
			{
				...receipt,
				controls: { ...receipt.controls, priorJournalContent: false },
			},
		],
	])
		expect(() => releasePlan(request, candidate, imageMetadata, now)).toThrow();
	expect(() =>
		releasePlan(
			{ ...request, platforms: ["linux/arm64", "linux/arm64"] },
			acceptance,
			imageMetadata,
			now,
		),
	).toThrow();
	expect(() =>
		acceptanceFor(request, acceptance, "linux/amd64", now),
	).toThrow();
});
test("preflight requires existing private exact package linked to canonical repository @unit", () => {
	const metadata = {
		name: "fleet/supervisor-seed",
		package_type: "container",
		visibility: "private",
		repository: { full_name: "klh/fleet", private: true },
	};
	expect(registryPreflight(metadata).visibility).toBe("private");
	for (const delta of [
		{ visibility: "public" },
		{ repository: null },
		{ repository: { full_name: "other/fleet", private: true } },
		{ name: "fleet/buckle-seed" },
		{ package_type: "npm" },
	])
		expect(() => registryPreflight({ ...metadata, ...delta })).toThrow();
});

test("release semantic version and platform pins refuse ambiguous identities @unit", () => {
	for (const version of [
		"01.1.2-experimental.w29904",
		"0.1.2-experimental.bad_id",
		"0.1.2-experimental.01",
		"0.1.2",
		"latest",
	]) {
		const f = fixture();
		expect(() =>
			releasePlan(
				{ ...request, version },
				[{ ...f.acceptance[0], version }],
				imageMetadata,
				now,
			),
		).toThrow();
	}
});

test("reviewable plan exposes the actual private candidate upload command @unit", () => {
	const f = fixture();
	const plan = releasePlan(request, f.acceptance, imageMetadata, now);
	expect(plan.argv[plan.argv.indexOf("--tag") + 1]).toBe(plan.candidate);
	expect(plan.candidate).toContain("-candidate-");
	expect(plan.requestSha256).toMatch(/^[a-f0-9]{64}$/);
	expect(plan.candidate.endsWith(plan.requestSha256.slice(0, 12))).toBe(true);
});

test("plan emits immutable derived CREATED and records epochs without source-date override @unit", () => {
	const plan = releasePlan(request, fixture().acceptance, imageMetadata, now);
	expect(plan.argv).toContain(`CREATED=${imageMetadata.created}`);
	expect(plan.imageMetadata).toEqual({
		...imageMetadata,
		derivation: "max(sourceCommit.committerEpoch,recipeCommit.committerEpoch)",
	});
	expect(plan.argv.some((arg) => arg.includes("SOURCE_DATE_EPOCH"))).toBe(
		false,
	);
});
