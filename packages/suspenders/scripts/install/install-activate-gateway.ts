import {
	carryAdapter,
	gatewayReadiness,
	publishedRevision,
	type PollDeps,
} from "../lib/post-merge-live.ts";
import {
	carryGenerationPinned,
	type CarryDeps,
} from "../lib/post-merge-carry.ts";
import type { StepContext, StepResult } from "./install-run.ts";

// install-activate-gateway.ts — W2546 default-plan gateway activation:
// the ordinary install runs the authorized generation-only carry itself
// (#101149/#101713), reusing the ONE activation owner — post-merge-carry's
// carryGenerationPinned — over the EXISTING upgrader surfaces. Staging:
// upgradeGateway without --gateway-review (via this process's own
// upgradeGateway import, dry-run inert). Digest: the exact staged proposal
// artifact named by the staging result's detail (JSON: proposal path +
// reviewSha256, #101671) — never an mtime scan of the shared dir. Apply:
// the fenced upgrader run under that digest. Anything broader than a
// generation-only candidate stays pending for the owner — the step reports
// need_user_action with the resume command, never a silent skip.
/** Injected process seams for the executed-step regressions (#101772):
 * the same shapes the production adapters build, observable and hermetic. */
export interface ActivateDeps {
	/** builds the carry adapter (staging, observation, fenced apply). */
	adapter: (repo: string, prefix: string, log: string) => CarryDeps;
	/** bounded BOTH-proofs readiness poll for the gateway label. */
	readiness: (
		repo: string,
		budgetMs?: number,
		intervalMs?: number,
		over?: Partial<PollDeps>,
	) => { ready: boolean; reason: string };
}

/** The default-plan step: stage → generation-only gate → fenced apply →
 * verify BOTH readiness proofs. deps injects the adapter/readiness seams
 * for hermetic executed-step regressions; production defaults are the
 * REAL shared surfaces — never a second implementation. */
export async function activateGateway(
	ctx: StepContext,
	deps: ActivateDeps = {
		adapter: carryAdapter,
		readiness: gatewayReadiness,
	},
): Promise<StepResult> {
	if (process.platform !== "darwin")
		return { status: "skipped", note: "gateway activation requires macOS" };
	if (ctx.dryRun)
		return { status: "skipped", note: "dry-run: no gateway activation" };
	const expected = publishedRevision(ctx.prefix);
	if (expected === null)
		return {
			status: "skipped",
			note: "no published harness receipt — fresh host, nothing to activate",
		};
	const adapter = deps.adapter(ctx.repo, ctx.prefix, logPath());
	const result = carryGenerationPinned(adapter, expected);
	if (result.state === "pending")
		return {
			status: "need_user_action",
			note: `gateway candidate pending owner review: ${result.reason}`,
		};
	if (result.state === "failed")
		return { status: "failed", note: `gateway apply failed: ${result.reason}` };
	const readiness = deps.readiness(ctx.repo);
	if (!readiness.ready)
		return { status: "failed", note: `gateway unready: ${readiness.reason}` };
	return {
		status: "ok",
		note: `gateway activated (${result.reason}); ${readiness.reason}`,
		detail: result.reviewSha256,
	};
}

/** The install log face (same destination as the post-merge log tail). */
const logPath = (): string =>
	`${process.env.HOME ?? ""}/.claude-insights/post-merge-sync.log`;
