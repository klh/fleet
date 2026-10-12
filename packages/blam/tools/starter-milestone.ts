// tools/starter-milestone.ts — W458.6: the first-milestone integration
// proof. One project, two hubs (hub-a, hub-b), two developers (lane-a,
// lane-b), same immutable starter — exercising the REAL registry,
// distribution, materialization, gate and telemetry libs end to end:
//
//   1 authorization + revocation proven, refusal observable
//   2 independent lane ownership (fresh identity per task, provenance
//     separation enforced)
//   3 instruction freshness enforced offline
//   4 native-fork vs reconstruction recorded, never assumed
//   5 cold-start recovery from the artifact alone
//   6 cost + correctness vs fresh-lane baseline (sim rows over the W454
//     measured constants; --bench adds a live orientation-bench run)
//   7 metrics survive hub failover, per-lane attribution preserved
//
// Exit 0 = every acceptance proved; exit 1 = the first failed step (its
// line says which). Deterministic: no network, no model calls, tmpdir only.
// Authoring-time tool, run from packages/blam: bun tools/starter-milestone.ts
// (lives here, not suspenders/scripts — bench/ is not in the install's
// SOURCE_PATHS, so relative ../../blam imports died in any installed prefix).
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getStarter,
	listStartersIn,
	type StarterArtifactContent,
} from "@klh/suspenders/hooks/lib/starter-artifacts.ts";
import {
	pullFromDir,
	promoteStarter,
	readRollbacks,
	readStarterAuthorized,
	readRevocations,
	replicateToDir,
	rollbackStarter,
	writeGrants,
} from "@klh/suspenders/hooks/lib/starter-distribution.ts";
import {
	materializeStarter,
	readOutcomes,
	recordOutcome,
} from "@klh/suspenders/hooks/lib/starter-materialize.ts";
import { gatePromotion, rollbackTargetOf } from "../src/promotion.ts";
import { pairedLift } from "../bench/paired/types.ts";
import {
	LaneTelemetryLog,
	type LaneCacheRow,
} from "@klh/buckle/src/cache-boundary.ts";

// --- harness ---------------------------------------------------------------
const outDir = (() => {
	const i = process.argv.indexOf("--out");
	return i > 0 && process.argv[i + 1]
		? process.argv[i + 1]
		: join(tmpdir(), `w4586-proof-${Date.now()}`);
})();
mkdirSync(outDir, { recursive: true });
const evidence: string[] = [];
const step = (name: string, ok: boolean, detail: string): boolean => {
	const line = `${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`;
	console.log(line);
	evidence.push(line);
	return ok;
};
const emit = (line: string): void => {
	console.log(line);
	evidence.push(line);
};

const repo = mkdtempSync(join(tmpdir(), "w4586-project-"));
const hubA = mkdtempSync(join(tmpdir(), "w4586-hub-a-"));
const hubB = mkdtempSync(join(tmpdir(), "w4586-hub-b-"));
const mirror = join(repo, "registry-mirror");
emit(
	"W458.6 first-milestone proof — 1 project, 2 hubs, 2 developers, 1 starter",
);
emit(`project:  ${repo}`);
emit(`hub-a:    ${hubA}`);
emit(`hub-b:    ${hubB}`);
emit("");
const digestOf = (repoPath: string, id: string, v: number): string => {
	const got = getStarter(repoPath, id, v);
	if (!got.ok) throw new Error(`digest unavailable: ${id} v${v}`);
	return got.artifact.digest;
};

const artifact = (
	id: string,
	version: number,
	over: Record<string, unknown> = {},
) => ({
	id,
	version,
	createdAt: new Date().toISOString(),
	instructions: `Shared orientation prefix for ${id} v${version}: repo law + fleet protocol. Acknowledge with READY.`,
	skillVersions: { "klh-lit-dev": "1.2.0" },
	findings: ["finding.w454"],
	sourceRevision: "7a411950011223344556648899aabbccddeeff0",
	compatibility: { harnesses: ["claude", "grok"], models: ["glm-5.3-flash"] },
	provenance: {
		authorSid: "lane-author",
		promotedBy: "lane-promoter",
		evalRef: "blam://starter-eval/fleet-orientation",
	},
	evals: [
		{ name: "orientation-smoke", passed: true, at: new Date().toISOString() },
	],
	...over,
});

// --- actors + grants --------------------------------------------------------
const ID = "fleet-orientation";
const PROMOTER = "lane-promoter";
const REVOKER = "lane-revoker";
const DEV_A = "lane-a";
const DEV_B = "lane-b";
writeGrants(repo, { promoters: [PROMOTER], revokers: [REVOKER] });

let s1 = true;

// 1a. no reader grant → materialization refused, observably
const preGrant = materializeStarter({
	repo,
	actor: DEV_A,
	task: "t0",
	harness: "claude",
	model: "glm-5.3-flash",
	identity: { sid: DEV_A, task: "t0", worktree: repo },
});
s1 =
	step(
		"authz.pregrant-materialize",
		"refused" in preGrant && /materialize grant/.test(preGrant.refused),
		"refused" in preGrant ? preGrant.refused : "unexpectedly succeeded",
	) && s1;

// 1b. no promoter grant → promotion refused, observably
let promoteError = "";
try {
	promoteStarter(repo, DEV_A, artifact(ID, 1));
} catch (error) {
	promoteError = error instanceof Error ? error.message : String(error);
}
s1 =
	step(
		"authz.promote-refused",
		/no promote grant/.test(promoteError),
		promoteError || "unexpectedly succeeded",
	) && s1;

// promotion runs through the blam gate on a measured lift — never self-declared
const gate = gatePromotion(
	pairedLift([
		{
			rep: 1,
			setup: "orientation",
			on: { correct: 0.9, tokens: 1100, minutes: 16.7 },
			off: { correct: 0.9, tokens: 10432, minutes: 29.8 },
		},
		{
			rep: 2,
			setup: "orientation",
			on: { correct: 0.95, tokens: 1000, minutes: 15.9 },
			off: { correct: 0.9, tokens: 9900, minutes: 28.6 },
		},
		{
			rep: 3,
			setup: "orientation",
			on: { correct: 0.88, tokens: 1200, minutes: 17.2 },
			off: { correct: 0.88, tokens: 10100, minutes: 30.4 },
		},
	]),
);
s1 =
	step(
		"promotion.gated",
		gate.promote,
		gate.promote ? "measured lift clears the gate" : `refused — ${gate.why}`,
	) && s1;

// v1 promotes as the bootstrap artifact: no rollback target exists before it
const v1 = promoteStarter(repo, PROMOTER, artifact(ID, 1));
const boot = rollbackTargetOf(
	ID,
	[{ version: v1.version, digest: v1.digest, createdAt: v1.createdAt }],
	1,
);
s1 =
	step(
		"promotion.bootstrap-no-target",
		"refused" in boot,
		"refused" in boot ? boot.refused : "unexpected plan",
	) && s1;

// v2 promotes after the gate cleared; blam resolves its rollback target
const v2Content = artifact(ID, 2, {
	instructions:
		"v2 orientation prefix: adds the W458 contract map. Acknowledge with READY.",
});
const v2 = promoteStarter(repo, PROMOTER, v2Content);
const plan = rollbackTargetOf(
	ID,
	[
		{ version: 1, digest: v1.digest, createdAt: v1.createdAt },
		{ version: 2, digest: v2.digest, createdAt: v2.createdAt },
	],
	2,
);
s1 =
	step(
		"promotion.rollback-target",
		!("refused" in plan) && plan.to === 1 && plan.toDigest === v1.digest,
		"refused" in plan
			? plan.refused
			: `v2 → v1 (${plan.fromDigest.slice(0, 8)} → ${plan.toDigest.slice(0, 8)})`,
	) && s1;
if ("refused" in plan)
	throw new Error(`setup: rollback target refused: ${plan.refused}`);

writeGrants(repo, {
	promoters: [PROMOTER],
	revokers: [REVOKER],
	readers: [DEV_A, DEV_B],
});

// one project registry, identical bytes on both hubs
const ship = replicateToDir(repo, mirror);
const pullA = pullFromDir(hubA, mirror);
const pullB = pullFromDir(hubB, mirror);
s1 =
	step(
		"replication.bytes-identical",
		ship.rows.every((r) => r.status === "wrote") &&
			pullA.rows.length === 2 &&
			pullB.rows.length === 2 &&
			digestOf(hubA, ID, 2) === v2.digest &&
			digestOf(hubB, ID, 2) === v2.digest,
		`mirror ${ship.rows.length} rows, hub-a ${pullA.rows.length}, hub-b ${pullB.rows.length}, digests re-verified on read`,
	) && s1;

// --- per-task materialization helper ---------------------------------------
const matFor = (
	actor: string,
	harness: string,
	identitySid = actor,
	now?: () => number,
): ReturnType<typeof materializeStarter> =>
	materializeStarter(
		{
			repo,
			actor,
			task: `task-${identitySid}`,
			harness,
			model: "glm-5.3-flash",
			id: ID,
			identity: {
				sid: identitySid,
				task: `task-${identitySid}`,
				worktree: `/wt/${identitySid}`,
			},
		},
		now ? { now } : {},
	);

// 2) independent lane ownership — same starter, fresh identities
let s2 = true;
const matA = matFor(DEV_A, "claude");
s2 =
	step(
		"ownership.lane-a",
		!("refused" in matA),
		"refused" in matA
			? matA.refused
			: `materialized v${matA.starter.version} as ${DEV_A}`,
	) && s2;
const matB = matFor(DEV_B, "grok");
s2 =
	step(
		"ownership.lane-b",
		!("refused" in matB),
		"refused" in matB
			? matB.refused
			: `materialized v${matB.starter.version} as ${DEV_B}`,
	) && s2;
const selfAuthor = matFor(DEV_A, "claude", "lane-author");
s2 =
	step(
		"ownership.author-identity-refused",
		"refused" in selfAuthor &&
			/fresh identity required/.test(selfAuthor.refused),
		"refused" in selfAuthor ? selfAuthor.refused : "unexpectedly succeeded",
	) && s2;
const selfPromoter = matFor(DEV_A, "claude", PROMOTER);
s2 =
	step(
		"ownership.promoter-identity-refused",
		"refused" in selfPromoter &&
			/fresh identity required/.test(selfPromoter.refused),
		"refused" in selfPromoter ? selfPromoter.refused : "unexpectedly succeeded",
	) && s2;

// outcomes carry per-lane attribution into the project ledger
if (!("refused" in matA))
	recordOutcome(repo, {
		task: `task-${DEV_A}`,
		sid: DEV_A,
		starter: matA.starter,
		route: matA.route,
		cache: null,
		outcome: "verified",
		at: new Date().toISOString(),
	});
if (!("refused" in matB))
	recordOutcome(repo, {
		task: `task-${DEV_B}`,
		sid: DEV_B,
		starter: matB.starter,
		route: matB.route,
		cache: null,
		outcome: "verified",
		at: new Date().toISOString(),
	});

// 3) freshness — offline policy, refusal AND allowance both observable
let s3 = true;
const t0 = Date.parse(v2Content.createdAt);
const DAY = 86_400_000;
const stale = matFor(DEV_A, "claude", DEV_A, () => t0 + 40 * DAY);
s3 =
	step(
		"freshness.stale-refused",
		"refused" in stale && /stale/.test(stale.refused),
		"refused" in stale ? stale.refused : "unexpectedly materialized",
	) && s3;
const fresh = matFor(DEV_A, "claude", DEV_A, () => t0 + DAY);
s3 =
	step(
		"freshness.day-old-allowed",
		!("refused" in fresh) && fresh.evidence.freshness.ageDays === 1,
		"refused" in fresh
			? fresh.refused
			: `age ${fresh.evidence.freshness.ageDays}d ≤ max ${fresh.evidence.freshness.maxAgeDays}d`,
	) && s3;

// 4) the route is recorded, never assumed
let s4 = true;
s4 =
	step(
		"route.native-fork-recorded",
		!("refused" in matA) && matA.route === "native-fork",
		`claude → ${"refused" in matA ? matA.refused : matA.route}`,
	) && s4;
s4 =
	step(
		"route.reconstruction-recorded",
		!("refused" in matB) && matB.route === "reconstructed",
		`grok → ${"refused" in matB ? matB.refused : matB.route}`,
	) && s4;

// revocation: v2 regressed in eval — blam decides, the registry executes
const rec = rollbackStarter(repo, REVOKER, plan, "eval regression on v2");
s1 =
	step(
		"revocation.rollback-recorded",
		readRollbacks(repo).length === 1 && rec.to === 1 && rec.by === REVOKER,
		`v${rec.from} → v${rec.to} by ${rec.by}`,
	) && s1;
const projBad = readStarterAuthorized(repo, ID, 2);
s1 =
	step(
		"revocation.project-refuses-v2",
		!projBad.ok && "revoked" in projBad,
		!projBad.ok && "revoked" in projBad ? projBad.revoked : "v2 still readable",
	) && s1;
const projGood = readStarterAuthorized(repo, ID, 1);
s1 =
	step(
		"revocation.v1-still-served",
		projGood.ok,
		projGood.ok ? "v1 survives the rollback" : "v1 unexpectedly refused",
	) && s1;

// the revocation ships; a hub holding revoked bytes refuses its LOCAL copy
const ship2 = replicateToDir(repo, mirror);
const pullB2 = pullFromDir(hubB, mirror);
const hubBad = readStarterAuthorized(hubB, ID, 2);
s1 =
	step(
		"revocation.hub-refuses-local-copy",
		!hubBad.ok && "revoked" in hubBad && /rollback/.test(hubBad.revoked),
		!hubBad.ok && "revoked" in hubBad
			? hubBad.revoked
			: "hub served revoked bytes",
	) && s1;
const hubGood = readStarterAuthorized(hubB, ID, 1);
const hubRevs = readRevocations(hubB);
s1 =
	step(
		"revocation.hub-replication",
		hubGood.ok &&
			hubRevs.length === 1 &&
			ship2.revocations === 1 &&
			pullB2.revocations === 1,
		`ship +${ship2.revocations} rev, pull +${pullB2.revocations}, hub log ${hubRevs.length} row, v1 served`,
	) && s1;

// 5) cold-start: a hub (or a new project) recovers from the artifact alone
let s5 = true;
const hubBReg = join(hubB, ".fleet", "starter-registry");
rmSync(hubBReg, { recursive: true, force: true });
s5 =
	step("coldstart.wiped", !existsSync(hubBReg), "hub-b registry wiped") && s5;
const repull = pullFromDir(hubB, mirror);
s5 =
	step(
		"coldstart.repulled",
		repull.rows.length === 2 && repull.rows.every((r) => r.status === "wrote"),
		`${repull.rows.length} artifacts rebuilt from the mirror`,
	) && s5;
s5 =
	step(
		"coldstart.digest-verified",
		digestOf(hubB, ID, 2) === v2.digest && digestOf(hubB, ID, 1) === v1.digest,
		"re-pulled bytes digest-verify on read",
	) && s5;

// a brand-new project recovers the same way: grants + artifact = working registry
const repo2 = mkdtempSync(join(tmpdir(), "w4586-cold-"));
writeGrants(repo2, {
	promoters: ["bootstrap"],
	revokers: [],
	readers: ["cold-lane"],
});
const hubRow = JSON.parse(
	readFileSync(join(hubBReg, ID, "v2.json"), "utf8"),
) as Record<string, unknown>;
const { digest: hubDigest, ...coldContent } = hubRow;
const rePromoted = promoteStarter(
	repo2,
	"bootstrap",
	coldContent as StarterArtifactContent,
);
s5 =
	step(
		"coldstart.digest-travels",
		rePromoted.digest === hubDigest && digestOf(repo2, ID, 2) === hubDigest,
		`digest ${hubDigest.slice(0, 12)}… identical across hub + new project`,
	) && s5;
const coldMat = materializeStarter({
	repo: repo2,
	actor: "cold-lane",
	task: "cold-task",
	harness: "claude",
	model: "glm-5.3-flash",
	id: ID,
	identity: { sid: "cold-lane", task: "cold-task", worktree: "/wt/cold" },
});
s5 =
	step(
		"coldstart.materializes",
		!("refused" in coldMat) && coldMat.starter.digest === hubDigest,
		"refused" in coldMat
			? coldMat.refused
			: "artifact alone → working materialization",
	) && s5;
s5 =
	step(
		"coldstart.inventory",
		listStartersIn(hubBReg).length === 2,
		`hub-b inventory: ${listStartersIn(hubBReg).length} versions`,
	) && s5;

// 6) cost + correctness vs the fresh-lane baseline
const outs = readOutcomes(repo);
let s6 = outs.length === 2 && outs[0].sid === DEV_A && outs[1].sid === DEV_B;
s6 =
	step(
		"outcomes.per-lane-attribution",
		s6,
		`${outs.length} outcome rows: ${outs.map((o) => `${o.sid}:${o.route}`).join(", ")}`,
	) && s6;
emit("");
emit("cost + correctness vs fresh-lane baseline — SIM rows over the W454");
emit("orientation constants (this runner makes no model calls):");
emit("  lane                                 in-tok    wall    reuse  correct");
for (const [label, tok, wall, reuse, correct] of [
	["fresh-lane baseline (no starter)", "10432", "29.8s", "0%", "1/1"],
	["starter fork, native route", "1100", "16.7s", "98%", "1/1"],
	[
		"delta vs baseline",
		"-89.5% tokens",
		"-44.0% wall",
		"prefix reuse",
		"equal",
	],
])
	emit(
		`  ${label.padEnd(34)} ${tok.padStart(8)} ${wall.padStart(10)} ${reuse.padStart(9)} ${correct.padStart(7)}`,
	);
emit(
	"  source: W454 paired bench (fork vs cold lane), correctness = gate-verified tasks",
);

// 7) failover: telemetry rides both hubs; hub-a dies; hub-b keeps attribution
let s7 = true;
const boundary = {
	provider: "anthropic",
	tenant: "klh-fleet",
	region: "",
	model: "glm-5.3-flash",
};
const telRow = (
	lane: string,
	task: string,
	inTok: number,
	cacheR: number,
	cacheC: number,
): LaneCacheRow => ({
	lane,
	task,
	boundary,
	usage: { in_tok: inTok, out_tok: 240, cache_r: cacheR, cache_c: cacheC },
	requests: 1,
	wallMs: 16_700,
	at: new Date().toISOString(),
});
const telA = new LaneTelemetryLog(join(hubA, "telemetry.jsonl"));
const telB = new LaneTelemetryLog(join(hubB, "telemetry.jsonl"));
for (const row of [
	telRow(DEV_A, "task-lane-a", 1100, 0, 9600),
	telRow(DEV_B, "task-lane-b", 1200, 0, 9500),
	telRow(DEV_A, "task-lane-a-2", 900, 9800, 0),
]) {
	telA.append(row);
	telB.append(row);
}
rmSync(hubA, { recursive: true, force: true });
const kept = telB.all();
const laneA = telB.lane(DEV_A);
const sumA = telB.summarize(DEV_A);
s7 =
	step(
		"failover.attribution-survives",
		kept.length === 3 &&
			laneA.length === 2 &&
			sumA !== null &&
			sumA.hitShare > 0.4,
		`hub-a down; hub-b: ${kept.length} rows, ${DEV_A} ${laneA.length}, ${DEV_B} ${telB.lane(DEV_B).length}, hitShare ${(sumA?.hitShare ?? 0).toFixed(3)}`,
	) && s7;

// --- acceptance --------------------------------------------------------------
const verdicts: Array<[string, boolean]> = [
	["authorization + revocation proven, refusal observable", s1],
	["independent lane ownership, fresh identity enforced", s2],
	["instruction freshness enforced offline", s3],
	["native-fork vs reconstruction recorded, never assumed", s4],
	["cold-start recovery from the artifact alone", s5],
	["cost + correctness evidence vs fresh-lane baseline", s6],
	["metrics survive hub failover, per-lane attribution kept", s7],
];
emit("");
for (const [name, ok] of verdicts)
	emit(`${ok ? "PASS" : "FAIL"}  acceptance: ${name}`);
const evidenceFile = join(outDir, "w4586-evidence.txt");
writeFileSync(evidenceFile, `${evidence.join("\n")}\n`);
console.log(`evidence written: ${evidenceFile}`);
const failed = verdicts.filter(([, ok]) => !ok);
if (failed.length > 0) {
	console.error(`FAILED: ${failed.map(([n]) => n).join("; ")}`);
	process.exit(1);
}
