/**
 * pi-durable-workers — announce/heartbeat per the W2886 worker contract.
 *
 * Posts worker state to the hub so the cockpit can render announced rows
 * (reported_by = hub:durable-workers). Hub-dark tolerant: a failed POST is
 * queued and retried with capped exponential backoff; announce NEVER blocks
 * or fails the executor.
 *
 * Wire contract (C323 deltas accepted):
 *   { workers: [{ sid, label, state, task, origin{id,kind:"runner"},
 *                compute{hub_id,...}, inference[], rights[], activity[],
 *                reported_by, expires_in_s? }], asOf, errors: [] }
 */

import { createLogger, type Logger } from "@klh/buckle/src/log";

export type AnnounceWorker = {
	readonly sid: string;
	readonly label: string;
	readonly state: string;
	readonly task: string;
	readonly origin: { readonly id: string; readonly kind: "runner" | (string & {}) };
	readonly compute: { readonly hub_id: string; readonly host: string | null; readonly region: string | null };
	readonly inference: readonly { readonly hub: string; readonly hub_id: string; readonly model: string; readonly since: number; readonly calls: number }[];
	readonly rights: readonly string[];
	readonly activity: readonly { readonly at: number; readonly kind: string; readonly text?: string }[];
};

export type AnnounceOptions = {
	readonly hubUrl: string;
	readonly token?: string;
	readonly conversationId: string;
	readonly label: string;
	readonly everyS?: number;
	readonly fetchImpl?: typeof fetch;
	readonly onEvent?: (event: { at: number; kind: string; text?: string }) => void;
	/** Shared logger seam (default `createLogger("workers.announce")`). */
	readonly logger?: Logger;
};

export type Announcer = {
	readonly beat: (state: string, task: string, extra?: Partial<AnnounceWorker>) => Promise<void>;
	readonly activity: (kind: string, text?: string) => void;
	readonly stop: () => void;
};

const MAX_QUEUE = 100;
const MAX_BACKOFF_MS = 60_000;

export function createAnnouncer(options: AnnounceOptions): Announcer {
	const everyS = options.everyS ?? 30;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const log = options.logger ?? createLogger("workers.announce");
	let queue: Array<{ at: number; kind: string; text?: string }> = [];
	let last: { state: string; task: string } | null = null;
	let stopped = false;
	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function pushActivity(kind: string, text?: string): void {
		queue = [...queue, { at: Date.now(), kind, text }].slice(-MAX_QUEUE);
	}

	async function post(state: string, task: string, activity: typeof queue): Promise<boolean> {
		const workers: AnnounceWorker[] = [
			{
				sid: options.conversationId,
				label: options.label,
				state,
				task,
				origin: { id: options.conversationId, kind: "runner" },
				compute: { hub_id: hubIdFromUrl(options.hubUrl), host: null, region: null },
				inference: [],
				rights: [], // plane computes; verbatim when it emits them
				activity,
			},
		];
		const body = JSON.stringify({ workers, asOf: Date.now(), errors: [] });
		try {
			const res = await fetchImpl(new URL("/workers/announce", options.hubUrl).toString(), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
				},
				body,
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) throw new Error(`announce ${res.status}`);
			return true;
		} catch (e) {
			log.warn(`announce post failed (failure ${failures + 1}, backoff grows): ${String((e as Error)?.message ?? e)}`);
			return false;
		}
	}

	async function tick(): Promise<void> {
		if (stopped) return;
		if (last) {
			const ok = await post(last.state, last.task, queue);
			if (ok) {
				if (failures > 0) log.info(`announce recovered after ${failures} failures`);
				queue = [];
				failures = 0;
			} else {
				failures += 1;
			}
		}
		const delay = Math.min(MAX_BACKOFF_MS, everyS * 1000 * 2 ** failures);
		timer = setTimeout(() => void tick(), delay);
		timer.unref?.();
	}

	timer = setTimeout(() => void tick(), 0);
	timer.unref?.();

	return {
		beat: async (state, task, extra) => {
			last = { state, task };
			pushActivity(extra?.activity ? String(extra.activity[0]?.kind ?? state) : state);
			await post(state, task, queue).then((ok) => {
				if (ok) {
					queue = [];
					failures = 0;
				} else failures += 1;
			});
		},
		activity: pushActivity,
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}

function hubIdFromUrl(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "unreported";
	}
}
