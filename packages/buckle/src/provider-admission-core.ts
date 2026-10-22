import PQueue from "p-queue";

export interface ProviderPoolPolicy {
	concurrency: number;
	intervalCap: number;
	intervalMs: number;
	maxOutstanding: number;
	queueWaitMs: number;
}
export interface ProviderLease {
	release(): void;
	feedback?(status: number, retryAfterS: number | null): void;
}
export class ProviderAdmissionFull extends Error {}

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
	private rateLimitedTotal = 0;
	private recoverySuccesses = 0;
	private resumeTimer?: ReturnType<typeof setTimeout>;
	constructor(private readonly policy: ProviderPoolPolicy) {
		for (const n of Object.values(policy)) {
			if (!Number.isSafeInteger(n) || n <= 0)
				throw new Error("Invalid provider pool policy");
		}
		if (policy.maxOutstanding < policy.concurrency)
			throw new Error("Invalid provider pool bound");
		this.queue = new PQueue({
			concurrency: policy.concurrency,
			intervalCap: policy.intervalCap,
			interval: policy.intervalMs,
			strict: true,
		});
		this.baseGapMs = Math.max(1, policy.intervalMs / policy.intervalCap);
		this.adaptiveGapMs = this.baseGapMs;
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
		status: number,
		retryAfterS: number | null,
	): void {
		if (status === 429) {
			this.rateLimitedTotal++;
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
			if (epoch === this.feedbackEpoch) {
				this.feedbackEpoch++;
				this.adaptiveGapMs = Math.min(
					Math.max(this.baseGapMs, this.policy.queueWaitMs),
					this.adaptiveGapMs * 2,
				);
				this.notBeforeMs = Math.max(
					this.notBeforeMs,
					Date.now() + this.adaptiveGapMs,
				);
				this.recoverySuccesses = 0;
			}
			this.scheduleStarts();
		} else if (
			status >= 200 &&
			status < 300 &&
			epoch === this.feedbackEpoch &&
			this.adaptiveGapMs > this.baseGapMs
		) {
			if (++this.recoverySuccesses >= 8) {
				this.recoverySuccesses = 0;
				this.adaptiveGapMs = Math.max(
					this.baseGapMs,
					this.adaptiveGapMs * 0.95,
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
			baseGapMs: this.baseGapMs,
			adaptiveGapMs: this.adaptiveGapMs,
			notBeforeMs: this.notBeforeMs,
			rateLimitedTotal: this.rateLimitedTotal,
			recoverySuccesses: this.recoverySuccesses,
			feedbackEpoch: this.feedbackEpoch,
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
					grant({
						release,
						feedback: (status, retryAfterS) =>
							this.feedback(epoch, status, retryAfterS),
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
