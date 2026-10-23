/** Local transport observations only. Closing a socket is not a provider acknowledgement. */
export interface TransportEvidence {
	requestBodyBytes: number;
	headersMs: number | null;
	firstBodyByteMs: number | null;
	timeoutBudgetMs: number | null;
	bodyBytes: number;
	bodyChunks: number;
	timeoutPhase:
		| "headers"
		| "stream_idle"
		| "stream_total"
		| "exchange_total"
		| null;
	cancellation: "requested" | "local_settled" | "local_failed" | null;
	providerCancellationAcknowledged: null;
}

export function safeTimeoutPhase(
	value: unknown,
): TransportEvidence["timeoutPhase"] {
	return value === "headers" ||
		value === "stream_idle" ||
		value === "stream_total" ||
		value === "exchange_total"
		? value
		: null;
}

export function safeTransportEvidence(
	value: unknown,
): TransportEvidence | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	const count = (n: unknown) =>
		typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
	if (!count(v.requestBodyBytes) || !count(v.bodyBytes) || !count(v.bodyChunks))
		return null;
	if (
		![v.headersMs, v.firstBodyByteMs, v.timeoutBudgetMs].every(
			(n) => n === null || count(n),
		)
	)
		return null;
	if (v.timeoutPhase !== null && safeTimeoutPhase(v.timeoutPhase) === null)
		return null;
	if (
		v.cancellation !== null &&
		v.cancellation !== "requested" &&
		v.cancellation !== "local_settled" &&
		v.cancellation !== "local_failed"
	)
		return null;
	return {
		requestBodyBytes: v.requestBodyBytes as number,
		headersMs: v.headersMs as number | null,
		firstBodyByteMs: v.firstBodyByteMs as number | null,
		timeoutBudgetMs: v.timeoutBudgetMs as number | null,
		bodyBytes: v.bodyBytes as number,
		bodyChunks: v.bodyChunks as number,
		timeoutPhase: v.timeoutPhase as TransportEvidence["timeoutPhase"],
		cancellation: v.cancellation as TransportEvidence["cancellation"],
		providerCancellationAcknowledged: null,
	};
}

/** Emits only boundaries (headers, first bytes, terminal), never a per-chunk log. */
export class TransportObservation {
	private listener?: (value: TransportEvidence) => void;
	private value: TransportEvidence | null = null;
	observe(value: TransportEvidence): void {
		this.value = { ...value };
		try {
			this.listener?.({ ...value });
		} catch {
			/* telemetry cannot affect transport */
		}
	}
	bind(listener: (value: TransportEvidence) => void): void {
		this.listener = listener;
	}
	snapshot(): TransportEvidence | null {
		return this.value ? { ...this.value } : null;
	}
}
