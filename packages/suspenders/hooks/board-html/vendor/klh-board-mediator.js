import { _, a, c, E, g, i, m, o, p, s, y, z } from "./lit-0a9982d0e15be9ce.js";
import { e, n, r, t } from "./lit-9ab93f5debb235da.js";
import { D } from "./lit-bbcd2c46a367dbcd.js";
function L(d, l, u) {
	let h = d.observation,
		f = (T) => Math.max(0, Math.round((d.now - T) / 1000)),
		b =
			h && typeof h.observedAt === "number"
				? f(h.observedAt)
				: d.dataOkAt
					? f(d.dataOkAt)
					: -1,
		k = h ? Number(h.expiresAt) : Number.NaN,
		w =
			!!h &&
			(!Number.isFinite(k) ||
				k <= d.now ||
				Number(h.observedAt) > d.now + 5000),
		M = "live",
		A = "live";
	if (d.dataErr && !d.dataOkAt) (M = "err"), (A = "connecting");
	else if (d.dataErr) (M = "err"), (A = `error — last good ${l(b)}`);
	else if (w || b >= 5)
		(M = "stale"), (A = `stale snapshot — observed ${l(b)}`);
	const F = !d.decLoaded
			? "decisions loading"
			: d.decErr
				? "decisions unavailable"
				: `decisions checked ${l(d.decOkAt ? f(d.decOkAt) : -1)}`,
		q = h
			? `Source: ${h.source} · target: ${h.target} · scope: ${h.scope} · observed: ${u(h.observedAt)} · expires: ${u(h.expiresAt)}`
			: "Legacy feed without observation provenance";
	return { cls: M, txt: A, dec: F, title: q, retry: !!d.dataErr };
}
var Z = i({
		source: o(s()),
		target: o(s()),
		scope: o(s()),
		observedAt: o(c()),
		expiresAt: o(c()),
	}),
	H = i({
		ts: c(),
		projects: a(i({ project: s() })),
		sessions: o(a(i({}))),
		observation: o(Z),
	}),
	W = i({ ts: c(), decisions: a(i({})), projects: o(a(s())) }),
	K = i({
		ok: z(!0),
		tasks: a(i({ id: s(), project: s() })),
		projects: o(a(s())),
	}),
	G = i({ ok: z(!0), series: g(s(), m()), attempts: o(g(s(), m())) }),
	R = { data: H, dec: W, tasks: K, spend: G };
function I(d) {
	return (l) => {
		const u = d.safeParse(l);
		if (!u.success) throw Error(`schema: ${E(u.error)}`);
	};
}
class O {
	env;
	feeds;
	inFlight;
	queue;
	validators;
	role;
	channel;
	peerAt;
	static SHADOW_TTL_MS = 600000;
	static PEER_TTL_MS = 60000;
	constructor(d) {
		const l = globalThis,
			u = typeof l.document === "object" ? l.document : null;
		if (
			((this.env = Object.assign(
				{
					fetch: (h, f) => l.fetch(h, f),
					now: () => Date.now(),
					random: () => Math.random(),
					setTimer:
						typeof l.setTimeout === "function"
							? (h, f) => l.setTimeout(h, f)
							: null,
					clearTimer:
						typeof l.clearTimeout === "function"
							? (h) => l.clearTimeout(h)
							: null,
					hidden: () => (u ? u.hidden === !0 : !1),
					maxInFlight: 4,
				},
				d || {},
			)),
			(this.feeds = {}),
			(this.inFlight = 0),
			(this.queue = []),
			(this.validators = {}),
			(this.role = "solo"),
			(this.channel = null),
			(this.peerAt = 0),
			u && typeof u.addEventListener === "function")
		)
			u.addEventListener("visibilitychange", () => {
				if (!this.env.hidden()) this.kickDue();
			});
	}
	define(d, l, u) {
		return (
			(this.feeds[d] = {
				spec: Object.assign(
					{ everyMs: 1000, maxMs: 30000, timeoutMs: 8000 },
					l,
				),
				state: {
					data: null,
					err: null,
					okAt: 0,
					at: 0,
					busy: !1,
					loaded: !1,
					fails: 0,
					rttMs: 0,
					requests: 0,
					notModified: 0,
				},
				subs: new Set(),
				timer: null,
				ctrl: null,
				token: null,
				key: void 0,
				keyUrl: null,
				etag: null,
				retryAfterMs: 0,
				nextAt: 0,
				queued: !1,
				validator: this.validators[u || d] || null,
				shadowOf: u || null,
				wantAt: 0,
			}),
			this
		);
	}
	validate(d, l) {
		this.validators[d] = l;
		for (const u of Object.values(this.feeds))
			if (u === this.feeds[d] || u.shadowOf === d) u.validator = l;
	}
	get(d) {
		const l = this.feeds[d];
		return l ? l.state : null;
	}
	names() {
		return Object.keys(this.feeds).filter((d) => !this.feeds[d].shadowOf);
	}
	subscribe(d, l) {
		const u = this.feeds[d];
		if (!u) return () => {};
		return (
			u.subs.add(l),
			() => {
				u.subs.delete(l);
			}
		);
	}
	share(d) {
		let l = globalThis,
			u = d || {},
			h = u.name || `klh-feeds:${l.location?.pathname || "/"}`,
			f = u.locks !== void 0 ? u.locks : l.navigator?.locks,
			b = u.channel !== void 0 ? u.channel : null;
		if (!b && u.channel === void 0 && l.BroadcastChannel && f)
			b = new l.BroadcastChannel(h);
		if (!f || !b || this.role !== "solo") return this;
		return (
			(this.role = "follower"),
			(this.channel = b),
			(b.onmessage = (k) => this.onShare(k.data)),
			f.request(h, () => (this.lead(), new Promise(() => {}))),
			this
		);
	}
	lead() {
		this.role = "leader";
		const d = this.env.now();
		for (const l of this.names()) {
			const u = this.feeds[l];
			if (u.spec.manual || u.state.busy) continue;
			if (d >= u.nextAt || !u.state.loaded) this.kick(l);
			else this.schedule(l, u, u.nextAt - d);
		}
	}
	onShare(d) {
		if (!d || typeof d !== "object") return;
		if (d.t === "want" && this.role === "leader") this.onWant(d);
		else if (d.t === "snap" && this.role === "follower") this.deliver(d);
	}
	onWant(d) {
		const l = this.feeds[d.feed];
		if (!l || l.shadowOf || typeof d.url !== "string") return;
		const u = this.env.now();
		this.peerAt = u;
		const h = l.spec.url() === d.url ? d.feed : this.shadow(d.feed, d.url),
			f = this.feeds[h];
		if (((f.wantAt = u), d.need && f.state.loaded && f.keyUrl === d.url))
			this.publish(h, f, d.url, null, !0);
		if (f.state.busy || (f.state.loaded && u < f.nextAt)) return;
		this.kick(h, !0);
	}
	shadow(d, l) {
		const u = `${d}\x00${l}`;
		if (!this.feeds[u]) {
			const h = this.env.now();
			for (const b of Object.keys(this.feeds))
				if (
					this.feeds[b].shadowOf &&
					h - this.feeds[b].wantAt > O.SHADOW_TTL_MS
				)
					delete this.feeds[b];
			const f = this.feeds[d].spec;
			this.define(
				u,
				{
					url: () => l,
					everyMs: f.everyMs,
					maxMs: f.maxMs,
					timeoutMs: f.timeoutMs,
					accept: f.accept,
					manual: !0,
				},
				d,
			);
		}
		return u;
	}
	deliver(d) {
		const l = this.feeds[d.feed];
		if (!l || l.spec.url() !== d.url) return;
		let u = !1,
			h = null;
		if (!d.err) {
			if (d.changed && d.data !== void 0)
				(u = d.key === void 0 || d.key !== l.key || l.keyUrl !== d.url),
					(h = d.data);
			else if (l.keyUrl !== d.url || l.key !== d.key)
				return this.want(d.feed, l, d.url, !0);
			(l.key = d.key), (l.keyUrl = d.url);
		}
		this.apply(d.feed, l, d.err, h, u, Number(d.rtt) || 0);
	}
	want(d, l, u, h) {
		if (((l.nextAt = this.env.now() + this.delayFor(l)), this.channel))
			this.channel.postMessage({ t: "want", feed: d, url: u, need: h });
	}
	publish(d, l, u, h, f) {
		if (!this.channel || this.env.now() - this.peerAt > O.PEER_TTL_MS) return;
		const b = {
			t: "snap",
			feed: l.shadowOf || d,
			url: u,
			err: h,
			changed: f,
			key: l.key,
			rtt: l.state.rttMs,
		};
		if (f && !h) b.data = l.state.data;
		this.channel.postMessage(b);
	}
	kickDue() {
		if (this.env.hidden()) return;
		const d = this.env.now();
		for (const l of Object.keys(this.feeds)) {
			const u = this.feeds[l];
			if (u.state.busy || u.queued || u.timer !== null) continue;
			if (u.spec.manual || d < u.nextAt) continue;
			this.kick(l);
		}
	}
	rescope() {
		const d = Object.keys(this.feeds);
		for (const l of d) {
			const u = this.feeds[l];
			if (u.ctrl) u.ctrl.abort();
			(u.ctrl = null),
				(u.token = null),
				(u.state.busy = !1),
				(u.queued = !1),
				(u.key = void 0),
				(u.etag = null);
		}
		(this.inFlight = 0), (this.queue = []);
		for (const l of d) this.kick(l, !0);
	}
	kick(d, l) {
		const u = this.feeds[d];
		if (!u || u.state.busy) return;
		const h = u.spec.url();
		if (!h) return;
		const f = u.spec.minGapMs;
		if (!l && f && u.state.at && this.env.now() - u.state.at < f) return;
		if (this.role === "follower")
			return this.want(d, u, h, Boolean(l) || u.keyUrl !== h);
		this.request(d, u, h);
	}
	release() {
		this.inFlight = Math.max(0, this.inFlight - 1);
		while (this.inFlight < this.env.maxInFlight && this.queue.length) {
			const d = this.queue.shift();
			if (d) d();
		}
	}
	request(d, l, u) {
		const h = l.state;
		if (((h.busy = !0), l.timer !== null && this.env.clearTimer))
			this.env.clearTimer(l.timer);
		if (((l.timer = null), this.inFlight >= this.env.maxInFlight)) {
			const f = {};
			(l.queued = !0),
				(l.token = f),
				this.queue.push(() => {
					if (!l.queued || l.token !== f) return;
					l.queued = !1;
					const b = l.spec.url();
					if (b) this.send(d, l, b);
					else h.busy = !1;
				});
			return;
		}
		this.send(d, l, u);
	}
	send(d, l, u) {
		const h = l.state;
		this.inFlight++, h.requests++;
		const f = this.env.now(),
			b = typeof AbortController === "function" ? new AbortController() : null;
		l.ctrl = b;
		let k = null;
		if (b && this.env.setTimer)
			k = this.env.setTimer(() => b.abort(), l.spec.timeoutMs);
		const w = {};
		if (b) w.signal = b.signal;
		else if (typeof AbortSignal === "function" && AbortSignal.timeout)
			w.signal = AbortSignal.timeout(l.spec.timeoutMs);
		if (l.etag && l.keyUrl === u) w.headers = { "if-none-match": l.etag };
		const M = {};
		l.token = M;
		const A = () => l.token === M && h.busy,
			F = (v, C, x) => {
				if (k !== null && this.env.clearTimer) this.env.clearTimer(k);
				if (!A()) return;
				(l.ctrl = null), (l.token = null), (h.busy = !1), this.release();
				const S = l.spec.url();
				if (S !== u) {
					if (S) this.request(d, l, S);
					return;
				}
				if (
					(this.apply(d, l, v, C, x, this.env.now() - f),
					this.role === "leader")
				)
					this.publish(d, l, u, v, x);
			},
			q = (v) => {
				if (v?.status === 304) return h.notModified++, F(null, h.data, !1);
				if (v && (v.status === 429 || v.status === 503))
					l.retryAfterMs = this.retryAfter(v);
				if (!v?.ok) return this.failure(v);
				const C = v.headers?.get ? v.headers.get("etag") : null;
				return v.json().then((x) => {
					if (l.spec.accept) l.spec.accept(x);
					if (l.validator) l.validator(x);
					const S = x && typeof x.ts === "number" ? x.ts : void 0,
						V = S === void 0 || S !== l.key || l.keyUrl !== u;
					(l.key = S), (l.keyUrl = u), (l.etag = C || null), F(null, x, V);
				});
			},
			T = (v) => {
				if (!A()) return;
				F(String(v?.message || v), null, !1);
			};
		try {
			Promise.resolve(this.env.fetch(u, w)).then(q).catch(T);
		} catch (v) {
			T(v);
		}
	}
	apply(d, l, u, h, f, b) {
		const k = l.state;
		if (((k.at = this.env.now()), (k.rttMs = b), u)) {
			if ((k.fails++, (k.err = u), l.spec.fail)) l.spec.fail(u);
		} else {
			if (
				((k.fails = 0),
				(k.err = null),
				(l.retryAfterMs = 0),
				(k.okAt = k.at),
				(k.loaded = !0),
				f)
			)
				k.data = h;
			if (l.spec.ok)
				try {
					l.spec.ok(k.data, f);
				} catch (w) {
					if (((k.err = String(w?.message || w)), l.spec.fail))
						l.spec.fail(k.err);
				}
		}
		if (l.spec.settle) l.spec.settle(k);
		for (const w of l.subs) w(k, f || Boolean(u));
		this.schedule(d, l);
	}
	failure(d) {
		const l = Error(`HTTP ${d ? d.status : "?"}`);
		if (!d || typeof d.json !== "function") return Promise.reject(l);
		return d.json().then(
			(u) => {
				const h = u && typeof u.error === "string" ? u.error : "";
				throw h ? Error(h) : l;
			},
			() => {
				throw l;
			},
		);
	}
	retryAfter(d) {
		const l = d.headers?.get ? d.headers.get("retry-after") : null;
		if (!l) return 0;
		const u = Number(l),
			h = Number.isFinite(u) ? u * 1000 : Date.parse(l) - this.env.now();
		return Number.isFinite(h) ? Math.min(300000, Math.max(1000, h)) : 0;
	}
	delayFor(d) {
		const { spec: l, state: u } = d;
		if (u.fails > 0) {
			const h = Math.min(l.maxMs, l.everyMs * 2 ** Math.min(u.fails, 8)),
				f = this.env.random() * h;
			return Math.max(l.everyMs, f, d.retryAfterMs);
		}
		return Math.min(l.maxMs, Math.max(l.everyMs, u.rttMs * 2));
	}
	schedule(d, l, u) {
		const h = u === void 0 ? this.delayFor(l) : u;
		if (((l.nextAt = this.env.now() + h), !this.env.setTimer || l.spec.manual))
			return;
		if (l.timer !== null && this.env.clearTimer) this.env.clearTimer(l.timer);
		if (((l.timer = null), this.env.hidden() || this.role === "follower"))
			return;
		l.timer = this.env.setTimer(() => {
			(l.timer = null), this.kick(d);
		}, h);
	}
}
var j = r`
	.retry {
		background: none;
		border: 1px solid var(--klh-danger);
		color: var(--klh-danger-ink);
		border-radius: 2px;
		font: inherit;
		font-size: 10px;
		padding: 1px 8px;
		cursor: pointer;
		margin-left: 8px;
	}
`;
class N extends n {
	static properties = {
		text: { type: String },
		feed: { type: String, reflect: !0 },
	};
	static styles = [
		r`
			:host([hidden]) {
				display: none;
			}
		`,
		j,
	];
	constructor() {
		super();
		(this.text = ""), (this.feed = "");
	}
	willUpdate() {
		this.hidden = !this.text;
	}
	retry() {
		this.dispatchEvent(this.feed ? new p(this.feed) : new _(this.id));
	}
	render() {
		return e`<span role="alert">${this.text}</span
			><button class="retry" type="button" @click=${this.retry}>
				retry
			</button>`;
	}
}
if (!customElements.get("klh-err-banner"))
	customElements.define("klh-err-banner", N);
class P extends n {
	static properties = { verdict: { attribute: !1 } };
	static styles = [
		r`
		:host {
			font-size: 11px;
			color: var(--klh-dim);
			white-space: nowrap;
		}
		.dot {
			display: inline-block;
			width: 8px;
			height: 8px;
			border-radius: 50%;
			margin-right: 5px;
			vertical-align: 0;
		}
		.dot.live {
			background: var(--klh-ok);
		}
		.dot.stale {
			background: var(--klh-accent);
		}
		.dot.err {
			background: var(--klh-danger);
		}
	`,
		j,
	];
	constructor() {
		super();
		this.verdict = null;
	}
	retry() {
		this.dispatchEvent(new p("data"));
	}
	updated() {
		this.title = this.verdict ? this.verdict.title : "";
	}
	render() {
		const d = this.verdict;
		if (!d) return e`<span class="dot stale"></span>connecting`;
		return e`<span class="dot ${d.cls}"></span>${d.txt}
			<span class="dim">| ${d.dec}</span>${
				d.retry
					? e` <button class="retry" type="button" @click=${this.retry}>
							retry
						</button>`
					: t
			}`;
	}
}
if (!customElements.get("klh-conn-banner"))
	customElements.define("klh-conn-banner", P);
function J() {
	return (globalThis.klhFeeds ??= new O().share()), globalThis.klhFeeds;
}
class B extends n {
	static styles = r`
		:host {
			display: contents;
		}
	`;
	store = J();
	unsubs = [];
	ticker = null;
	constructor() {
		super();
		for (const [d, l] of Object.entries(R)) this.store.validate(d, I(l));
		this.addEventListener(p.eventName, (d) => {
			d.stopPropagation(), this.store.kick(d.feed, !0);
		});
	}
	connectedCallback() {
		super.connectedCallback();
		const d = () => this.pushConn();
		(this.unsubs = ["data", "dec"].map((l) => this.store.subscribe(l, d))),
			(this.ticker = setInterval(() => {
				if (!document.hidden) d();
			}, 1000)),
			d();
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		for (const d of this.unsubs) d();
		if (((this.unsubs = []), this.ticker !== null)) clearInterval(this.ticker);
		this.ticker = null;
	}
	pushConn() {
		const d = this.store.get("data"),
			l = this.store.get("dec"),
			u = this.querySelectorAll("klh-conn-banner");
		if (!u.length) return;
		const h = d?.data?.observation,
			f = L(
				{
					observation: h,
					dataOkAt: d?.okAt ?? 0,
					dataErr: U(d),
					decOkAt: l?.okAt ?? 0,
					decErr: U(l),
					decLoaded: l?.loaded ?? !1,
					now: Date.now(),
				},
				y,
				(b) => D(b ?? Number.NaN),
			);
		for (const b of u) b.verdict = f;
	}
	render() {
		return e`<slot></slot>`;
	}
}
var U = (d) => (d ? d.err : null);
if (!customElements.get("klh-board-mediator"))
	customElements.define("klh-board-mediator", B);
export { B as KlhBoardMediator, J as boardFeeds };
