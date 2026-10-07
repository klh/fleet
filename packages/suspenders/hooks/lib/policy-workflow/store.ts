// hooks/lib/policy-workflow/store.ts — W462 policy workflow persistence over
// governor.db. Own tables (created lazily, same pattern as failure-recovery):
// one assessment per project/org/service/policy, idempotent remediation
// proposals keyed by payload digest, one-time authenticated decisions bound to
// the exact proposal hash, and deployment attestations with expiry. All
// mutations are transactional and transition-guarded; an assessment lease
// fences concurrent assessors so two hubs cannot publish competing results.
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
	canTransition,
	type AssessmentKey,
	type AssessmentRecord,
	type AssessmentState,
	type AttestationRecord,
	type DecisionRecord,
	type AttestationState,
	type DecisionAction,
	type RemediationRecord,
	type RemediationState,
} from "./types.ts";

export const DEFAULT_LEASE_MS = 10 * 60_000;
export const DECISION_ACTIONS: readonly DecisionAction[] = [
	"approve",
	"defer",
	"exception",
];

function schema(db: Database): void {
	db.run(`CREATE TABLE IF NOT EXISTS policy_assessments (
		project TEXT NOT NULL, org_id TEXT NOT NULL, service_id TEXT NOT NULL,
		policy_id TEXT NOT NULL, policy_version TEXT NOT NULL DEFAULT '',
		state TEXT NOT NULL DEFAULT 'pending', verdict TEXT, evidence TEXT,
		inputs_hash TEXT NOT NULL DEFAULT '',
		lease_sid TEXT, lease_expires INTEGER,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		PRIMARY KEY (project, org_id, service_id, policy_id))`);
	db.run(`CREATE TABLE IF NOT EXISTS policy_remediations (
		project TEXT NOT NULL, id TEXT NOT NULL, org_id TEXT NOT NULL,
		service_id TEXT NOT NULL, policy_id TEXT NOT NULL,
		org_service_policy_key TEXT NOT NULL, proposal_hash TEXT NOT NULL,
		proposal TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'proposed',
		claimed_by TEXT, decision_ref TEXT,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		PRIMARY KEY (project, id))`);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS policy_remediations_payload ON policy_remediations(project, proposal_hash)",
	);
	db.run(`CREATE TABLE IF NOT EXISTS policy_decisions (
		project TEXT NOT NULL, id TEXT NOT NULL, remediation_id TEXT NOT NULL,
		action TEXT NOT NULL, actor TEXT NOT NULL, proposal_hash TEXT NOT NULL,
		expires_at INTEGER, decided_at INTEGER NOT NULL,
		PRIMARY KEY (project, id))`);
	// one-time decision actions: a replayed approve/defer hits this index
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS policy_decisions_once ON policy_decisions(project, remediation_id, action)",
	);
	db.run(`CREATE TABLE IF NOT EXISTS policy_attestations (
		project TEXT NOT NULL, id TEXT NOT NULL, org_id TEXT NOT NULL,
		service_id TEXT NOT NULL, policy_id TEXT NOT NULL, instance TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'pending', evidence TEXT,
		verified_at INTEGER, expires_at INTEGER,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		PRIMARY KEY (project, id))`);
	// W539 — the ONE authorized remediation work item: concurrent approvers
	// replay the same digest and all read back the same graph id.
	const remCols = (
		db.query("PRAGMA table_info(policy_remediations)").all() as {
			name: string;
		}[]
	).map((c) => c.name);
	if (!remCols.includes("work_id"))
		db.run("ALTER TABLE policy_remediations ADD COLUMN work_id TEXT");
}

export function canonicalHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function emit(
	db: Database,
	now: number,
	kind: string,
	scope: string,
	payload: unknown,
): void {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, NULL)",
	).run(now, "policy-workflow", kind, scope, JSON.stringify(payload));
}

function rowToAssessment(r: Record<string, unknown>): AssessmentRecord {
	return {
		project: r.project as string,
		orgId: r.org_id as string,
		serviceId: r.service_id as string,
		policyId: r.policy_id as string,
		policyVersion: r.policy_version as string,
		state: r.state as AssessmentState,
		verdict: (r.verdict as string | null) ?? null,
		evidence: (r.evidence as string | null) ?? null,
		inputsHash: r.inputs_hash as string,
		leaseSid: (r.lease_sid as string | null) ?? null,
		leaseExpires: (r.lease_expires as number | null) ?? null,
		createdAt: r.created_at as number,
		updatedAt: r.updated_at as number,
	};
}

function getAssessmentRow(
	db: Database,
	key: AssessmentKey,
): Record<string, unknown> | null {
	return db
		.query(
			"SELECT * FROM policy_assessments WHERE project = ? AND org_id = ? AND service_id = ? AND policy_id = ?",
		)
		.get(key.project, key.orgId, key.serviceId, key.policyId) as Record<
		string,
		unknown
	> | null;
}

export function getAssessment(
	db: Database,
	key: AssessmentKey,
): AssessmentRecord | null {
	schema(db);
	const row = getAssessmentRow(db, key);
	return row ? rowToAssessment(row) : null;
}

/** Start (or re-start) an assessment under a lease. Refused when another
 *  live lease holds it or the state does not admit assessing. */
export function startAssessment(
	db: Database,
	key: AssessmentKey,
	policyVersion: string,
	sid: string,
	now = Date.now(),
	leaseMs = DEFAULT_LEASE_MS,
): { ok: boolean; reason?: string } {
	schema(db);
	return db.transaction(() => {
		const row = getAssessmentRow(db, key);
		if (!row) {
			db.query(
				"INSERT INTO policy_assessments (project, org_id, service_id, policy_id, policy_version, state, inputs_hash, lease_sid, lease_expires, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'assessing', '', ?, ?, ?, ?)",
			).run(
				key.project,
				key.orgId,
				key.serviceId,
				key.policyId,
				policyVersion,
				sid,
				now + leaseMs,
				now,
				now,
			);
			return { ok: true };
		}
		const held = row.lease_sid as string | null;
		const expires = (row.lease_expires as number | null) ?? 0;
		if (held && held !== sid && expires > now)
			return { ok: false, reason: `assessment leased by ${held} until ${expires}` };
		// lease refresh (own live lease) or takeover of an expired one is not a
		// state-machine transition — only a fresh assess run is
		const assessing = row.state === "assessing";
		if (!assessing && !canTransition("assessment", row.state as string, "assessing"))
			return {
				ok: false,
				reason: `state ${String(row.state)} does not admit assessing`,
			};
		db.query(
			"UPDATE policy_assessments SET state = 'assessing', policy_version = ?, lease_sid = ?, lease_expires = ?, updated_at = ? WHERE project = ? AND org_id = ? AND service_id = ? AND policy_id = ?",
		).run(
			policyVersion,
			sid,
			now + leaseMs,
			now,
			key.project,
			key.orgId,
			key.serviceId,
			key.policyId,
		);
		return { ok: true };
	})();
}

/** Complete an assessment. Requires the caller's live lease (fencing);
 *  verdict maps to the state machine: conforming/gap/unknown. */
export function completeAssessment(
	db: Database,
	key: AssessmentKey,
	input: {
		sid: string;
		verdict: "conforming" | "gap" | "unknown";
		verdictDetail?: string;
		evidence: string[];
		inputsHash: string;
	},
	now = Date.now(),
): { ok: boolean; reason?: string } {
	schema(db);
	return db.transaction(() => {
		const row = getAssessmentRow(db, key);
		if (!row) return { ok: false, reason: "no assessment record" };
		if (row.lease_sid !== input.sid || (row.lease_expires as number) <= now)
			return { ok: false, reason: "no live assessment lease for caller" };
		if (!canTransition("assessment", row.state as string, input.verdict))
			return {
				ok: false,
				reason: `state ${String(row.state)} does not admit ${input.verdict}`,
			};
		db.query(
			"UPDATE policy_assessments SET state = ?, verdict = ?, evidence = ?, inputs_hash = ?, lease_sid = NULL, lease_expires = NULL, updated_at = ? WHERE project = ? AND org_id = ? AND service_id = ? AND policy_id = ?",
		).run(
			input.verdict,
			input.verdictDetail ?? input.verdict,
			JSON.stringify(input.evidence),
			input.inputsHash,
			now,
			key.project,
			key.orgId,
			key.serviceId,
			key.policyId,
		);
		emit(db, now, "policy.assessed", key.serviceId, {
			...key,
			verdict: input.verdict,
			inputsHash: input.inputsHash,
		});
		return { ok: true };
	})();
}

/** Invalidate assessments whose inputs changed. Verdicts derived from a
 *  matching inputsHash survive; everything else goes stale. Returns count. */
export function invalidateAssessments(
	db: Database,
	filter: {
		project: string;
		orgId: string;
		serviceId: string;
		policyId?: string;
		exceptInputsHash?: string;
	},
	now = Date.now(),
): number {
	schema(db);
	return db.transaction(() => {
		const rows = db
			.query(
				"SELECT * FROM policy_assessments WHERE project = ? AND org_id = ? AND service_id = ? AND state != 'stale'",
			)
			.all(filter.project, filter.orgId, filter.serviceId) as Record<
			string,
			unknown
		>[];
		let n = 0;
		for (const row of rows) {
			if (filter.policyId && row.policy_id !== filter.policyId) continue;
			if (filter.exceptInputsHash && row.inputs_hash === filter.exceptInputsHash)
				continue;
			db.query(
				"UPDATE policy_assessments SET state = 'stale', lease_sid = NULL, lease_expires = NULL, updated_at = ? WHERE project = ? AND org_id = ? AND service_id = ? AND policy_id = ?",
			).run(
				now,
				filter.project,
				filter.orgId,
				filter.serviceId,
				row.policy_id as string,
			);
			n++;
		}
		if (n > 0)
			emit(db, now, "policy.invalidated", filter.serviceId, {
				...filter,
				count: n,
			});
		return n;
	})();
}

/** Idempotent proposal creation: identical (keys + payload) digests return the
 *  existing remediation instead of minting a duplicate lane. */
export function proposeRemediation(
	db: Database,
	input: {
		project: string;
		orgId: string;
		serviceId: string;
		policyId: string;
		proposal: Record<string, unknown>;
	},
	now = Date.now(),
): { id: string; created: boolean } {
	schema(db);
	return db.transaction(() => {
		const key = `${input.orgId}/${input.serviceId}/${input.policyId}`;
		const proposalHash = canonicalHash({
			orgId: input.orgId,
			serviceId: input.serviceId,
			policyId: input.policyId,
			proposal: input.proposal,
		});
		const existing = db
			.query(
				"SELECT id FROM policy_remediations WHERE project = ? AND proposal_hash = ?",
			)
			.get(input.project, proposalHash) as { id: string } | null;
		if (existing) return { id: existing.id, created: false };
		const id = `PR-${randomUUID().slice(0, 8)}`;
		db.query(
			"INSERT INTO policy_remediations (project, id, org_id, service_id, policy_id, org_service_policy_key, proposal_hash, proposal, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)",
		).run(
			input.project,
			id,
			input.orgId,
			input.serviceId,
			input.policyId,
			key,
			proposalHash,
			JSON.stringify(input.proposal),
			now,
			now,
		);
		emit(db, now, "policy.proposed", input.serviceId, {
			id,
			...input,
			proposalHash,
		});
		return { id, created: true };
	})();
}

function getRemediation(
	db: Database,
	project: string,
	id: string,
): RemediationRecord | null {
	const r = db
		.query("SELECT * FROM policy_remediations WHERE project = ? AND id = ?")
		.get(project, id) as Record<string, unknown> | null;
	if (!r) return null;
	return {
		project: r.project as string,
		id: r.id as string,
		orgId: r.org_id as string,
		serviceId: r.service_id as string,
		policyId: r.policy_id as string,
		orgServicePolicyKey: r.org_service_policy_key as string,
		proposalHash: r.proposal_hash as string,
		proposal: r.proposal as string,
		state: r.state as RemediationState,
		claimedBy: (r.claimed_by as string | null) ?? null,
		decisionRef: (r.decision_ref as string | null) ?? null,
		workId: (r.work_id as string | null) ?? null,
		createdAt: r.created_at as number,
		updatedAt: r.updated_at as number,
	};
}

export function getRemediationById(
	db: Database,
	project: string,
	id: string,
): RemediationRecord | null {
	schema(db);
	return getRemediation(db, project, id);
}

/** Authenticated decision, recorded outside the agent's control. The caller
 *  must present the exact proposal digest; the action is one-time per
 *  remediation (unique index). Approve is the only path into `approved`;
 *  defer closes the proposal with the gap on record; exception records an
 *  expiring waiver without overwriting the assessment's factual gap. */
export function decideRemediation(
	db: Database,
	input: {
		project: string;
		remediationId: string;
		action: DecisionAction;
		actor: string;
		proposalHash: string;
		exceptionExpiresAt?: number;
	},
	now = Date.now(),
): { ok: boolean; reason?: string; decisionId?: string } {
	schema(db);
	return db.transaction(() => {
		const rem = getRemediation(db, input.project, input.remediationId);
		if (!rem) return { ok: false, reason: "unknown remediation" };
		if (rem.proposalHash !== input.proposalHash)
			return {
				ok: false,
				reason: `proposal hash mismatch: decision binds to ${rem.proposalHash}`,
			};
		const replay = db
			.query(
				"SELECT id FROM policy_decisions WHERE project = ? AND remediation_id = ? AND action = ?",
			)
			.get(input.project, input.remediationId, input.action) as {
			id: string;
		} | null;
		if (replay)
			return {
				ok: false,
				reason: `action ${input.action} already decided (${replay.id})`,
			};
		const target: RemediationState | null =
			input.action === "approve" ? "approved" : input.action === "defer" ? "cancelled" : null;
		if (target && !canTransition("remediation", rem.state, target))
			return {
				ok: false,
				reason: `state ${rem.state} does not admit ${target}`,
			};
		const decisionId = `PD-${randomUUID().slice(0, 8)}`;
		db.query(
			"INSERT INTO policy_decisions (project, id, remediation_id, action, actor, proposal_hash, expires_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.project,
			decisionId,
			input.remediationId,
			input.action,
			input.actor,
			input.proposalHash,
			input.action === "exception" ? (input.exceptionExpiresAt ?? null) : null,
			now,
		);
		if (target) {
			db.query(
				"UPDATE policy_remediations SET state = ?, decision_ref = ?, updated_at = ? WHERE project = ? AND id = ?",
			).run(target, decisionId, now, input.project, input.remediationId);
		}
		emit(db, now, "policy.decision", rem.serviceId, {
			decisionId,
			remediationId: input.remediationId,
			action: input.action,
			actor: input.actor,
			proposalHash: input.proposalHash,
		});
		return { ok: true, decisionId };
	})();
}

/** Guarded remediation transition (claim / review / merge / cancel). */
export function transitionRemediation(
	db: Database,
	input: {
		project: string;
		remediationId: string;
		to: RemediationState;
		actor: string;
	},
	now = Date.now(),
): { ok: boolean; reason?: string } {
	schema(db);
	return db.transaction(() => {
		const rem = getRemediation(db, input.project, input.remediationId);
		if (!rem) return { ok: false, reason: "unknown remediation" };
		if (!canTransition("remediation", rem.state, input.to))
			return { ok: false, reason: `state ${rem.state} does not admit ${input.to}` };
		if (input.to === "claimed") {
			db.query(
				"UPDATE policy_remediations SET state = ?, claimed_by = ?, updated_at = ? WHERE project = ? AND id = ?",
			).run(input.to, input.actor, now, input.project, input.remediationId);
		} else {
			db.query(
				"UPDATE policy_remediations SET state = ?, updated_at = ? WHERE project = ? AND id = ?",
			).run(input.to, now, input.project, input.remediationId);
		}
		emit(db, now, "policy.remediation", rem.serviceId, {
			id: input.remediationId,
			from: rem.state,
			to: input.to,
			actor: input.actor,
		});
		return { ok: true };
	})();
}

/** Open a deployment attestation (pending) for a concrete instance. */
export function createAttestation(
	db: Database,
	input: {
		project: string;
		orgId: string;
		serviceId: string;
		policyId: string;
		instance: string;
	},
	now = Date.now(),
): { id: string } {
	schema(db);
	return db.transaction(() => {
		const id = `PA-${randomUUID().slice(0, 8)}`;
		db.query(
			"INSERT INTO policy_attestations (project, id, org_id, service_id, policy_id, instance, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
		).run(
			input.project,
			id,
			input.orgId,
			input.serviceId,
			input.policyId,
			input.instance,
			now,
			now,
		);
		emit(db, now, "policy.attestation", input.serviceId, { id, ...input });
		return { id };
	})();
}

function getAttestation(
	db: Database,
	project: string,
	id: string,
): AttestationRecord | null {
	const r = db
		.query("SELECT * FROM policy_attestations WHERE project = ? AND id = ?")
		.get(project, id) as Record<string, unknown> | null;
	if (!r) return null;
	return {
		project: r.project as string,
		id: r.id as string,
		orgId: r.org_id as string,
		serviceId: r.service_id as string,
		policyId: r.policy_id as string,
		instance: r.instance as string,
		state: r.state as AttestationState,
		evidence: (r.evidence as string | null) ?? null,
		verifiedAt: (r.verified_at as number | null) ?? null,
		expiresAt: (r.expires_at as number | null) ?? null,
		createdAt: r.created_at as number,
		updatedAt: r.updated_at as number,
	};
}

export function getAttestationById(
	db: Database,
	project: string,
	id: string,
): AttestationRecord | null {
	schema(db);
	return getAttestation(db, project, id);
}

/** Complete a pending attestation. Verified results expire (live evidence
 *  ages even with unchanged source); failures can be re-attested. */
export function completeAttestation(
	db: Database,
	input: {
		project: string;
		attestationId: string;
		result: "verified" | "failed";
		evidence: string[];
		verifyTtlMs?: number;
	},
	now = Date.now(),
): { ok: boolean; reason?: string } {
	schema(db);
	return db.transaction(() => {
		const att = getAttestation(db, input.project, input.attestationId);
		if (!att) return { ok: false, reason: "unknown attestation" };
		if (!canTransition("attestation", att.state, input.result))
			return { ok: false, reason: `state ${att.state} does not admit ${input.result}` };
		db.query(
			"UPDATE policy_attestations SET state = ?, evidence = ?, verified_at = ?, expires_at = ?, updated_at = ? WHERE project = ? AND id = ?",
		).run(
			input.result,
			JSON.stringify(input.evidence),
			input.result === "verified" ? now : null,
			input.result === "verified" ? now + (input.verifyTtlMs ?? 24 * 3_600_000) : null,
			now,
			input.project,
			input.attestationId,
		);
		emit(db, now, "policy.attested", att.serviceId, {
			id: input.attestationId,
			result: input.result,
		});
		return { ok: true };
	})();
}

/** Verified attestations age out: expired evidence is not healthy. */
export function expireAttestations(db: Database, now = Date.now()): number {
	schema(db);
	return db.transaction(() => {
		const rows = db
			.query(
				"SELECT project, id, service_id FROM policy_attestations WHERE state = 'verified' AND expires_at IS NOT NULL AND expires_at <= ?",
			)
			.all(now) as { project: string; id: string; service_id: string }[];
		for (const row of rows) {
			db.query(
				"UPDATE policy_attestations SET state = 'expired', updated_at = ? WHERE project = ? AND id = ?",
			).run(now, row.project, row.id);
			emit(db, now, "policy.attestation", row.service_id, {
				id: row.id,
				state: "expired",
			});
		}
		return rows.length;
	})();
}

/** The active scoped exception for an org/service/policy triple: an
 *  unexpired approved waiver. null = no exception — the session reminder
 *  loop keeps prompting. */
export function activeException(
	db: Database,
	key: AssessmentKey,
	now = Date.now(),
): DecisionRecord | null {
	schema(db);
	const row = db
		.query(
			"SELECT d.* FROM policy_decisions d JOIN policy_remediations r" +
				" ON r.project = d.project AND r.id = d.remediation_id" +
				" WHERE d.project = ? AND r.org_id = ? AND r.service_id = ?" +
				" AND r.policy_id = ? AND d.action = 'exception'" +
				" AND (d.expires_at IS NULL OR d.expires_at > ?)" +
				" ORDER BY d.decided_at DESC LIMIT 1",
		)
		.get(key.project, key.orgId, key.serviceId, key.policyId, now) as Record<
		string,
		unknown
	> | null;
	if (!row) return null;
	return {
		project: row.project as string,
		id: row.id as string,
		remediationId: row.remediation_id as string,
		action: row.action as DecisionAction,
		actor: row.actor as string,
		proposalHash: row.proposal_hash as string,
		expiresAt: (row.expires_at as number | null) ?? null,
		decidedAt: row.decided_at as number,
	};
}

function mintRemediationWorkItem(
	db: Database,
	rem: RemediationRecord,
	actor: string,
	priority: number,
	now: number,
): string {
	db.query(
		"INSERT INTO work_sequences (project, next_id)" +
			" SELECT ?, COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) + 1" +
			" FROM work_items WHERE project = ? AND id GLOB 'W[0-9]*'" +
			" AND id NOT LIKE '%.%'" +
			" ON CONFLICT(project) DO UPDATE SET next_id = next_id + 1",
	).run(rem.project, rem.project);
	const nextId = (
		db.query("SELECT next_id FROM work_sequences WHERE project = ?").get(
			rem.project,
		) as { next_id: number }
	).next_id;
	const workId = `W${nextId}`;
	db.query(
		"INSERT INTO work_items (id, parent_id, title, state, priority," +
			" created_by, scope, why_parallel, project, required, requires," +
			" tags, created_at, updated_at, description)" +
			" VALUES (?, NULL, ?, 'READY', ?, ?, ?, NULL, ?, 1, NULL, NULL, ?, ?, ?)",
	).run(
		workId,
		`remediation ${rem.id}: ${rem.serviceId} — independent health reporter`,
		priority,
		actor,
		`policy/${rem.orgServicePolicyKey}`,
		rem.project,
		now,
		now,
		JSON.stringify({
			remediationId: rem.id,
			proposalHash: rem.proposalHash,
			orgId: rem.orgId,
			serviceId: rem.serviceId,
			policyId: rem.policyId,
			proposal: JSON.parse(rem.proposal) as unknown,
			landing: [
				"spec",
				"tests",
				"commit",
				"deploy evidence",
				`attest: policy-workflow attest ${rem.serviceId} --instance <id> --verify --evidence <json>`,
			],
		}),
	);
	return workId;
}

/** Approval → the ONE authorized remediation work item. Concurrent
 *  approvals replay the same digest; the one-time decision + the work_id
 *  backfill make the mint exact-once inside one transaction, so the second
 *  approver reads back the SAME work id — never a duplicate lane. An approve
 *  decided earlier by plain `decide approve` completes here. */
export function authorizeRemediation(
	db: Database,
	input: {
		project: string;
		remediationId: string;
		actor: string;
		proposalHash: string;
		priority?: number;
	},
	now = Date.now(),
): { ok: boolean; reason?: string; workId?: string; created?: boolean } {
	schema(db);
	return db.transaction(() => {
		const rem = getRemediation(db, input.project, input.remediationId);
		if (!rem) return { ok: false, reason: "unknown remediation" };
		if (rem.proposalHash !== input.proposalHash)
			return {
				ok: false,
				reason: `proposal hash mismatch: decision binds to ${rem.proposalHash}`,
			};
		if (rem.workId) return { ok: true, workId: rem.workId, created: false };
		const decided = db
			.query(
				"SELECT id FROM policy_decisions WHERE project = ? AND remediation_id = ? AND action = 'approve'",
			)
			.get(input.project, input.remediationId) as {
			id: string;
		} | null;
		const decisionId = decided?.id ?? `PD-${randomUUID().slice(0, 8)}`;
		if (!decided) {
			db.query(
				"INSERT INTO policy_decisions (project, id, remediation_id, action, actor, proposal_hash, decided_at)" +
					" VALUES (?, ?, ?, 'approve', ?, ?, ?)",
			).run(
				input.project,
				decisionId,
				input.remediationId,
				input.actor,
				input.proposalHash,
				now,
			);
		}
		const workId = mintRemediationWorkItem(
			db,
			rem,
			input.actor,
			input.priority ?? 2,
			now,
		);
		db.query(
			"UPDATE policy_remediations SET work_id = ?, state = 'approved', decision_ref = ?, updated_at = ? WHERE project = ? AND id = ?",
		).run(workId, decisionId, now, input.project, input.remediationId);
		emit(db, now, "policy.authorized", rem.serviceId, {
			id: rem.id,
			workId,
			proposalHash: rem.proposalHash,
			actor: input.actor,
		});
		return { ok: true, workId, created: true };
	})();
}
