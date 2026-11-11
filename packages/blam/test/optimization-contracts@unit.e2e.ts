import { expect, test } from "@playwright/test";
import * as paired from "../bench/paired/live.ts";

const manifest = {
	repo: "/tmp/example-source",
	baseRef: "a".repeat(40),
	task: "Fix the documented behavior",
	model: "pinned-route",
	baseline: "",
	candidate: "Run the public reproduction first",
	reps: 3,
	timeoutMs: 600000,
	outputDir: "/tmp/example-receipts",
	executor: ["bun", "executor.ts", "{worktree}", "{model}", "{prompt}"],
	judge: ["bun", "/tmp/private-oracle/judge.ts", "{worktree}"],
};

test("first useful result requires behavioral or source evidence @unit", async () => {
	const { CampaignEventSchema } = await import("../bench/optimize/protocol.ts");
	const event = {
		version: 1,
		runId: "run-1",
		at: "2026-11-11T09:00:00Z",
		kind: "first_useful_result",
		evidenceSha256: "1".repeat(64),
		evidenceKind: "behavioral-test",
		elapsedMs: 15,
		childRunIds: [],
	};
	expect(CampaignEventSchema.safeParse(event).success).toBe(true);
	expect(
		CampaignEventSchema.safeParse({ ...event, evidenceKind: "receipt" })
			.success,
	).toBe(false);
	expect(
		CampaignEventSchema.safeParse({ ...event, evidenceSha256: null }).success,
	).toBe(false);
});

test("paired manifests expose a shared runtime contract and reject malformed searches @unit", () => {
	const schema = Reflect.get(paired, "LiveManifestSchema");
	expect(schema, "Shared paired manifest schema must exist").toBeDefined();
	expect(schema.safeParse(manifest).success).toBe(true);
	expect(schema.safeParse({ ...manifest, reps: 0 }).success).toBe(false);
	expect(schema.safeParse({ ...manifest, timeoutMs: -1 }).success).toBe(false);
	expect(schema.safeParse({ ...manifest, executor: [] }).success).toBe(false);
	expect(schema.safeParse({ ...manifest, secret: "unexpected" }).success).toBe(
		false,
	);
});

test("paired receipt contract rejects invented usage and incomplete provenance @unit", async () => {
	const schema = Reflect.get(paired, "ArmReceiptSchema");
	expect(schema, "Shared paired receipt schema must exist").toBeDefined();
	const { validAttempt } = await import("./optimization.fixtures.ts");
	const receipt = validAttempt().receipt;
	expect(schema.safeParse(receipt).success).toBe(true);
	expect(schema.safeParse({ ...receipt, tokens: null }).success).toBe(true);
	expect(schema.safeParse({ ...receipt, tokens: -4 }).success).toBe(false);
	expect(schema.safeParse({ ...receipt, quality: 2 }).success).toBe(false);
	expect(schema.safeParse({ arm: "candidate", tokens: -4 }).success).toBe(
		false,
	);
});

test("recommendations require distinct holdouts and cannot activate themselves @unit", async () => {
	const { RecommendationSchema } = await import(
		"../bench/optimize/protocol.ts"
	);
	const { validCase, validStrategy } = await import(
		"./optimization.fixtures.ts"
	);
	const scenario = validCase(),
		strategy = validStrategy();
	const profile = {
		version: 1,
		state: "recommendation",
		repository: scenario.repository,
		repositoryFingerprint: scenario.repositoryFingerprint,
		language: scenario.language,
		problemClass: scenario.problemClass,
		image: scenario.image,
		strategy,
		caseIds: ["issue-a", "issue-b"],
		confirmations: 3,
		historySha256: "1".repeat(64),
		createdAt: "2026-11-11T09:00:00Z",
	};
	expect(RecommendationSchema.safeParse(profile).success).toBe(true);
	expect(
		RecommendationSchema.safeParse({
			...profile,
			caseIds: ["issue-a", "issue-a"],
		}).success,
	).toBe(false);
	expect(
		RecommendationSchema.safeParse({ ...profile, confirmations: 2 }).success,
	).toBe(false);
	expect(
		RecommendationSchema.safeParse({ ...profile, state: "active" }).success,
	).toBe(false);
});

test("cases require repeated red/green controls and hide oracle inputs @unit", async () => {
	const { CaseSchema, publicTask } = await import("../bench/optimize/cases.ts");
	const { validCase } = await import("./optimization.fixtures.ts");
	const input = validCase();
	expect(CaseSchema.safeParse(input).success).toBe(true);
	expect(
		CaseSchema.safeParse({ ...input, controls: input.controls.slice(0, 1) })
			.success,
	).toBe(false);
	const greenBase = validCase();
	greenBase.controls[0].base.targetsPassed = 3;
	expect(CaseSchema.safeParse(greenBase).success).toBe(false);
	const brokenFix = validCase();
	brokenFix.controls[1].fixed.regressionsPassed = 58;
	expect(CaseSchema.safeParse(brokenFix).success).toBe(false);
	const task = publicTask(input);
	expect(task).toEqual({
		caseId: input.id,
		task: input.brief,
		baseSha: input.baseSha,
		language: "typescript",
		problemClass: "regression",
	});
	expect(JSON.stringify(task)).not.toContain("private-oracle");
});

test("attempt assessment distinguishes incorrect patches from unreliable measurements @unit", async () => {
	const { assessAttempt } = await import("../bench/optimize/evidence.ts");
	const { validCase, validStrategy, validAttempt } = await import(
		"./optimization.fixtures.ts"
	);
	const input = validCase(),
		strategy = validStrategy();
	const good = validAttempt();
	expect(assessAttempt(input, strategy, good).kind).toBe("accepted");
	const wrong = validAttempt();
	wrong.checks.targetsPassed = 2;
	wrong.receipt.quality = 2 / 3;
	expect(assessAttempt(input, strategy, wrong).kind).toBe("quality_failure");
	const missingUsage = validAttempt();
	missingUsage.receipt.tokens = 0;
	expect(assessAttempt(input, strategy, missingUsage).kind).toBe(
		"invalid_evidence",
	);
	const leaked = validAttempt();
	leaked.cleanup.keysRevoked = false;
	expect(assessAttempt(input, strategy, leaked).kind).toBe("invalid_evidence");
	const drift = validAttempt();
	drift.receipt.baseSha = "9".repeat(40);
	expect(assessAttempt(input, strategy, drift).kind).toBe("invalid_evidence");
	const censored = validAttempt();
	const ineffective = validAttempt();
	ineffective.settings.verified = false;
	const wrongEffort = validAttempt();
	wrongEffort.settings.effectiveEffort = "high";
	expect(assessAttempt(input, strategy, wrongEffort).kind).toBe(
		"invalid_evidence",
	);
	const wrongOracle = validAttempt();
	wrongOracle.oracleSha256 = "0".repeat(64);
	expect(assessAttempt(input, strategy, wrongOracle).kind).toBe(
		"invalid_evidence",
	);
	const wrongContext = validAttempt();
	wrongContext.receipt.harnessSha256 = "0".repeat(64);
	expect(assessAttempt(input, strategy, wrongContext).kind).toBe(
		"invalid_evidence",
	);
	expect(assessAttempt(input, strategy, ineffective).kind).toBe(
		"invalid_evidence",
	);
	censored.receipt.timedOut = true;
	expect(assessAttempt(input, strategy, censored).kind).toBe("censored");
});
