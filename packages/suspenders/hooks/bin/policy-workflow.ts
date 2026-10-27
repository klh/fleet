// hooks/bin/policy-workflow.ts — W462 corporate policy workflow entry. The
// three state machines (assessment / remediation / attestation) over
// governor.db, piloted on the one health policy (hooks/lib/policy-workflow/
// health-policy.ts). Decisions are recorded outside the agent: they bind to
// the exact proposal digest, are one-time per action, and exceptions carry an
// expiry — an agent cannot forge approval by emitting an event. This is a
// prototype of the toto-gpt.md shared-policy-workflow design, not corporate
// enforcement: nothing here gates release by itself.
//
// CLI (W656.3 verb-kit): `policy-workflow --help` for the generated verb
// list; per-verb `--help` carries the usage line. Verbs: assess, propose,
// decide, authorize, remediation, attest, list, expire.
import { readFileSync } from "node:fs";
import { openGovernorDb } from "../lib/govdb/govdb.ts";
import {
	assessHealthPolicy,
	HEALTH_POLICY_ID,
	HEALTH_POLICY_VERSION,
	type HealthDeploymentInput,
	healthAssessmentKey,
	healthInputsHash,
} from "../lib/policy-workflow/health-policy.ts";
import {
	authorizeRemediation,
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
import {
	defineVerb,
	dieFor,
	type Parsed,
	runCli,
	type VerbSpec,
} from "../lib/verb-kit.ts";

const die = dieFor("policy-workflow");

const usageOf = (name: string): string =>
	VERBS.find((v) => v.name === name)?.usage ?? "";

// ---- the verb registry (W656.3) — the kit owns parse/help/die ------------
// Sim contract (sim/ikea-pilot.ts): assess/propose/authorize pass --org and
// --project on every call, so those flags ride every db-touching verb.
export const VERBS: VerbSpec[] = [
	defineVerb({
		name: "assess",
		usage:
			"usage: assess <service> [--org <id>] [--project <id>] [--deployment <json-file>]",
		flags: ["--org", "--project", "--deployment"],
		minPos: 1,
	}),
	defineVerb({
		name: "propose",
		usage:
			"usage: propose <service> --spec <json-file> [--org <id>] [--project <id>]",
		flags: ["--spec", "--org", "--project"],
		minPos: 1,
		reqFlags: ["--spec"],
	}),
	defineVerb({
		name: "decide",
		usage:
			"usage: decide <remediation-id> <approve|defer|exception> --actor <id> --hash <proposal-hash> [--expires <ms-epoch>]",
		flags: ["--actor", "--hash", "--expires", "--org", "--project"],
		minPos: 2,
		reqFlags: ["--actor", "--hash"],
	}),
	defineVerb({
		name: "authorize",
		usage:
			"usage: authorize <remediation-id> --actor <id> --hash <proposal-hash> [--org <id>] [--project <id>]",
		flags: ["--actor", "--hash", "--org", "--project"],
		minPos: 1,
		reqFlags: ["--hash"],
	}),
	defineVerb({
		name: "remediation",
		usage:
			"usage: remediation <remediation-id> <claim|review|merge|cancel> [--actor <id>] [--org <id>] [--project <id>]",
		flags: ["--actor", "--org", "--project"],
		minPos: 2,
	}),
	defineVerb({
		name: "attest",
		usage:
			"usage: attest <service> --instance <id> [--verify|--fail] [--evidence <json-file>] [--ttl <ms>]",
		flags: ["--instance", "--evidence", "--ttl", "--org", "--project"],
		switches: ["--verify", "--fail"],
		minPos: 1,
		reqFlags: ["--instance"],
	}),
	defineVerb({
		name: "list",
		usage:
			"usage: list <assessments|remediations|attestations> [--project <id>]",
		flags: ["--project"],
		minPos: 1,
	}),
	defineVerb({
		name: "expire",
		usage: "usage: expire — sweep expired attestations",
	}),
];

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Evidence-revision token over the assessed source tree. A changed tree
 *  (new commit or uncommitted edits) invalidates recorded evidence — the
 *  inputs hash carries it, unchanged trees reuse the assessment. Git
 *  unavailable = "unknown", a stable token that still participates. */
function sourceRevision(): string {
	const cwd = process.cwd();
	const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
		cwd,
		stdout: "pipe",
		stderr: "ignore",
	});
	if (sha.exitCode !== 0) return "unknown";
	const id = new TextDecoder().decode(sha.stdout).trim().slice(0, 12);
	const dirty = Bun.spawnSync(["git", "status", "--porcelain"], {
		cwd,
		stdout: "pipe",
		stderr: "ignore",
	});
	const edited =
		dirty.exitCode === 0 &&
		new TextDecoder().decode(dirty.stdout).trim().length > 0;
	return edited ? `${id}:dirty` : `${id}:clean`;
}

/** Kit-dispatched verb body — the old main() branches, argv now Parsed. */
function runVerb(p: Parsed): number | undefined {
	const verb = p.name;
	const subject = p.pos[0];
	const action = p.pos[1];
	const flag = (name: string): string | undefined =>
		p.flag(`--${name}`) ?? undefined;
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
			deployment.sourceRevision = sourceRevision();
			const inputsHash = healthInputsHash(deployment);
			const existing = getAssessment(db, key);
			if (
				existing &&
				existing.inputsHash === inputsHash &&
				existing.policyVersion === HEALTH_POLICY_VERSION &&
				existing.state !== "stale"
			) {
				console.log(
					`reusing assessment ${existing.state}/${existing.verdict ?? "-"} (inputs and policy ${existing.policyVersion} unchanged, ${existing.updatedAt})`,
				);
				return;
			}
			if (
				existing &&
				existing.inputsHash !== inputsHash &&
				existing.state !== "stale"
			)
				// changed evidence invalidates the recorded state (W539.1:
				// conformance must be re-earnable — stale → assessing)
				invalidateAssessments(db, {
					project,
					orgId,
					serviceId: subject,
					policyId: HEALTH_POLICY_ID,
					exceptInputsHash: inputsHash,
				});
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
			if (!spec) die(usageOf(verb));
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
			if (!["approve", "defer", "exception"].includes(action))
				die(usageOf(verb));
			const hash = flag("hash");
			const actor = flag("actor");
			if (!hash || !actor) usage();
			const result = decideRemediation(db, {
				project,
				remediationId: subject,
				action: action as "approve" | "defer" | "exception",
				actor,
				proposalHash: hash,
				exceptionExpiresAt: flag("expires")
					? Number(flag("expires"))
					: undefined,
			});
			if (!result.ok) {
				console.error(`policy-workflow: ${result.reason}`);
				process.exit(1);
			}
			console.log(
				`decision ${result.decisionId} recorded (${action} by ${actor})`,
			);
			return;
		}
		if (verb === "authorize" && subject) {
			const hash = flag("hash");
			const actor = flag("actor") ?? "cli";
			if (!hash) die(usageOf(verb));
			const result = authorizeRemediation(db, {
				project,
				remediationId: subject,
				actor,
				proposalHash: hash,
			});
			if (!result.ok) {
				console.error(`policy-workflow: ${result.reason}`);
				process.exit(1);
			}
			console.log(
				`${result.created ? "authorized" : "already authorized"} remediation ${subject} → work item ${result.workId}`,
			);
			return;
		}
		if (verb === "remediation" && subject && action) {
			const to = {
				claim: "claimed",
				review: "in-review",
				merge: "merged",
				cancel: "cancelled",
			}[action];
			if (!to) die(usageOf(verb));
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
			if (!instance) die(usageOf(verb));
			const { id } = createAttestation(db, {
				project,
				orgId,
				serviceId: subject,
				policyId: HEALTH_POLICY_ID,
				instance,
			});
			console.log(`attestation ${id} pending for ${subject}@${instance}`);
			const verdict =
				flag("verify") !== undefined
					? "verified"
					: flag("fail") !== undefined
						? "failed"
						: undefined;
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
			if (!table) die(usageOf(verb));
			const rows = db
				.query(
					`SELECT * FROM ${table} WHERE project = ? ORDER BY updated_at DESC LIMIT 50`,
				)
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
		die(usageOf(verb));
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	await runCli({
		prog: "policy-workflow",
		about: "policy-workflow — W462 corporate policy workflow.",
		verbs: VERBS,
		argv: ["bun", "hooks/bin/policy-workflow.ts", ...process.argv.slice(2)],
		dispatch: (_name, p) => runVerb(p),
	});
}
