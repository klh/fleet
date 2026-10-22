import PQueue from "p-queue";
import {
	assertProviderConcurrencyErrorCodes,
	type ProviderPressure,
} from "./provider-pressure.ts";

export {
	assertProviderConcurrencyErrorCodes,
	type ProviderPressure,
	providerPressureOf,
} from "./provider-pressure.ts";

export interface ProviderPoolPolicy {
	concurrency: number;
	intervalCap: number;
	intervalMs: number;
	maxOutstanding: number;
	queueWaitMs: number;
	recovery: { successWindow: number; decreasePercent: number };
	/** Explicit account/operator classification, never inferred from provider names. */
	concurrencyErrorCodes?: string[];
}

export function assertProviderPoolPolicy(
	value: unknown,
): asserts value is ProviderPoolPolicy {
	const p = value as ProviderPoolPolicy | null;
	if (p?.concurrencyErrorCodes !== undefined)
		assertProviderConcurrencyErrorCodes(p.concurrencyErrorCodes);
	const positive = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
	if (
		!p ||
		typeof p !== "object" ||
		Object.keys(p).length !== (p.concurrencyErrorCodes === undefined ? 6 : 7) ||
		Object.keys(p).some(
			(key) =>
				![
					"concurrency",
					"intervalCap",
					"intervalMs",
					"maxOutstanding",
					"queueWaitMs",
					"recovery",
					"concurrencyErrorCodes",
				].includes(key),
		) ||
		![
			p.concurrency,
			p.intervalCap,
			p.intervalMs,
			p.maxOutstanding,
			p.queueWaitMs,
		].every(positive) ||
		p.maxOutstanding < p.concurrency ||
		!p.recovery ||
		typeof p.recovery !== "object" ||
		Object.keys(p.recovery).length !== 2 ||
		!positive(p.recovery.successWindow) ||
		!positive(p.recovery.decreasePercent) ||
		p.recovery.decreasePercent >= 100
	) {
		throw new Error(
			"Invalid provider pool policy: five positive limits and explicit bounded recovery are required",
		);
	}
}
export interface ProviderLease {
	release(): void;
	feedback?(
		status: number,
		retryAfterS: number | null,
		pressure?: ProviderPressure,
	): void;
}
export class ProviderAdmissionFull extends Error {}

// Leave room for several paced starts within the configured admission wait.
const MAX_ADAPTIVE_GAP_MS = 30_000;

/** One instance per explicit account-pool ID at its authoritative egress.
 * maxOutstanding includes running requests: the whole retained set is bounded.
 * intervalCap counts STARTS; long streams do not consume another RPM slot. */
export class ProviderAdmissionCore {
	private readonly queue: PQueue;
	private outstanding = 0;
	private readonly baseGapMs: number;
	private adaptiveGapMs: number;
	private notBeforeMs = 0;
	private lastStartedAt = 0;
	private feedbackEpoch = 0;
	private readonly pressureEpoch = { rate: 0, concurrency: 0 };
	private readonly pressureUntil = { rate: 0, concurrency: 0 };
	private rateLimitedTotal = 0;
	private concurrencyLimitedTotal = 0;
	private adaptiveConcurrency: number;
	private concurrencySuccesses = 0;
	private recoverySuccesses = 0;
	private congestionUntilMs = 0;
	private recoveredAtMs = 0;
	private resumeTimer?: ReturnType<typeof setTimeout>;
	constructor(private readonly policy: ProviderPoolPolicy) {
		assertProviderPoolPolicy(policy);
		this.queue = new PQueue({
			concurrency: policy.concurrency,
			intervalCap: policy.intervalCap,
			interval: policy.intervalMs,
			strict: true,
		});
		this.baseGapMs = Math.max(1, policy.intervalMs / policy.intervalCap);
		this.adaptiveGapMs = this.baseGapMs;
		this.adaptiveConcurrency = policy.concurrency;
		this.queue.on("active", () => {
			this.lastStartedAt = Date.now();
			if (
				this.adaptiveGapMs > this.baseGapMs ||
				this.notBeforeMs > this.lastStartedAt
			)
				this.scheduleStarts();
		});
	}

	/** Pause only queued starts. Running leases and their stream guards never
	 * move or restart; PQueue continues to own ordering and cancellation. */
	private scheduleStarts(): void {
		if (this.resumeTimer) clearTimeout(this.resumeTimer);
		this.resumeTimer = undefined;
		const now = Date.now();
		const adaptive = this.adaptiveGapMs > this.baseGapMs;
		const eligibleAt = Math.max(
			this.notBeforeMs,
			adaptive ? this.lastStartedAt + this.adaptiveGapMs : 0,
		);
		if (eligibleAt <= now) {
			this.queue.start();
			return;
		}
		this.queue.pause();
		this.resumeTimer = setTimeout(
			() => this.scheduleStarts(),
			Math.min(2_147_483_647, Math.max(1, Math.ceil(eligibleAt - now))),
		);
		this.resumeTimer.unref();
	}

	private feedback(
		epoch: number,
		pressureEpoch: Record<ProviderPressure, number>,
		startedAt: number,
		startedOccupancy: number,
		status: number,
		retryAfterS: number | null,
		pressure: ProviderPressure,
	): void {
		const now = Date.now();
		if (status === 429) {
			this.rateLimitedTotal++;
			if (pressure === "concurrency") this.concurrencyLimitedTotal++;
			if (
				retryAfterS !== null &&
				Number.isFinite(retryAfterS) &&
				retryAfterS > 0
			)
				this.notBeforeMs = Math.max(
					this.notBeforeMs,
					Math.min(Number.MAX_SAFE_INTEGER, Date.now() + retryAfterS * 1000),
				);
			// One old in-flight burst is one capacity signal, not forty doublings.
			if (
				pressureEpoch[pressure] === this.pressureEpoch[pressure] &&
				now >= this.pressureUntil[pressure]
			) {
				this.pressureEpoch[pressure]++;
				this.feedbackEpoch++;
				// Use the configured evidence sample horizon on both sides of the
				// controller. One RTT alone lets delayed waves create new epochs
				// faster than enough healthy observations can disprove pressure.
				this.pressureUntil[pressure] =
					now +
					Math.min(
						this.policy.queueWaitMs,
						this.policy.recovery.successWindow *
							Math.max(this.baseGapMs, now - startedAt),
					);
				// Independent pressure dimensions must not mask one another in
				// the same in-flight burst. Successes retain a global epoch fence.
				this.congestionUntilMs = Math.max(
					this.pressureUntil.rate,
					this.pressureUntil.concurrency,
				);
				if (pressure === "concurrency") {
					// Refused-lease occupancy is an upper bound, not a provider limit.
					// Lower the local window without cancelling any active lease.
					this.adaptiveConcurrency = Math.max(
						1,
						Math.min(this.adaptiveConcurrency, startedOccupancy - 1),
					);
					this.queue.concurrency = this.adaptiveConcurrency;
				} else {
					this.adaptiveGapMs = Math.min(
						Math.max(
							this.baseGapMs,
							Math.min(MAX_ADAPTIVE_GAP_MS, this.policy.queueWaitMs / 4),
						),
						this.adaptiveGapMs * 2,
					);
					this.notBeforeMs = Math.max(
						this.notBeforeMs,
						Date.now() + this.adaptiveGapMs,
					);
				}
			}
			// Even a coalesced 429 invalidates the healthy streak. It must not
			// leave seven successes poised to erase a new pressure signal.
			this.recoverySuccesses = 0;
			this.concurrencySuccesses = 0;
			this.recoveredAtMs = now;
			this.scheduleStarts();
		} else if (
			status >= 200 &&
			status < 300 &&
			epoch === this.feedbackEpoch &&
			now >= this.congestionUntilMs &&
			now >= this.notBeforeMs
		) {
			if (
				this.adaptiveConcurrency < this.policy.concurrency &&
				this.queue.size > 0
			) {
				this.concurrencySuccesses++;
				if (this.concurrencySuccesses >= this.policy.recovery.successWindow) {
					this.adaptiveConcurrency++;
					this.queue.concurrency = this.adaptiveConcurrency;
					this.concurrencySuccesses = 0;
				}
			}
			if (this.adaptiveGapMs <= this.baseGapMs) return;
			this.recoverySuccesses = Math.min(
				this.policy.recovery.successWindow,
				this.recoverySuccesses + 1,
			);
			if (
				this.recoverySuccesses >= this.policy.recovery.successWindow &&
				now - this.recoveredAtMs >= this.baseGapMs
			) {
				this.recoveredAtMs = now;
				this.adaptiveGapMs = Math.max(
					this.baseGapMs,
					this.adaptiveGapMs * (1 - this.policy.recovery.decreasePercent / 100),
				);
				this.scheduleStarts();
			}
		}
	}
	snapshot() {
		return {
			outstanding: this.outstanding,
			queued: this.queue.size,
			active: this.queue.pending,
			adaptiveConcurrency: this.adaptiveConcurrency,
			concurrencyCeiling: this.policy.concurrency,
			concurrencyLimitedTotal: this.concurrencyLimitedTotal,
			concurrencyRecoverySuccesses: this.concurrencySuccesses,
			baseGapMs: this.baseGapMs,
			adaptiveGapMs: this.adaptiveGapMs,
			notBeforeMs: this.notBeforeMs,
			rateLimitedTotal: this.rateLimitedTotal,
			recoverySuccesses: this.recoverySuccesses,
			recoverySuccessWindow: this.policy.recovery.successWindow,
			recoveryDecreasePercent: this.policy.recovery.decreasePercent,
			feedbackEpoch: this.feedbackEpoch,
			congestionUntilMs: this.congestionUntilMs,
		};
	}

	/** maxWaitMs caps this wait by the caller's remaining attempt budget —
	 * the queue wait never extends a request deadline (still bounded by the
	 * configured queueWaitMs). Granted leases are unaffected by either. */
	acquire(caller?: AbortSignal, maxWaitMs?: number): Promise<ProviderLease> {
		if (caller?.aborted) return Promise.reject(caller.reason);
		if (this.outstanding >= this.policy.maxOutstanding)
			return Promise.reject(new ProviderAdmissionFull("Provider queue full"));
		this.outstanding++;
		const deadline = new AbortController();
		const signal = caller
			? AbortSignal.any([caller, deadline.signal])
			: deadline.signal;
		const waitMs =
			maxWaitMs === undefined
				? this.policy.queueWaitMs
				: Math.min(this.policy.queueWaitMs, maxWaitMs);
		const timer = setTimeout(
			() =>
				deadline.abort(
					new DOMException("Provider queue wait expired", "TimeoutError"),
				),
			waitMs,
		);
		let grant!: (lease: ProviderLease) => void;
		let deny!: (error: unknown) => void;
		const acquired = new Promise<ProviderLease>((resolve, reject) => {
			grant = resolve;
			deny = reject;
		});
		void this.queue
			.add(
				async () => {
					clearTimeout(timer); // queue wait deadline MUST NOT become a stream timeout
					signal.throwIfAborted();
					let unlock!: () => void;
					const held = new Promise<void>((resolve) => {
						unlock = resolve;
					});
					let released = false;
					const release = () => {
						if (released) return;
						released = true;
						signal.removeEventListener("abort", release);
						unlock();
					};
					signal.addEventListener("abort", release, { once: true });
					const epoch = this.feedbackEpoch;
					const pressureEpoch = { ...this.pressureEpoch };
					const startedAt = Date.now();
					const startedOccupancy = this.queue.pending;
					grant({
						release,
						feedback: (status, retryAfterS, pressure = "rate") => {
							// An aborted lease cannot become healthy if its transport
							// later reaches EOF. Error bodies may settle before parsing
							// their pressure feedback, so refusals remain observable.
							if (released && status >= 200 && status < 300) return;
							this.feedback(
								epoch,
								pressureEpoch,
								startedAt,
								startedOccupancy,
								status,
								retryAfterS,
								pressure,
							);
						},
					});
					await held;
				},
				{ signal },
			)
			.catch(deny)
			.finally(() => {
				clearTimeout(timer);
				this.outstanding--;
			});
		return acquired;
	}
}

/** Call after headers: queue task remains pending until this body settles.
 * Router MUST release on fetch failure before a Response exists, and pass the
 * caller signal into the upstream fetch so cancellation also stops the socket. */
export function bindProviderLease(
	response: Response,
	lease: ProviderLease,
): Response {
	if (!response.body) {
		lease.release();
		return response;
	}
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = response.body.getReader();
	} catch (error) {
		lease.release();
		throw error;
	}
	const release = () => {
		lease.release();
		reader.releaseLock();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					if (response.ok) lease.feedback?.(response.status, null);
					release();
					controller.close();
				} else controller.enqueue(next.value);
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				release();
			}
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
