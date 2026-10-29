// hooks/board-html/feed-store.ts — THE board feed store (owner directive
// 2026-10-29: one state owner, efficient polling). Every polled endpoint is
// a named feed owned here for the whole page — never per component, never
// per tab-render. Guarantees per feed:
//   - at most ONE request in flight (kick() while busy is a no-op), and a
//     page-wide concurrency cap (maxInFlight) queues the rest FIFO;
//   - adaptive cadence: base interval, stretched to 2× the round-trip when
//     the server is slow, full-jitter capped exponential backoff on errors,
//     429/503 Retry-After honoured (clamped), paused while document.hidden
//     and resumed on visibilitychange;
//   - every request carries an AbortSignal timeout; rescope() aborts;
//   - scope safety: a response whose URL no longer matches the feed's
//     current URL (project filter changed mid-flight) is discarded and the
//     current scope is fetched at once;
//   - HTTP citizenship: If-None-Match with the last ETag, 304 = unchanged;
//     otherwise a payload whose numeric `ts` (same URL) equals the last one
//     reports changed=false, so subscribers re-render only when their slice
//     moved.
// The class is SELF-CONTAINED (no imports, only platform globals probed with
// typeof) because the legacy chunk scope embeds it via toString() — the
// renders.ts embedDualStamp precedent — while the Lit mediator adopts the
// one page-wide instance (globalThis.klhFeeds).

export type FeedState = {
	data: unknown;
	err: string | null;
	okAt: number;
	at: number;
	busy: boolean;
	loaded: boolean;
	fails: number;
	rttMs: number;
	requests: number;
	notModified: number;
};
export type FeedSpec = {
	url: () => string | null;
	everyMs?: number;
	maxMs?: number;
	timeoutMs?: number;
	minGapMs?: number;
	manual?: boolean;
	accept?: (j: unknown) => void;
	ok?: (data: unknown, changed: boolean) => void;
	fail?: (err: string) => void;
	settle?: (st: FeedState) => void;
};
export type FeedEnv = {
	fetch: (u: string, o: RequestInit) => Promise<Response>;
	now: () => number;
	random: () => number;
	setTimer: ((fn: () => void, ms: number) => unknown) | null;
	clearTimer: ((t: unknown) => void) | null;
	hidden: () => boolean;
	maxInFlight: number;
};
type Feed = {
	spec: Required<Pick<FeedSpec, "everyMs" | "maxMs" | "timeoutMs">> & FeedSpec;
	state: FeedState;
	subs: Set<(st: FeedState, changed: boolean) => void>;
	timer: unknown;
	ctrl: AbortController | null;
	token: object | null; // identity of the request that owns the feed
	key: unknown;
	keyUrl: string | null;
	etag: string | null;
	retryAfterMs: number;
	nextAt: number;
	queued: boolean;
	validator: ((j: unknown) => void) | null;
};

export class FeedStore {
	env: FeedEnv;
	feeds: Record<string, Feed>;
	inFlight: number;
	queue: (() => void)[];
	validators: Record<string, (j: unknown) => void>;
	constructor(env?: Partial<FeedEnv>) {
		const g = globalThis;
		const doc = typeof g.document === "object" ? g.document : null;
		this.env = Object.assign(
			{
				fetch: (u: string, o: RequestInit) => g.fetch(u, o),
				now: () => Date.now(),
				random: () => Math.random(),
				setTimer:
					typeof g.setTimeout === "function"
						? (fn: () => void, ms: number) => g.setTimeout(fn, ms)
						: null,
				clearTimer:
					typeof g.clearTimeout === "function"
						? (t: unknown) => g.clearTimeout(t as number)
						: null,
				hidden: () => (doc ? doc.hidden === true : false),
				maxInFlight: 4,
			},
			env || {},
		);
		this.feeds = {};
		this.inFlight = 0;
		this.queue = [];
		this.validators = {};
		if (doc && typeof doc.addEventListener === "function")
			doc.addEventListener("visibilitychange", () => {
				if (!this.env.hidden()) this.kickDue();
			});
	}
	define(name: string, spec: FeedSpec) {
		this.feeds[name] = {
			spec: Object.assign(
				{ everyMs: 1000, maxMs: 30000, timeoutMs: 8000 },
				spec,
			),
			state: {
				data: null,
				err: null,
				okAt: 0,
				at: 0,
				busy: false,
				loaded: false,
				fails: 0,
				rttMs: 0,
				requests: 0,
				notModified: 0,
			},
			subs: new Set(),
			timer: null,
			ctrl: null,
			token: null,
			key: undefined,
			keyUrl: null,
			etag: null,
			retryAfterMs: 0,
			nextAt: 0,
			queued: false,
			validator: this.validators[name] || null,
		};
		return this;
	}
	/** Schema gate (the mediator installs zod parses): throws = feed error. */
	validate(name: string, fn: (j: unknown) => void) {
		this.validators[name] = fn; // define() order-proof: either side first
		const f = this.feeds[name];
		if (f) f.validator = fn;
	}
	get(name: string) {
		const f = this.feeds[name];
		return f ? f.state : null;
	}
	names() {
		return Object.keys(this.feeds);
	}
	subscribe(name: string, fn: (st: FeedState, changed: boolean) => void) {
		const f = this.feeds[name];
		if (!f) return () => {};
		f.subs.add(fn);
		return () => {
			f.subs.delete(fn);
		};
	}
	/** Heartbeat: request every active feed whose next poll is due. */
	kickDue() {
		if (this.env.hidden()) return;
		const now = this.env.now();
		for (const name of Object.keys(this.feeds)) {
			const f = this.feeds[name];
			if (f.state.busy || f.queued || f.timer !== null) continue;
			if (f.spec.manual || now < f.nextAt) continue;
			this.kick(name);
		}
	}
	/** Abort every in-flight request and refetch the current scope. */
	rescope() {
		const names = Object.keys(this.feeds);
		for (const name of names) {
			const f = this.feeds[name];
			if (f.ctrl) f.ctrl.abort();
			f.ctrl = null;
			f.token = null;
			f.state.busy = false;
			f.queued = false;
			f.key = undefined;
			f.etag = null;
		}
		this.inFlight = 0; // every slot was just aborted
		this.queue = [];
		for (const name of names) this.kick(name, true);
	}
	/** Request now unless one is in flight; force skips the cadence floor. */
	kick(name: string, force?: boolean) {
		const f = this.feeds[name];
		if (!f || f.state.busy) return;
		const url = f.spec.url();
		if (!url) return; // inactive (tab hidden, no drawer): resumes on kick
		const gap = f.spec.minGapMs;
		if (!force && gap && f.state.at && this.env.now() - f.state.at < gap)
			return;
		this.request(name, f, url);
	}
	release() {
		this.inFlight = Math.max(0, this.inFlight - 1);
		// stale entries (rescoped/deactivated) send nothing and pass the slot on
		while (this.inFlight < this.env.maxInFlight && this.queue.length) {
			const next = this.queue.shift();
			if (next) next();
		}
	}
	request(name: string, f: Feed, url: string) {
		const st = f.state;
		st.busy = true;
		if (f.timer !== null && this.env.clearTimer) this.env.clearTimer(f.timer);
		f.timer = null;
		if (this.inFlight >= this.env.maxInFlight) {
			const qt = {};
			f.queued = true;
			f.token = qt;
			this.queue.push(() => {
				if (!f.queued || f.token !== qt) return; // rescoped while queued
				f.queued = false;
				const cur = f.spec.url();
				if (cur) this.send(name, f, cur);
				else st.busy = false;
			});
			return;
		}
		this.send(name, f, url);
	}
	send(name: string, f: Feed, url: string) {
		const st = f.state;
		this.inFlight++;
		st.requests++;
		const started = this.env.now();
		const ctrl =
			typeof AbortController === "function" ? new AbortController() : null;
		f.ctrl = ctrl;
		let tid: unknown = null;
		if (ctrl && this.env.setTimer)
			tid = this.env.setTimer(() => ctrl.abort(), f.spec.timeoutMs);
		const opts: RequestInit = {};
		if (ctrl) opts.signal = ctrl.signal;
		else if (typeof AbortSignal === "function" && AbortSignal.timeout)
			opts.signal = AbortSignal.timeout(f.spec.timeoutMs);
		if (f.etag && f.keyUrl === url) opts.headers = { "if-none-match": f.etag };
		const token = {};
		f.token = token;
		const mine = () => f.token === token && st.busy;
		const settle = (err: string | null, data: unknown, changed: boolean) => {
			if (tid !== null && this.env.clearTimer) this.env.clearTimer(tid);
			if (!mine()) return; // rescoped: a newer request owns the feed
			f.ctrl = null;
			f.token = null;
			st.busy = false;
			this.release();
			const current = f.spec.url();
			if (current !== url) {
				// scope moved mid-flight: drop the stale answer, fetch the new scope
				if (current) this.request(name, f, current);
				return;
			}
			st.at = this.env.now();
			st.rttMs = st.at - started;
			if (err) {
				st.fails++;
				st.err = err;
				if (f.spec.fail) f.spec.fail(err);
			} else {
				st.fails = 0;
				st.err = null;
				f.retryAfterMs = 0;
				st.okAt = st.at;
				st.loaded = true;
				if (changed) st.data = data;
				if (f.spec.ok) {
					try {
						f.spec.ok(st.data, changed);
					} catch (e) {
						st.err = String((e as Error)?.message || e);
						if (f.spec.fail) f.spec.fail(st.err);
					}
				}
			}
			if (f.spec.settle) f.spec.settle(st);
			for (const fn of f.subs) fn(st, changed || Boolean(err));
			this.schedule(name, f);
		};
		const onResponse = (r: Response) => {
			if (r?.status === 304) {
				st.notModified++;
				return settle(null, st.data, false);
			}
			if (r && (r.status === 429 || r.status === 503))
				f.retryAfterMs = this.retryAfter(r);
			if (!r?.ok) throw new Error(`HTTP ${r ? r.status : "?"}`);
			const tag = r.headers?.get ? r.headers.get("etag") : null;
			return r.json().then((j: unknown) => {
				if (f.spec.accept) f.spec.accept(j); // throws on a bad payload
				if (f.validator) f.validator(j);
				const key =
					j && typeof (j as { ts?: unknown }).ts === "number"
						? (j as { ts: number }).ts
						: undefined;
				const changed = key === undefined || key !== f.key || f.keyUrl !== url;
				f.key = key;
				f.keyUrl = url;
				f.etag = tag || null;
				settle(null, j, changed);
			});
		};
		const onError = (e: unknown) => {
			if (!mine()) return; // aborted by rescope — silent
			settle(String((e as Error)?.message || e), null, false);
		};
		try {
			// called synchronously: callers (and the vm tests) see the request
			// issued the moment kick() returns
			Promise.resolve(this.env.fetch(url, opts))
				.then(onResponse)
				.catch(onError);
		} catch (e) {
			onError(e);
		}
	}
	/** Retry-After seconds or HTTP-date → ms, clamped to [1s, 5min]. */
	retryAfter(r: Response) {
		const h = r.headers?.get ? r.headers.get("retry-after") : null;
		if (!h) return 0;
		const secs = Number(h);
		const ms = Number.isFinite(secs)
			? secs * 1000
			: Date.parse(h) - this.env.now();
		return Number.isFinite(ms) ? Math.min(300000, Math.max(1000, ms)) : 0;
	}
	/** Next poll: base cadence, 2× round-trip when slow, jittered backoff. */
	delayFor(f: Feed) {
		const s = f.spec;
		const st = f.state;
		if (st.fails > 0) {
			const cap = Math.min(s.maxMs, s.everyMs * 2 ** Math.min(st.fails, 8));
			const jitter = this.env.random() * cap; // full jitter (AWS backoff)
			return Math.max(s.everyMs, jitter, f.retryAfterMs);
		}
		return Math.min(s.maxMs, Math.max(s.everyMs, st.rttMs * 2));
	}
	schedule(name: string, f: Feed) {
		const delay = this.delayFor(f);
		f.nextAt = this.env.now() + delay;
		if (!this.env.setTimer || f.spec.manual) return;
		if (f.timer !== null && this.env.clearTimer) this.env.clearTimer(f.timer);
		f.timer = null;
		if (this.env.hidden()) return; // visibilitychange resumes via kickDue
		f.timer = this.env.setTimer(() => {
			f.timer = null;
			this.kick(name);
		}, delay);
	}
}
