// W1303.5: risk tiers over the CHANGE — the mechanical face of the
// how-to-review.md tier table. The change sets the tier, not the author;
// blast radius sets the bar. docs/tests (and operator/lane-declared
// flagged-additive) = low 0 approvals; ordinary product = medium 1;
// gates/auth/secrets/infra/workflows/release tooling/check tools = high 2.
// The merge ladder defers medium/high with a deduped NEED_DECISION event
// instead of a silent guarded merge — agent approval never fills a human slot.

import { emitStoredEvent } from "../../coord/event-publish.ts";
import {
	consumeRiskApprovals,
	countRiskApprovals,
	riskApprovalSrc,
} from "../approvals.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";

export type RiskTier = "low" | "medium" | "high";

export interface RiskClassification {
	tier: RiskTier;
	/** Human approvals the tier demands. Agent approval never fills a slot. */
	approvals: 0 | 1 | 2;
	/** Change-shape evidence for the tier, path-shaped and capped. */
	reasons: string[];
}

const basename = (path: string): string => path.split("/").at(-1) ?? path;
const segments = (path: string): string[] => path.split("/");
const contains = (path: string, word: string): boolean =>
	new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i").test(path);

/** High tells mirror the how-to-review.md high-risk list — the referee and
 * its perimeter. First matching tell names the reason; paths are evidence. */
const HIGH_TELLS: { name: string; test: (path: string) => boolean }[] = [
	{
		name: "repo governance/CI workflow",
		test: (p) => p.startsWith(".github/"),
	},
	{ name: "commit/push hooks", test: (p) => p.startsWith(".githooks/") },
	{ name: "installer", test: (p) => basename(p) === "install.sh" },
	{
		name: "hub infra (hubctl/compose/probe)",
		test: (p) => segments(p).includes("deploy") || p.includes("healthcheck"),
	},
	{
		name: "check tools (the gates)",
		test: (p) => segments(p).includes("gates"),
	},
	{
		name: "scrub gate + denylist surface",
		test: (p) => contains(p, "scrub"),
	},
	{
		name: "law-guard tests",
		test: (p) => contains(p, "law-guards"),
	},
	{
		name: "health probes",
		test: (p) => contains(p, "health") || basename(p).endsWith("-health.ts"),
	},
	{
		name: "launchd plists",
		test: (p) => p.endsWith(".plist") || segments(p).includes("launchd"),
	},
	{
		name: "release tooling",
		test: (p) => contains(p, "release"),
	},
	{
		name: "buckle auth chain (keys/scopes/minting)",
		test: (p) =>
			p.startsWith("packages/buckle/") &&
			segments(p).some(
				(s) =>
					contains(s, "auth") ||
					contains(s, "admin") ||
					contains(s, "key") ||
					contains(s, "scope") ||
					contains(s, "token") ||
					contains(s, "secret"),
			),
	},
];

/** Low shape: documentation, or a test-shaped path. Everything else that is
 * not high is an ordinary product change (medium). A purely-additive product
 * diff is NOT auto-low — a brand-new file is also "purely additive"; the
 * flagged-additive clause is caller-declared, never diff-inferred. */
const isDocsOrTests = (path: string): boolean =>
	path.endsWith(".md") ||
	segments(path).some((s) =>
		["test", "tests", "e2e", "__tests__"].includes(s),
	) ||
	/\.(test|e2e|spec)\.[cm]?[jt]sx?$/.test(basename(path));

/** Classify the change by path shape. High wins over everything; low only
 * when every path is docs/tests-shaped (or the caller declares the change
 * flagged-additive behind a real flag); medium otherwise. */
export function classifyRiskTier(
	paths: string[],
	opts?: { flaggedAdditive?: boolean },
): RiskClassification {
	const highReasons: string[] = [];
	for (const path of paths) {
		for (const tell of HIGH_TELLS) {
			if (!tell.test(path)) continue;
			highReasons.push(`${tell.name}: ${path}`);
			break;
		}
	}
	if (highReasons.length > 0)
		return {
			tier: "high",
			approvals: 2,
			reasons: highReasons.slice(0, 5),
		};
	if (paths.length === 0 || opts?.flaggedAdditive === true)
		return { tier: "low", approvals: 0, reasons: ["flagged-additive"] };
	if (paths.every(isDocsOrTests))
		return {
			tier: "low",
			approvals: 0,
			reasons: ["docs/tests-only change"],
		};
	return {
		tier: "medium",
		approvals: 1,
		reasons: [
			`ordinary product change: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` +${paths.length - 3} more` : ""}`,
		],
	};
}

/** The candidate's changed paths — merge-base(base, branch) to branch, the
 * same three-dot shape reviewContext reads instructions over. */
export function candidatePaths(
	repo: string,
	base: string,
	branch: string,
): string[] {
	const run = (args: string[]): string => {
		const p = Bun.spawnSync(["git", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0) throw new Error(`risk tier: git ${args[0]} failed`);
		return p.stdout.toString();
	};
	const commit = run(["rev-parse", "--verify", `${branch}^{commit}`]).trim();
	return run([
		"diff",
		"--name-only",
		"-z",
		"--no-renames",
		`${base}...${commit}`,
	])
		.split("\0")
		.filter(Boolean);
}

/** One NEED_DECISION per (project, commit, tier) — the ladder re-defers every
 * cycle while the tier demands approvals, and the bus must not fill with
 * duplicates of one decision. Returns true when the event was emitted. */
export function emitRiskDecision(
	db: GovernorStore,
	project: string,
	item: string,
	repo: string,
	branch: string,
	risk: RiskClassification,
): boolean {
	const commit = commitOf(repo, branch);
	const existing = db
		.query(
			"SELECT id FROM events WHERE kind = 'NEED_DECISION' AND json_extract(payload, '$.project') = ? AND json_extract(json_extract(payload, '$.risk'), '$.commit') = ? AND json_extract(json_extract(payload, '$.risk'), '$.tier') = ? LIMIT 1",
		)
		.get(project, commit, risk.tier) as { id: number } | null;
	if (existing) return false;
	emitStoredEvent(db, project, {
		kind: "NEED_DECISION",
		source: "fleet-loop",
		scope: branch,
		note: `risk tier ${risk.tier}: merging ${branch} needs ${risk.approvals} human approval(s) — agent approval never fills a human slot. Evidence: ${risk.reasons.join("; ")}`,
		extra: {
			work: item,
			tier: risk.tier,
			risk: JSON.stringify({
				commit,
				tier: risk.tier,
				approvals: risk.approvals,
				reasons: risk.reasons,
			}),
		},
	});
	return true;
}

/** The NEED_DECISION binds the exact candidate commit — a new commit is a new
 * decision. */
const commitOf = (repo: string, branch: string): string => {
	const p = Bun.spawnSync(
		["git", "rev-parse", "--verify", `${branch}^{commit}`],
		{
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (p.exitCode !== 0) throw new Error(`risk tier: cannot resolve ${branch}`);
	return p.stdout.toString().trim();
};

// ---- W1308: the approval-consumption path ------------------------------------
// The W1303.5 deferral had no exit: approvals>0 deferred every cycle,
// forever. The exit rides the W250 signed-approval channel (lib/approvals.ts,
// risk flavor): a human mints `approve-merge`; the ladder counts before
// merging and burns ONLY after a successful guarded merge — a deferred or
// failed candidate keeps its approvals for the retry.

/** The candidate's approval binding (project|branch|commit|tier) with its
 * live count (unconsumed) and its post-merge burn. */
export function riskApprovalsOf(
	repo: string,
	branch: string,
	risk: RiskClassification,
	project: string,
): { src: string; count: () => number; consume: () => number } {
	const src = riskApprovalSrc(
		project,
		branch,
		commitOf(repo, branch),
		risk.tier,
	);
	return {
		src,
		count: () => countRiskApprovals(src),
		consume: () => consumeRiskApprovals(src, risk.approvals),
	};
}
