// hooks/bin/policy-workflow.ts — W462 corporate policy workflow entry. The
// three state machines (assessment / remediation / attestation) over
// governor.db, piloted on the one health policy (hooks/lib/policy-workflow/
// health-policy.ts). Decisions are recorded outside the agent: they bind to
// the exact proposal digest, are one-time per action, and exceptions carry an
// expiry — an agent cannot forge approval by emitting an event. This is a
// prototype of the toto-gpt.md shared-policy-workflow design, not corporate
// enforcement: nothing here gates release by itself.
//
// usage:
//   bun hooks/bin/policy-workflow.ts assess <service> [--org <id>] [--project <id>]
//       [--deployment <json-file>]       assess against the health policy
//   bun hooks/bin/policy-workflow.ts propose <service> --spec <json-file>
//       [--org <id>] [--project <id>]    idempotent remediation proposal
//   bun hooks/bin/policy-workflow.ts decide <remediation-id> <approve|defer|exception>
//       --actor <id> --hash <proposal-hash> [--expires <ms-epoch>]
//   bun hooks/bin/policy-workflow.ts remediation <remediation-id> <claim|review|merge|cancel>
//       --actor <id>
//   bun hooks/bin/policy-workflow.ts attest <service> --instance <id>
//       [--verify|--fail] [--evidence <json-file>] [--ttl <ms>]
//   bun hooks/bin/policy-workflow.ts list <assessments|remediations|attestations> [--project <id>]
//   bun hooks/bin/policy-workflow.ts expire            sweep expired attestations
import { readFileSync } from "node:fs";
import { openGovernorDb } from "../lib/govdb.ts";
import {
	assessHealthPolicy,
	healthAssessmentKey,
	healthInputsHash,
	HEALTH_POLICY_ID,
	HEALTH_POLICY_VERSION,
	type HealthDeploymentInput,
} from "../lib/policy-workflow/health-policy.ts";
import {
	completeAssessment,
	completeAttestation,
	createAttestation,
	decideRemediation,
	expireAttestations,
	getAssessment,
	getRemediationById,
	invalidateAssessments,
	proposeRemediation,
	startAssessment,
	transitionRemediation,
} from "../lib/policy-workflow/store.ts";

function usage(): never {
	console.error("policy-workflow: see header comment for verbs");
	process.exit(2);
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function main(): void {
	const argv = process.argv.slice(2);
	const [verb, subject, action] = argv;
	if (!verb) usage();
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const project = flag("project") ?? "fleet";
	const orgId = flag("org") ?? "klh";
	const db = openGovernorDb();
	try {
		if (verb === "assess" && subject) {
			const key = healthAssessmentKey(project, orgId, subject);
			const depPath = flag("deployment");
			const deployment: HealthDeploymentInput = depPath
				? (readJson(depPath) as unknown as HealthDeploymentInput)
				: {
						service: subject,
						manifestKnown: false,
						roles: [],
						reporterSupervision: "none",
						monitoringWiring: "none",
					};
			const inputsHash = healthInputsHash(deployment);
			const existing = getAssessment(db, key);
			if (existing && existing.inputsHash === inputsHash && existing.state !== "stale") {
				console.log(
					`reusing assessment ${existing.state}/${existing.verdict ?? "-"} (inputs unchanged, ${existing.updatedAt})`,
				);
				return;
			}
			const started = startAssessment(db, key, HEALTH_POLICY_VERSION, "cli");
			if (!started.ok) {
				console.error(`policy-workflow: ${started.reason}`);
				process.exit(1);
			}
			const result = assessHealthPolicy(deployment);
			if (result.verdict === "partial") {
				// invalidate other verdicts on the same inputs before refolding
				invalidateAssessments(db, {
					project,
					orgId,
					serviceId: subject,
					policyId: HEALTH_POLICY_ID,
					exceptInputsHash: inputsHash,
				});
			}
			const completed = completeAssessment(db, key, {
				sid: "cli",
				verdict: result.state,
				verdictDetail: result.verdict,
				evidence: result.evidence,
				inputsHash,
			});
			if (!completed.ok) {
				console.error(`policy-workflow: ${completed.reason}`);
				process.exit(1);
			}
			console.log(`${subject}: ${result.verdict} (state ${result.state})`);
			for (const e of result.evidence) console.log(`  - ${e}`);
			if (result.state === "gap")
				console.log(
					`\npropose remediation with: policy-workflow.ts propose ${subject} --spec <json>`,
				);
			return;
		}
		if (verb === "propose" && subject) {
			const spec = flag("spec");
			if (!spec) usage();
			const { id, created } = proposeRemediation(db, {
				project,
				orgId,
				serviceId: subject,
				policyId: HEALTH_POLICY_ID,
				proposal: readJson(spec),
			});
			const rem = getRemediationById(db, project, id);
			console.log(
				`${created ? "proposed" : "existing"} remediation ${id} state=${rem?.state}`,
			);
			console.log(`proposal hash: ${rem?.proposalHash}`);
			console.log(
				`decide with: policy-workflow.ts decide ${id} <approve|defer|exception> --actor <id> --hash ${rem?.proposalHash}`,
			);
			return;
		}
		if (verb === "decide" && subject && action) {
			if (!["approve", "defer", "exception"].includes(action)) usage();
			const hash = flag("hash");
			const actor = flag("actor");
			if (!hash || !actor) usage();
			const result = decideRemediation(db, {
				project,
				remediationId: subject,
				action: action as "approve" | "defer" | "exception",
				actor,
				proposalHash: hash,
				exceptionExpiresAt: flag("expires") ? Number(flag("expires")) : undefined,
			});
			if (!result.ok) {
				console.error(`policy-workflow: ${result.reason}`);
				process.exit(1);
			}
			console.log(`decision ${result.decisionId} recorded (${action} by ${actor})`);
			return;
		}
		if (verb === "remediation" && subject && action) {
			const to = { claim: "claimed", review: "in-review", merge: "merged", cancel: "cancelled" }[
				action
			];
			if (!to) usage();
			const result = transitionRemediation(db, {
				project,
				remediationId: subject,
				to,
				actor: flag("actor") ?? "cli",
			});
			if (!result.ok) {
				console.error(`policy-workflow: ${result.reason}`);
				process.exit(1);
			}
			console.log(`${subject}: ${to}`);
			return;
		}
		if (verb === "attest" && subject) {
			const instance = flag("instance");
			if (!instance) usage();
			const { id } = createAttestation(db, {
				project,
				orgId,
				serviceId: subject,
				policyId: HEALTH_POLICY_ID,
				instance,
			});
			console.log(`attestation ${id} pending for ${subject}@${instance}`);
			const verdict = flag("verify") !== undefined ? "verified" : flag("fail") !== undefined ? "failed" : undefined;
			if (verdict) {
				const evidence = flag("evidence")
					? (readJson(flag("evidence") ?? "") as unknown as string[])
					: [];
				const result = completeAttestation(db, {
					project,
					attestationId: id,
					result: verdict,
					evidence,
					verifyTtlMs: flag("ttl") ? Number(flag("ttl")) : undefined,
				});
				if (!result.ok) {
					console.error(`policy-workflow: ${result.reason}`);
					process.exit(1);
				}
				console.log(`attestation ${id}: ${verdict}`);
			}
			return;
		}
		if (verb === "list" && subject) {
			const table =
				subject === "assessments"
					? "policy_assessments"
					: subject === "remediations"
						? "policy_remediations"
						: subject === "attestations"
							? "policy_attestations"
							: null;
			if (!table) usage();
			const rows = db
				.query(`SELECT * FROM ${table} WHERE project = ? ORDER BY updated_at DESC LIMIT 50`)
				.all(project) as Record<string, unknown>[];
			if (rows.length === 0) console.log("no rows");
			for (const r of rows)
				console.log(
					`${String(r.id ?? `${r.org_id}/${r.service_id}/${r.policy_id}`)}\t${String(r.state)}\t${String(r.verdict ?? r.claimed_by ?? r.instance ?? "")}`,
				);
			return;
		}
		if (verb === "expire") {
			console.log(`expired ${String(expireAttestations(db))} attestation(s)`);
			return;
		}
		usage();
	} finally {
		db.close();
	}
}

if (import.meta.main) main();
