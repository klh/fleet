import { expect, test } from "bun:test";
import {
	type ExecutionClaim,
	type ExecutionEvidence,
	executionSummary,
	workExecution,
} from "../hooks/lib/work-execution.ts";

const claim: ExecutionClaim = {
	project: "p",
	id: "W1",
	state: "CLAIMED",
	owner_sid: "owner",
	result_sha: null,
};
const evidence: ExecutionEvidence = {
	project: "p",
	item: "W1",
	sid: "owner",
	observedAt: 100,
	process: true,
	lease: "alive",
	lifecycle: "RUNNING",
	lifecycleAt: 80,
	attempt: 2,
};
test("claims are not workers; exact project/item/owner binding is mandatory", () => {
	const rows = Array.from({ length: 17 }, (_, i) => {
		const c = { ...claim, id: `W${i + 1}` };
		return { ...c, execution: workExecution(c, evidence, [], 100) };
	});
	expect(executionSummary(rows)).toMatchObject({
		claims: 17,
		owners: 1,
		live_harnesses: 1,
		unknown: 16,
	});
	for (const e of [
		{ ...evidence, project: "other" },
		{ ...evidence, sid: "old-owner" },
	])
		expect(workExecution(claim, e, [], 100).state).toBe("unknown");
});
test("live harness has no invented progress; fresh transcript lease is not execution", () => {
	expect(workExecution(claim, evidence, [], 200).state).toBe("unknown");
	expect(workExecution(claim, evidence, [], 100)).toMatchObject({
		state: "live-harness",
		progress: null,
		observed_at: 100,
		process_observed_at: 100,
	});
	expect(
		workExecution(claim, { ...evidence, process: false }, [], 100).state,
	).toBe("unknown");
	expect(
		workExecution(
			claim,
			{ ...evidence, process: false, lease: "dead" },
			[],
			100,
		).state,
	).toBe("dead");
	expect(
		workExecution(claim, { ...evidence, lifecycle: "PAUSED" }, [], 100).state,
	).toBe("paused");
});
test("DONE and exact commit review/landing retain timestamps without asserting publication", () => {
	const done = { ...claim, state: "DONE", result_sha: "commit" };
	const artifact = {
		project: "p",
		item: "W1",
		commit: "commit",
		stage: "landed" as const,
		ts: 90,
	};
	expect(workExecution(done, evidence, [artifact], 100)).toMatchObject({
		state: "completed",
		progress: artifact,
	});
	expect(
		workExecution(
			done,
			evidence,
			[
				{ ...artifact, commit: "old" },
				{ ...artifact, project: "other" },
			],
			100,
		).progress,
	).toBeNull();
	expect(
		workExecution(
			done,
			evidence,
			[{ ...artifact, stage: "review-blocked" }],
			100,
		).progress?.stage,
	).toBe("review-blocked");
});
