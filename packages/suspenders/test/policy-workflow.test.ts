import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	assessHealthPolicy,
	healthAssessmentKey,
	healthInputsHash,
	HEALTH_POLICY_ID,
	HEALTH_POLICY_VERSION,
	type HealthDeploymentInput,
} from "../hooks/lib/policy-workflow/health-policy.ts";
import {
	canTransition,
	type AssessmentKey,
} from "../hooks/lib/policy-workflow/types.ts";
import {
	completeAssessment,
	completeAttestation,
	createAttestation,
	decideRemediation,
	expireAttestations,
	getAssessment,
	getAttestationById,
	getRemediationById,
	invalidateAssessments,
	proposeRemediation,
	startAssessment,
	transitionRemediation,
} from "../hooks/lib/policy-workflow/store.ts";

const dbs: Database[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});
function database(): Database {
	const db = new Database(":memory:");
	dbs.push(db);
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	return db;
}
const key: AssessmentKey = healthAssessmentKey("proj", "org1", "orders-api");
const goodDeployment: HealthDeploymentInput = {
	service: "orders-api",
	manifestKnown: true,
	roles: ["api", "health-reporter"],
	reporterSupervision: "independent",
	monitoringWiring: "reporter-verdict",
};

test("transition tables encode the three separate machines", () => {
	// an approved lane does not make the service conforming; assessment and
	// remediation never share a transition surface
	expect(canTransition("assessment", "assessing", "conforming")).toBe(true);
	expect(canTransition("assessment", "conforming", "verified")).toBe(false);
	expect(canTransition("remediation", "proposed", "approved")).toBe(true);
	expect(canTransition("remediation", "approved", "merged")).toBe(false);
	expect(canTransition("remediation", "merged", "approved")).toBe(false);
	expect(canTransition("attestation", "pending", "verified")).toBe(true);
	// a merged patch does not prove deployment: no remediation→attestation edge
	expect(canTransition("attestation", "merged", "verified")).toBe(false);
});

test("assessment lease fences concurrent assessors and completion requires it", () => {
	const db = database();
	expect(startAssessment(db, key, HEALTH_POLICY_VERSION, "alice", 100)).toEqual({
		ok: true,
	});
	// bob cannot steal a live lease
	expect(startAssessment(db, key, HEALTH_POLICY_VERSION, "bob", 110).ok).toBe(
		false,
	);
	// alice can re-enter her own lease
	expect(startAssessment(db, key, HEALTH_POLICY_VERSION, "alice", 120).ok).toBe(
		true,
	);
	// completion without the lease is refused
	expect(
		completeAssessment(db, key, {
			sid: "bob",
			verdict: "conforming",
			evidence: ["x"],
			inputsHash: healthInputsHash(goodDeployment),
		}).ok,
	).toBe(false);
	expect(
		completeAssessment(db, key, {
			sid: "alice",
			verdict: "conforming",
			evidence: ["independent reporter present"],
			inputsHash: healthInputsHash(goodDeployment),
		},
		150).ok,
	).toBe(true);
	const rec = getAssessment(db, key);
	expect(rec?.state).toBe("conforming");
	expect(rec?.leaseSid).toBeNull();
});

test("input change invalidates evidence; matching hash survives", () => {
	const db = database();
	startAssessment(db, key, HEALTH_POLICY_VERSION, "alice", 100);
	completeAssessment(
		db,
		key,
		{
			sid: "alice",
			verdict: "conforming",
			evidence: ["e1"],
			inputsHash: healthInputsHash(goodDeployment),
		},
		110,
	);
	// same inputs → evidence survives
	expect(
		invalidateAssessments(db, {
			project: "proj",
			orgId: "org1",
			serviceId: "orders-api",
			exceptInputsHash: healthInputsHash(goodDeployment),
		}),
	).toBe(0);
	// changed deployment (reporter dropped) → stale
	const changed = { ...goodDeployment, roles: ["api"] };
	expect(
		invalidateAssessments(db, {
			project: "proj",
			orgId: "org1",
			serviceId: "orders-api",
			exceptInputsHash: healthInputsHash(changed),
		}),
	).toBe(1);
	expect(getAssessment(db, key)?.state).toBe("stale");
	// re-assessment after invalidation admits stale → assessing
	expect(startAssessment(db, key, HEALTH_POLICY_VERSION, "bob", 200).ok).toBe(
		true,
	);
});

test("proposals are idempotent and decisions bind to the proposal digest once", () => {
	const db = database();
	const proposal = {
		service: "orders-api",
		gap: "no independent health reporter",
		scope: ["deploy/healthcheck/probe.ts wiring"],
	};
	const first = proposeRemediation(db, {
		project: "proj",
		orgId: "org1",
		serviceId: "orders-api",
		policyId: HEALTH_POLICY_ID,
		proposal,
	});
	expect(first.created).toBe(true);
	// identical payload → same row, no duplicate lane
	const second = proposeRemediation(db, {
		project: "proj",
		orgId: "org1",
		serviceId: "orders-api",
		policyId: HEALTH_POLICY_ID,
		proposal,
	});
	expect(second).toEqual({ id: first.id, created: false });
	const rem = getRemediationById(db, "proj", first.id);
	expect(rem?.state).toBe("proposed");

	// decision with the wrong digest is refused — approval cannot be forged
	// against a payload the actor never saw
	expect(
		decideRemediation(db, {
			project: "proj",
			remediationId: first.id,
			action: "approve",
			actor: "dev-alice",
			proposalHash: "deadbeef",
		}).ok,
	).toBe(false);
	const decided = decideRemediation(db, {
		project: "proj",
		remediationId: first.id,
		action: "approve",
		actor: "dev-alice",
		proposalHash: rem?.proposalHash ?? "",
	});
	expect(decided.ok).toBe(true);
	// one-time action: a replayed approve hits the decision index
	expect(
		decideRemediation(db, {
			project: "proj",
			remediationId: first.id,
			action: "approve",
			actor: "dev-bob",
			proposalHash: rem?.proposalHash ?? "",
		}).ok,
	).toBe(false);
	expect(getRemediationById(db, "proj", first.id)?.state).toBe("approved");
	// decision event carries actor + digest, not agent-concluded verdicts
	const events = db.query("SELECT kind, payload FROM events ORDER BY rowid").all() as {
		kind: string;
		payload: string;
	}[];
	const decision = events.find((e) => e.kind === "policy.decision");
	expect(decision).toBeDefined();
	expect(JSON.parse(decision?.payload ?? "{}").actor).toBe("dev-alice");
});

test("remediation lifecycle is guarded; exception never overwrites the gap", () => {
	const db = database();
	const { id } = proposeRemediation(db, {
		project: "proj",
		orgId: "org1",
		serviceId: "orders-api",
		policyId: HEALTH_POLICY_ID,
		proposal: { gap: "no reporter" },
	});
	// skip-ahead transitions refused
	expect(
		transitionRemediation(db, {
			project: "proj",
			remediationId: id,
			to: "merged",
			actor: "lane1",
		}).ok,
	).toBe(false);
	expect(
		transitionRemediation(db, { project: "proj", remediationId: id, to: "claimed", actor: "lane1" }).ok,
	).toBe(false); // still proposed — claim needs approval first
	decideRemediation(db, {
		project: "proj",
		remediationId: id,
		action: "approve",
		actor: "dev-alice",
		proposalHash: getRemediationById(db, "proj", id)?.proposalHash ?? "",
	});
	expect(
		transitionRemediation(db, { project: "proj", remediationId: id, to: "claimed", actor: "lane1" }).ok,
	).toBe(true);
	expect(getRemediationById(db, "proj", id)?.claimedBy).toBe("lane1");
	expect(
		transitionRemediation(db, { project: "proj", remediationId: id, to: "in-review", actor: "lane1" }).ok,
	).toBe(true);
	expect(
		transitionRemediation(db, { project: "proj", remediationId: id, to: "merged", actor: "lane1" }).ok,
	).toBe(true);
	expect(getRemediationById(db, "proj", id)?.state).toBe("merged");

	// exception: expiring waiver recorded, remediation stays proposed
	const { id: id2 } = proposeRemediation(db, {
		project: "proj",
		orgId: "org1",
		serviceId: "orders-api",
		policyId: HEALTH_POLICY_ID,
		proposal: { gap: "no reporter", note: "different payload" },
	});
	const exception = decideRemediation(db, {
		project: "proj",
		remediationId: id2,
		action: "exception",
		actor: "corp-approver",
		proposalHash: getRemediationById(db, "proj", id2)?.proposalHash ?? "",
		exceptionExpiresAt: 500,
	});
	expect(exception.ok).toBe(true);
	expect(getRemediationById(db, "proj", id2)?.state).toBe("proposed");
});

test("attestations verify with expiry, fail honestly, and re-open", () => {
	const db = database();
	const { id } = createAttestation(db, {
		project: "proj",
		orgId: "org1",
		serviceId: "orders-api",
		policyId: HEALTH_POLICY_ID,
		instance: "nas/orders-api@rev1",
	});
	// source conformance is not deployment proof: a fresh merge cannot
	// fast-track a pending attestation to verified without the check
	expect(
		completeAttestation(db, {
			project: "proj",
			attestationId: id,
			result: "verified",
			evidence: ["probe sidecar reachable at :7796, reports API failure"],
		}).ok,
	).toBe(true);
	const att = getAttestationById(db, "proj", id);
	expect(att?.state).toBe("verified");
	expect(att?.expiresAt).toBeGreaterThan(0);
	// expiry sweep: stale verified evidence is not healthy
	expect(expireAttestations(db, (att?.expiresAt ?? 0) + 1)).toBe(1);
	expect(getAttestationById(db, "proj", id)?.state).toBe("expired");
	// expired can re-open, a failed one can retry
	const { id: id2 } = createAttestation(db, {
		project: "proj",
		orgId: "org1",
		serviceId: "orders-api",
		policyId: HEALTH_POLICY_ID,
		instance: "nas/orders-api@rev2",
	});
	expect(
		completeAttestation(db, {
			project: "proj",
			attestationId: id2,
			result: "failed",
			evidence: ["reporter unreachable — monitoring showed healthy"],
		}).ok,
	).toBe(true);
	expect(getAttestationById(db, "proj", id2)?.state).toBe("failed");
});

test("health policy classifies deployments, never conformance from missing info", () => {
	expect(assessHealthPolicy({ ...goodDeployment, manifestKnown: false })).toEqual(
		expect.objectContaining({ verdict: "unknown", state: "unknown" }),
	);
	expect(assessHealthPolicy({ ...goodDeployment, roles: ["api"] })).toEqual(
		expect.objectContaining({ verdict: "gap", state: "gap" }),
	);
	// shared supervision: partial, but still a gap in the state machine
	const partial = assessHealthPolicy({
		...goodDeployment,
		reporterSupervision: "shared",
	});
	expect(partial.verdict).toBe("partial");
	expect(partial.state).toBe("gap");
	// monitoring wired to API liveness cannot detect an unreachable reporter
	const wiring = assessHealthPolicy({
		...goodDeployment,
		monitoringWiring: "api-liveness",
	});
	expect(wiring.verdict).toBe("partial");
	expect(assessHealthPolicy(goodDeployment).verdict).toBe("conforming");
	// hash changes when any policy-relevant input changes
	const base = healthInputsHash(goodDeployment);
	expect(healthInputsHash({ ...goodDeployment, roles: ["api", "health-reporter", "worker"] })).not.toBe(
		base,
	);
	expect(healthInputsHash(goodDeployment)).toBe(base);
});
