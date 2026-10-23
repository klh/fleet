// dispatch-preview.ts — the read-only preview half of the dispatch loop
// (W928 decomposition): the --dry-run branch of dispatchItem and the brief
// composer shared with the live spawn path. The REPO/CLI-bound closures the
// entrypoint owns (sh/run/workCli/coordCli, brief extras, capsule getters)
// arrive as a deps bag; bodies moved from dispatch-next.ts.
import { existsSync } from "node:fs";
import { briefIntel } from "../../hooks/lib/brief-intel.ts";
import { adapterFor } from "../../hooks/lib/executors/registry.ts";
import { projectIdentity } from "../../hooks/lib/govdb.ts";
import { laneEffortBriefLine } from "../../hooks/lib/lane-effort-policy.ts";
import { plaidPickOf, plaidRoutes } from "../../hooks/lib/plaid.ts";
import { effortFromShow } from "../../hooks/lib/work-effort.ts";
import { composeBrief } from "./brief.ts";
import { briefVerdictLine, verifyBrief } from "./brief-verify.ts";
import { recordPhase } from "./dispatch-phase-timing.ts";
import { cvSnapshot, quotaSnapshot } from "./dispatch-admission.ts";
import { execPick } from "./exec-chain.ts";
import { fleetReport } from "./fleet-report.ts";
import { landingRedirect } from "./landing-redirect.ts";
import { decisionFor, resumeBriefLine } from "./resume-from.ts";

/** The dispatch-next entrypoint's bound closures, threaded instead of closed
 * over: run/sh/workCli/coordCli are BIN/REPO-bound, the getters compose
 * them, the brief extras read repo policy. */
export type DispatchPreviewDeps = {
	REPO: string;
	CALLER_REPO: string;
	RESUME_FROM?: string;
	sh: (cmd: string[], cwd?: string) => string;
	run: (cmd: string[], cwd?: string) => { code: number; out: string };
	workCli: (...args: string[]) => string;
	capsuleGet: (sid: string) => Record<string, string> | null;
	itemCapsuleGet: (item: string) => Record<string, string> | null;
	routingExtra: () => string[];
	policyBriefExtra: (project: string) => string[];
};

/** composeBrief's dispatch-shaped inputs (W928): everything the shared
 * composer needs beyond the deps bag. */
export type DispatchBriefArgs = {
	item: string;
	show: { out: string };
	sid: string;
	branch: string;
	wt: string;
	capsule: Record<string, string> | null;
	pick: { agent?: string };
	resumeBrief: string[];
	landing?: string;
};

/** W928 DRY: one source of truth for the composeBrief field list — the dry
 * preview and the live spawn path previously composed it twice. Returns
 * intel too: the live path logs BRIEF-INTEL skips. */
export const composeDispatchBrief = (
	d: DispatchPreviewDeps,
	a: DispatchBriefArgs,
): { brief: string; intel: ReturnType<typeof briefIntel> } => {
	const t = performance.now();
	try {
		const intel = briefIntel(d.REPO, `${a.item} ${a.show.out}`);
		const brief = composeBrief({
			item: a.item,
			showOut: a.show.out,
			sid: a.sid,
			branch: a.branch,
			worktree: a.wt,
			capsule: a.capsule,
			itemCapsule: d.itemCapsuleGet(a.item),
			agent: a.pick.agent,
			effort: effortFromShow(a.show.out),
			effortPolicy: laneEffortBriefLine(d.REPO, a.item),
			...(a.landing !== undefined ? { landing: a.landing } : {}),
			intel,
			fleetReport: fleetReport(d.REPO),
			extra: [
				...d.routingExtra(),
				...a.resumeBrief,
				...d.policyBriefExtra(projectIdentity(d.REPO)),
			],
		});
		return { brief, intel };
	} finally {
		recordPhase("brief.compose", performance.now() - t);
	}
};

/** The --dry-run branch of dispatchItem, moved from dispatch-next.ts:
 * read-only end to end — no claim, no spawn. */
export const dryDispatchPreview = async (
	d: DispatchPreviewDeps,
	a: {
		item: string;
		sid: string;
		attempt: number;
		wt: string;
		resumeSid?: string;
		routePin?: string;
	},
): Promise<string> => {
	const { REPO, CALLER_REPO, RESUME_FROM, sh, run, workCli, capsuleGet } = d;
	const { item, sid, attempt, wt, resumeSid } = a;
	// read-only end to end: no claim, no worktree, no brief file, no spawn
	const show = run(workCli("show", item));
	const capsule = capsuleGet(sid);
	const expected = `suspenders/${item}`;
	const cur = existsSync(wt)
		? sh(["git", "-C", wt, "branch", "--show-current"])
		: expected;
	const branch = cur || expected;
	if (existsSync(wt) && cur !== expected)
		console.log(
			`NOTE — DRY: leftover worktree ${wt} sits on ${cur || "(detached)"} (expected ${expected}) — live dispatch recreates it before spawn (W349)`,
		);
	const chainPick = execPick(
		attempt,
		CALLER_REPO,
		cvSnapshot(),
		quotaSnapshot(),
	);
	const route = a.routePin
		? plaidRoutes().find((r) => r.name === a.routePin)
		: null;
	if (a.routePin && !route)
		throw new Error(`plaid route ${a.routePin} is not configured`);
	const pick = route
		? { ...chainPick, ...plaidPickOf(null, route, [route]) }
		: chainPick;
	// W422: the brief-verify harness + enforcement ride the executor
	// adapter — the if copilot/else-claude ternary is registry data now.
	const adapter = adapterFor(pick.bin);
	console.log(`DRY dispatch ${item} → ${sid}${capsule ? " (RESUME)" : ""}`);
	if (route)
		console.log(
			`DRY selected route ${route.name} (${route.label}); live health/capacity checked at launch`,
		);
	if (!route && pick.chainLen > 1)
		console.log(
			`DRY chain attempt ${pick.chainIdx}/${pick.chainLen - 1} -> ${pick.agent}${pick.fallbackModels.length ? ` (+fallback-model ${pick.fallbackModels.join(",")})` : ""}`,
		);
	const landing = await landingRedirect(REPO, branch);
	const { brief } = composeDispatchBrief(d, {
		item,
		show,
		sid,
		branch,
		wt,
		capsule,
		pick,
		resumeBrief: resumeBriefLine(
			decisionFor(RESUME_FROM, resumeSid, pick.bin ?? "claude"),
		),
		landing,
	});
	console.log(brief);
	// W223.2: dry-run shows the verdict the spawn path would enforce
	console.log(
		briefVerdictLine(
			verifyBrief(brief, { harness: adapter.briefHarness }),
			Buffer.byteLength(brief),
		),
	);
	return `${item}→${sid}(dry)`;
};
