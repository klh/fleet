// heartbeat.ts — keeps a worker's registration fresh. "Announce on connect
// and on change; heartbeat keeps it fresh" (fleet-cockpit-tui.md §4).
// Deliberately NOT a pi-durable Task: it has no checkpointed state worth
// surviving a crash (a stale row ages out and the hub's own GC reaps it —
// W2888 description "stale-row GC" is a hub-side concern) — a plain
// interval loop driven by an injectable clock is the whole pattern, and it
// stays host-dark tolerant by construction (every tick swallows failures).

import type { RegistrationClient, WorkerAnnouncement } from "./registration.ts";

export type HeartbeatClock = {
	readonly setInterval: (callback: () => void, ms: number) => unknown;
	readonly clearInterval: (handle: unknown) => void;
};

const defaultClock: HeartbeatClock = {
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (handle) =>
		clearInterval(handle as ReturnType<typeof setInterval>),
};

export type HeartbeatEvent =
	| { readonly kind: "announce" | "heartbeat"; readonly ok: true }
	| {
			readonly kind: "announce" | "heartbeat";
			readonly ok: false;
			readonly reason: string;
	  };

export type WorkerHeartbeatOptions = {
	readonly client: RegistrationClient;
	readonly intervalMs: number;
	readonly clock?: HeartbeatClock;
	/** Current snapshot of this worker; called fresh at announce/heartbeat/change time. */
	readonly snapshot: () => WorkerAnnouncement;
	readonly onEvent?: (event: HeartbeatEvent) => void;
};

/**
 * Announces immediately on `start()`, then re-registers every `intervalMs`.
 * `announceChange()` re-registers out-of-band (state/task changed) without
 * waiting for the next tick — the interval is a freshness floor, not the
 * only trigger.
 */
export class WorkerHeartbeat {
	readonly #client: RegistrationClient;
	readonly #intervalMs: number;
	readonly #clock: HeartbeatClock;
	readonly #snapshot: () => WorkerAnnouncement;
	readonly #onEvent: (event: HeartbeatEvent) => void;
	#handle: unknown;

	constructor(options: WorkerHeartbeatOptions) {
		this.#client = options.client;
		this.#intervalMs = options.intervalMs;
		this.#clock = options.clock ?? defaultClock;
		this.#snapshot = options.snapshot;
		this.#onEvent = options.onEvent ?? (() => {});
	}

	async start(): Promise<void> {
		await this.#register("announce");
		this.#handle = this.#clock.setInterval(
			() => void this.#register("heartbeat"),
			this.#intervalMs,
		);
	}

	async announceChange(): Promise<void> {
		await this.#register("heartbeat");
	}

	stop(): void {
		if (this.#handle !== undefined) this.#clock.clearInterval(this.#handle);
		this.#handle = undefined;
	}

	async #register(kind: "announce" | "heartbeat"): Promise<void> {
		const result = await this.#client.register(this.#snapshot());
		this.#onEvent(
			result.ok
				? { kind, ok: true }
				: { kind, ok: false, reason: result.reason },
		);
	}
}
