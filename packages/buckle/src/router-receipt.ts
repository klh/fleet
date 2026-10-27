// src/router-receipt.ts — W1299 decomposition of router.ts (behavior identical):
// the hop-receipt tier — one bounded HopReceipt per actual candidate
// attempt, telemetry-only (failures never change routing).
import { createHash } from "node:crypto";
import {
	type HopReceipt,
	safeProviderErrorToken,
	traceIdOf,
} from "@klh/telemetry/src/http-trace.ts";
import { candIdOf } from "./candidates.ts";
import { providerPoolIdOf } from "./router-attempt.ts";
import type {
	RouterHost,
	TryOutcome,
	UpstreamRequest,
} from "./router-types.ts";
import type { Deployment } from "./upstreams.ts";
/** One bounded receipt per actual candidate attempt. Telemetry failures
 * cannot change routing, and candidate IDs never expose a raw URL. */
export function reportAttempt(
	host: RouterHost,
	req: UpstreamRequest,
	dep: Deployment,
	ordinal: number,
	startedAt: number,
	status: number | null,
	refusal: string | null,
	retryAfterS: number | null,
	requestId?: string,
	callId?: string,
	upstreamRefusalCode: string | null = null,
	refusalOrigin: HopReceipt["refusalOrigin"] = null,
	provider?: Pick<
		TryOutcome,
		"providerPool" | "queueWaitMs" | "providerErrorCode" | "providerErrorType"
	>,
): void {
	const retryAfterMs =
		retryAfterS === null || !Number.isFinite(retryAfterS)
			? null
			: Math.min(
					Number.MAX_SAFE_INTEGER,
					Math.max(0, Math.round(retryAfterS * 1000)),
				);
	const receipt: HopReceipt = {
		rid: req.rid ?? "",
		traceId: traceIdOf(req.trace?.traceparent ?? null) ?? "",
		ordinal,
		service: "buckle",
		hop:
			refusalOrigin === "local-admission"
				? "local-admission"
				: dep.dialect === req.dialect
					? "upstream"
					: "bridged-upstream",
		candidate: createHash("sha256")
			.update(candIdOf(dep))
			.digest("hex")
			.slice(0, 16),
		status,
		refusal,
		durationMs: Math.max(0, host.now() - startedAt),
		retryAfterMs,
		upstreamId: requestId ?? null,
		callId: callId ?? null,
		upstreamRefusalCode,
		refusalOrigin,
		providerErrorCode: safeProviderErrorToken(provider?.providerErrorCode),
		providerErrorType: safeProviderErrorToken(provider?.providerErrorType),
		...{
			providerPool: provider?.providerPool ?? providerPoolIdOf(dep),
			queueWaitMs: provider?.queueWaitMs ?? null,
		},
	};
	const publish = () => {
		try {
			host.metrics?.attempt?.({
				...receipt,
				transport: req.transport?.snapshot() ?? null,
			});
		} catch {
			// The receipt sink is observability, never a routing dependency.
		}
	};
	req.transport?.bind(publish);
	publish();
}
