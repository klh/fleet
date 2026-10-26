// A bounded, disposable routing drill. It uses the production Router over
// the operator's configured group ladder, but replaces every network call
// with deterministic failures/success. No provider or live lane is touched.
import type { HopReceipt } from "@klh/telemetry/src/http-trace.ts";
import type { GatewayPolicy } from "./policy.ts";
import { Router } from "./router.ts";
import type { Dialect, UpstreamPool } from "./upstreams.ts";

export interface FailoverDrillPlan {
	policy: GatewayPolicy;
	pool: UpstreamPool;
	group: string;
	fallback: string;
	failureStatus: 429 | 503;
	maxAttempts: number;
	maxWallMs: number;
	/** Exercise the actual lane wire by choosing Anthropic, while retaining
	 *  the OpenAI compatibility drill for existing clients. */
	dialect?: Dialect;
	retryAfterS?: number;
}

export interface FailoverDrillReport {
	ok: boolean;
	deliveredGroup: string | null;
	attempts: Array<{
		group: string;
		status: number | null;
		layer: "buckle";
		retryAfterMs: number | null;
		refusal: string | null;
	}>;
	simulatedWaitMs: number;
}

export async function runForcedFailoverDrill(
	plan: FailoverDrillPlan,
): Promise<FailoverDrillReport> {
	if (
		!plan.pool.groups().includes(plan.group) ||
		!plan.pool.groups().includes(plan.fallback)
	)
		throw new Error("drill groups are absent from the configured pool");
	if (!(plan.policy.fallbacks?.[plan.group] ?? []).includes(plan.fallback))
		throw new Error("drill fallback is absent from the configured ladder");
	if (!Number.isSafeInteger(plan.maxAttempts) || plan.maxAttempts < 2)
		throw new Error("drill maxAttempts must be at least 2");
	if (!Number.isSafeInteger(plan.maxWallMs) || plan.maxWallMs < 1)
		throw new Error("drill maxWallMs must be positive");
	const retries = plan.policy.num_retries ?? 1;
	const firstRungs =
		(plan.policy.fallbacks?.[plan.group] ?? []).indexOf(plan.fallback) + 2;
	if ((retries + 1) * firstRungs > plan.maxAttempts)
		throw new Error(
			"drill attempt budget cannot cover the configured fallback walk",
		);
	const receipts: HopReceipt[] = [];
	const attemptedGroups: string[] = [];
	let simulatedWaitMs = 0;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), plan.maxWallMs);
	try {
		const router = new Router(plan.policy, {
			pool: plan.pool,
			now: () => Date.now() + simulatedWaitMs,
			rng: () => 0,
			metrics: {
				fallback: () => {},
				cooldown: () => {},
				refused: () => {},
				attempt: (receipt) => receipts.push(receipt),
			},
			probe: async () => null,
			sleepMs: async (ms) => {
				simulatedWaitMs += ms;
				if (simulatedWaitMs > plan.maxWallMs)
					throw new Error("drill retry wait exceeds wall budget");
			},
			fetchImpl: async (dep) => {
				attemptedGroups.push(dep.group);
				if (attemptedGroups.length > plan.maxAttempts)
					throw new Error("drill attempt budget exceeded");
				return dep.group === plan.fallback
					? Response.json(
							plan.dialect === "anthropic"
								? {
										type: "message",
										role: "assistant",
										content: [{ type: "text", text: "ok" }],
									}
								: {
										choices: [
											{ message: { role: "assistant", content: "ok" } },
										],
									},
						)
					: Response.json(
							{ error: { message: "synthetic failover drill" } },
							{
								status: plan.failureStatus,
								headers: { "retry-after": String(plan.retryAfterS ?? 60) },
							},
						);
			},
		});
		const result = await router.execute({
			group: plan.group,
			dialect: plan.dialect ?? "openai",
			path:
				plan.dialect === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
			body:
				plan.dialect === "anthropic"
					? {
							model: plan.group,
							max_tokens: 16,
							messages: [{ role: "user", content: "drill" }],
						}
					: {
							model: plan.group,
							messages: [{ role: "user", content: "drill" }],
						},
			key: "",
			signal: controller.signal,
		});
		const attempts = receipts.map((receipt, index) => ({
			group: attemptedGroups[index] ?? "unknown",
			status: receipt.status,
			layer: "buckle" as const,
			retryAfterMs: receipt.retryAfterMs,
			refusal: receipt.refusal,
		}));
		return {
			ok:
				result.kind === "upstream" &&
				result.tier === plan.fallback &&
				!controller.signal.aborted,
			deliveredGroup: result.kind === "upstream" ? result.tier : null,
			attempts,
			simulatedWaitMs,
		};
	} finally {
		clearTimeout(timeout);
	}
}
