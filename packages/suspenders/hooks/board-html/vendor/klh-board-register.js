import {
	a,
	c,
	g,
	h,
	i,
	m,
	o,
	P,
	S,
	s,
	T,
	u,
	y,
} from "./lit-0a9982d0e15be9ce.js";
import { d, e, n, r, t, x } from "./lit-9ab93f5debb235da.js";
import { A, f, I, L, M } from "./lit-bbcd2c46a367dbcd.js";
var zt = new Set(),
	U = (l, p) => {
		if (customElements.get(l))
			throw Error(
				`defineElement: <${l}> is already defined — ONE register point per workspace`,
			);
		zt.add(l), customElements.define(l, p);
	};
function pt(l) {
	if (l === "CLAIMED" || l === "RUNNING") return "working";
	if (l === "WAITING" || l === "BLOCKED" || l === "PAUSED") return "blocked";
	if (l === "SHATTERED") return "split";
	if (l === "FAILED") return "failed";
	if (l === "DONE") return "done";
	if (l === "CANCELLED") return "cancelled";
	return "ready";
}
function dt(l) {
	if (l === "SHATTERED") return "split";
	return l.toLowerCase();
}
function ut(l) {
	return /^\s*BLOCKED\b/i.test(l) ? "blocked" : "warning";
}
function ht(l) {
	return l.replace(/^\s*BLOCKED\b[\s:]+/i, "") || l;
}
var K = o(u(s())),
	D = o(u(c())),
	Ct = i({ value: s(), label: s(), badge: o(s()), reasoningEffort: o(T()) }),
	Ht = i({ tokens: D, wallMs: D, tokPerMin: D, cachePct: D }),
	Ot = i({
		mode: S(["spend", "attempt"]),
		windowStartMs: D,
		windowEndMs: D,
		binMs: D,
		elapsedMs: D,
		scaleMs: D,
	}),
	ft = i({
		id: s(),
		project: K,
		title: K,
		state: s(),
		ageS: D,
		contextLines: o(a(s())),
		parentRef: K,
		model: K,
		host: K,
		warn: K,
		metrics: o(Ht),
		activity: o(Ot),
		nested: o(T()),
		preferColor: K,
		executors: o(a(Ct)),
		executorPick: K,
		effortOptions: o(a(s())),
		effortPick: K,
		pendingAction: K,
	});
function mt(l) {
	if (l == null) return "—";
	if (l >= 1e6) return `${(l / 1e6).toFixed(1)}M`;
	if (l >= 1000) return `${Math.round(l / 1000)}k`;
	return String(Math.round(l));
}
function gt(l) {
	if (l == null) return "—";
	if (l < 60000) return `${Math.round(l / 1000)}s`;
	const p = Math.round(l / 60000);
	if (p >= 60)
		return `${Math.floor(p / 60)}h${String(p % 60).padStart(2, "0")}m`;
	return `${p}m`;
}
function bt(l) {
	if (l == null) return "—";
	if (l >= 1e6) return `${(l / 1e6).toFixed(1)}M`;
	if (l >= 1000) return `${(l / 1000).toFixed(1)}k`;
	return String(Math.round(l));
}
function vt(l) {
	if (l == null) return "—";
	return `${Math.round(l)}%`;
}
var kt = r`${d(`@charset "UTF-8";
/* tone → color, self-contained: the page maps data-tone on .kcard/
   .kcol only, so the card owns its own --state-color token map. */
:host([data-tone=ready]) {
  --state-color: var(--work-ready);
}

:host([data-tone=working]) {
  --state-color: var(--work-working);
}

:host([data-tone=blocked]) {
  --state-color: var(--work-blocked);
}

:host([data-tone=failed]) {
  --state-color: var(--work-failed);
}

:host([data-tone=done]) {
  --state-color: var(--work-done);
}

:host([data-tone=split]) {
  --state-color: var(--work-split);
}

:host([data-tone=cancelled]) {
  --state-color: var(--work-cancelled);
}

:host {
  /* the host IS the card surface: configurable semantic perimeter
     (—prefer) independent of --state-color; nested children dashed.
     position:relative anchors the nested elbow (absolute, hung into
     the indent gutter) to THIS card, not an unrelated ancestor. */
  display: flex;
  flex-direction: column;
  position: relative;
  border: 1px solid var(--prefer, var(--state-color, var(--klh-edge-soft)));
  border-radius: 3px;
  background: var(--klh-wash);
  font: var(--klh-text-md, var(--klh-typo-size-m, 12px))/1.45 var(--klh-font-sans, var(--klh-typo-sans-stack));
  color: var(--klh-ink);
  min-width: 0;
}

:host([data-nested]) {
  border-style: dashed;
}

:host([data-nested]) .elbow {
  position: absolute;
  left: -13px;
  top: 13px;
  color: var(--prefer, var(--klh-edge-strong));
  font: var(--klh-typo-size-s, 11px) var(--klh-font-mono, var(--klh-typo-mono-stack));
}

.wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 9px 0 0;
}

.pad {
  padding: 0 12px;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  /* #101242: the readable 12px band — 10px stays axis/units only */
  font-size: var(--klh-typo-size-m, 12px);
  letter-spacing: var(--klh-typo-track-label, 0.09em);
  text-transform: uppercase;
  color: var(--state-color, var(--klh-dim));
}

.sq {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 1px;
  background: var(--state-color, var(--klh-dim));
  align-self: center;
}

.stw {
  font-weight: 600;
}

.age {
  margin-left: auto;
  color: var(--klh-dim);
  text-transform: none;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tid {
  margin: 4px 0 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--klh-ink);
  /* #101242: prominent own-line mono ID — 20px readable at 380 too */
  font: 600 var(--klh-typo-size-3xl, 20px) var(--klh-font-mono, var(--klh-typo-mono-stack));
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.tid:hover {
  text-decoration: underline;
}

.title {
  margin: 2px 0 0;
  font-weight: 650;
  font-size: var(--klh-typo-size-2xl, 16px);
  line-height: 1.35;
  /* long text truncates visually, full text stays accessible on hover */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.ctx {
  margin: 3px 0 0;
  color: var(--klh-dim);
  font: var(--klh-typo-size-m, 12px) var(--klh-font-mono, var(--klh-typo-mono-stack));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rule {
  border: 0;
  border-top: 1px solid var(--klh-edge-faint);
  margin: 7px 0 0;
}

.cols {
  display: flex;
  gap: 0;
  margin-top: 5px;
  /* model/host values sit in the spec's 12–13px band (#100618) */
  font: var(--klh-typo-size-m, 12px) var(--klh-font-mono, var(--klh-typo-mono-stack));
}

.col {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 10px;
}

.col:first-child {
  padding-left: 0;
}

.col:last-child {
  border-left: 1px solid var(--klh-edge-faint);
}

.col b {
  font-weight: 600;
  color: var(--klh-ink-2);
}

.lab {
  display: block;
  margin-top: 2px;
  font-size: var(--klh-typo-size-2xs, 10px);
  letter-spacing: var(--klh-typo-track-label, 0.09em);
  text-transform: uppercase;
  color: var(--klh-dim);
}

.warn {
  margin: 7px 0 0;
  border-left: 2px solid var(--work-failed, var(--klh-danger));
  background: var(--klh-danger-wash);
  padding: 4px 8px;
  font-size: var(--klh-typo-size-m, 12px);
  color: var(--klh-danger-ink);
}

.warn .wl {
  font-weight: 700;
  text-transform: uppercase;
  font-size: var(--klh-typo-size-2xs, 10px);
  letter-spacing: var(--klh-typo-track-label, 0.09em);
  margin-right: 5px;
}

.warn .wt {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metrics {
  display: flex;
  margin-top: 8px;
}

.m {
  flex: 1 1 0;
  min-width: 0;
  padding: 0 10px;
  /* #103117: reference 09 card left-aligns every metric cell */
  text-align: left;
}

.m:first-child {
  padding-left: 0;
}

.m + .m {
  border-left: 1px solid var(--klh-edge-faint);
}

.mv {
  font: 600 var(--klh-typo-size-2xl, 16px) var(--klh-font-mono, var(--klh-typo-mono-stack));
  font-variant-numeric: tabular-nums;
  color: var(--klh-ink);
}

.ml {
  display: block;
  margin-top: 1px;
  font-size: var(--klh-typo-size-2xs, 10px);
  letter-spacing: var(--klh-typo-track-label, 0.09em);
  text-transform: uppercase;
  color: var(--klh-dim);
  white-space: nowrap;
}

.details {
  display: block;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--klh-dim);
}

/* the activity slot sits flush at the card bottom: the strip's own
   1px duration rail + ~13px axis area ride the slot, no extra padding. */
.activity {
  display: block;
  margin-top: 8px;
  padding: 0;
}

footer {
  /* neutral segmented rail, full-width flush bottom — zero margin so
     the axis area of the slotted strip abuts it exactly (#100618) */
  display: flex;
  align-items: stretch;
  width: 100%;
  margin: 0;
  border-top: 1px solid var(--klh-edge-faint);
  background: var(--klh-surface);
  border-radius: 0 0 2px 2px;
}

footer:empty {
  display: none;
}

.spacer {
  /* the lone Prompt/Report sits rightmost; the rail's empty left
     half stays bare surface with the segment dividers at the right */
  flex: 1 1 auto;
}

.seg.tail {
  /* bounded (not equal-share): the rightmost affordance keeps its
     own width, divider at its left edge, rail bare before it */
  flex: 0 1 auto;
  padding-inline: 14px;
  border-left: 1px solid var(--klh-edge-faint);
}

.seg {
  flex: 1 1 0;
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 4px 8px;
  border: 0;
  background: none;
  color: var(--klh-ink-2);
  font: var(--klh-typo-size-s, 11px) var(--klh-font-sans, var(--klh-typo-sans-stack));
  cursor: pointer;
  white-space: nowrap;
}

.seg + .seg {
  border-left: 1px solid var(--klh-edge-faint);
}

.seg:hover {
  background: var(--klh-surface-hi);
  color: var(--klh-ink);
}

.seg.retry {
  color: var(--klh-danger-ink);
}

.seg.recover {
  font-weight: 600;
}

.seg.prompt {
  color: var(--klh-accent);
}

.seg select {
  flex: 1 1 0;
  min-width: 0;
  height: 32px;
  background: var(--klh-field);
  color: var(--klh-ink);
  border: 1px solid var(--klh-edge-mid);
  border-radius: 2px;
  font: var(--klh-typo-size-xs, 10.5px) var(--klh-font-mono, var(--klh-typo-mono-stack));
  padding: 0 4px;
}

footer button.seg:focus-visible,
.tid:focus-visible,
.seg select:focus-visible {
  outline: 2px solid var(--klh-accent);
  outline-offset: -2px;
}`)}`;
class J extends h {
	static eventName = "task-card-action-requested";
	action;
	id;
	project;
	executor;
	effort;
	constructor(l, p, v, b) {
		super(J.eventName);
		(this.action = l),
			(this.id = p),
			(this.project = v),
			(this.executor = b?.executor),
			(this.effort = b?.effort);
	}
}
class Q extends h {
	static eventName = "task-card-draft-changed";
	id;
	project;
	executor;
	effort;
	constructor(l, p, v) {
		super(Q.eventName);
		(this.id = l),
			(this.project = p),
			(this.executor = v?.executor),
			(this.effort = v?.effort);
	}
}
class tt extends h {
	static eventName = "task-card-open-requested";
	id;
	project;
	constructor(l, p) {
		super(tt.eventName);
		(this.id = l), (this.project = p);
	}
}
var rt = "—";
class st extends n {
	static properties = { card: { attribute: !1 } };
	static styles = kt;
	constructor() {
		super();
		this.card = { id: "", state: "READY" };
	}
	draftId;
	draftExecutor;
	draftEffort;
	tone() {
		return pt(this.card.state);
	}
	open() {
		this.dispatchEvent(new tt(this.card.id, this.card.project ?? null));
	}
	act(l, p) {
		this.dispatchEvent(new J(l, this.card.id, this.card.project ?? null, p));
	}
	draft(l) {
		this.dispatchEvent(new Q(this.card.id, this.card.project ?? null, l));
	}
	statusWord() {
		return dt(this.card.state);
	}
	render() {
		const l = this.card,
			p = this.tone(),
			v = l.metrics ?? null,
			b = l.ageS == null ? rt : P(l.ageS),
			k = l.ageS == null ? "age unknown" : `open ${y(l.ageS)}`,
			w = l.executors ?? [],
			_ = l.executorPick ?? "",
			E = l.effortOptions ?? [],
			R = l.effortPick ?? "",
			C = l.pendingAction ?? "",
			O = (z, Z) => (C === z ? `${Z}…` : Z),
			N = (z) => C === z,
			B = (z) => (C === z ? "true" : "false");
		return e`
			${l.nested ? e`<span class="elbow" aria-hidden="true">↳</span>` : t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${p}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${k}>${b}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${l.id}
				</button>
				${l.title ? e`<div class="title" title=${l.title}>${l.title}</div>` : t}
				${(l.contextLines ?? []).map((z) => e`<div class="ctx" title=${z}>${z}</div>`)}
				${
					l.parentRef
						? e`<div class="ctx" title=${`parent ${l.parentRef}`}
							>↳ ${l.parentRef}</div
						>`
						: t
				}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${l.model ?? ""}>${l.model ?? rt}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${l.host ?? ""}>${l.host ?? rt}</b>
					</div>
				</div>
				<hr class="rule" />
				${
					l.warn
						? e`<div class="warn" role="note">
							<span class="wl">${ut(l.warn)}</span>
							<span class="wt" title=${l.warn}>${ht(l.warn)}</span>
						</div>`
						: t
				}
				<div class="metrics">
					<div class="m">
						<span class="mv">${mt(v?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${gt(v?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${bt(v?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${vt(v?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details" name="details"></slot>
				</div>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${
					p === "failed"
						? e`<button
							class="seg retry"
							type="button"
							?disabled=${N("retry")}
							aria-busy=${B("retry")}
							@click=${() => this.act("retry")}
						>
							${O("retry", "Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${N("recover")}
							aria-busy=${B("recover")}
							@click=${() => this.act("recover")}
						>
							${O("recover", "Recover → Ready")}
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${() => this.act("prompt")}
						>
							Prompt ↗
						</button>`
						: t
				}
				${
					p === "ready" && w.length
						? e`<select
							class="seg"
							aria-label=${`executor for ${l.id}`}
							@change=${(z) => {
								(this.draftExecutor = z.target.value),
									this.draft({ executor: this.draftExecutor });
							}}
						>
							${w.map(
								(z) => e`<option
									value=${z.value}
									?selected=${z.value === (this.draftExecutor ?? _)}
								>
									${z.badge ?? ""}${z.label}
								</option>`,
							)}
						</select>
						${
							E.length
								? e`<select
									class="seg"
									aria-label=${`reasoning effort for ${l.id}`}
									@change=${(z) => {
										(this.draftEffort = z.target.value),
											this.draft({ effort: this.draftEffort });
									}}
								>
									${E.map(
										(z) => e`<option
											value=${z}
											?selected=${z === (this.draftEffort ?? R)}
										>
											${z}
										</option>`,
									)}
								</select>`
								: t
						}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${N("start")}
							aria-busy=${B("start")}
							@click=${() => this.act("start", { executor: this.draftExecutor ?? _, effort: this.draftEffort ?? R })}
						>
							${O("start", "Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`
						: t
				}
				${p === "ready" && !w.length ? e`<span class="spacer"></span>${this.promptSeg()}` : t}
				${
					p === "working" && !w.length
						? e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${N("release")}
								aria-busy=${B("release")}
								@click=${() => this.act("release")}
							>
								${O("release", "Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`
						: t
				}
				${
					p === "working" && w.length
						? e`<select
							class="seg"
							aria-label=${`reassign executor for ${l.id}`}
							@change=${(z) => {
								(this.draftExecutor = z.target.value),
									this.draft({ executor: this.draftExecutor });
							}}
						>
							${w.map(
								(z) => e`<option
									value=${z.value}
									?selected=${z.value === (this.draftExecutor ?? _)}
								>
									${z.badge ?? ""}${z.label}
								</option>`,
							)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							?disabled=${N("reassign")}
							aria-busy=${B("reassign")}
							@click=${() => this.act("reassign", { executor: this.draftExecutor ?? _ })}
						>
							${O("reassign", "Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${N("release")}
							aria-busy=${B("release")}
							@click=${() => this.act("release")}
						>
							${O("release", "Release ⏏")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`
						: t
				}
				${
					p === "done"
						? e`<span class="spacer"></span>
						<button
							class="seg tail report"
							type="button"
							title="open this item's report view"
							@click=${() => this.act("report")}
						>
							Report ▸
						</button>
						${this.promptSeg()}`
						: t
				}
				${p !== "failed" && p !== "ready" && p !== "working" && p !== "done" ? e`<span class="spacer"></span>${this.promptSeg()}` : t}
			</footer>
		`;
	}
	promptSeg() {
		return e`<button
			class="seg tail prompt"
			type="button"
			@click=${() => this.act("prompt")}
		>
			Prompt ↗
		</button>`;
	}
	willUpdate() {
		if (
			(this.toggleAttribute("data-nested", !!this.card.nested),
			this.draftId !== this.card.id)
		)
			(this.draftId = this.card.id),
				(this.draftExecutor = void 0),
				(this.draftEffort = void 0);
		if ((this.setAttribute("data-tone", this.tone()), this.card.preferColor))
			this.style.setProperty("--prefer", this.card.preferColor);
		else this.style.removeProperty("--prefer");
	}
}
var it = 1.5;
function It(l, p, v, b = 180000) {
	const k = Array.from({ length: v }, () => null);
	for (const w of l) {
		let _ = Math.floor((w[0] - p) / b);
		if (_ > v - 1) _ = v - 1;
		if (_ < 0) continue;
		let E = k[_];
		if (E == null) (E = { fresh: 0, cached: 0, out: 0 }), (k[_] = E);
		(E.fresh += w[1]), (E.cached += w[2]), (E.out += w[3]);
	}
	return k;
}
function Pt(l, p, v = 6, b = 180000) {
	const k = Math.max(1, Math.floor(p / v)),
		w = l;
	return { count: k, slotMs: b, start: w - k * b, end: w };
}
var Lt = {
	bins: [],
	firstTs: null,
	windowStart: null,
	windowEnd: null,
	count: 0,
	slotMs: 180000,
	startClipped: !1,
	hasData: !1,
};
function xt(l, p, v) {
	if (!l.length) return Lt;
	let { POSITIVE_INFINITY: b, NEGATIVE_INFINITY: k } = Number;
	for (const C of l) {
		if (C[0] < b) b = C[0];
		if (C[0] > k) k = C[0];
	}
	const w = Pt(k, p),
		_ = v ?? Math.max(w.start, b),
		E = Math.ceil((k - _) / w.slotMs) + 1,
		R = Math.max(1, Math.min(w.count, E));
	return {
		bins: It(l, _, R),
		firstTs: b,
		windowStart: _,
		windowEnd: _ + R * w.slotMs,
		count: R,
		slotMs: w.slotMs,
		startClipped: _ > b,
		hasData: !0,
	};
}
function Y(l) {
	const p = new Date(l),
		v = (b) => String(b).padStart(2, "0");
	return `${v(p.getHours())}:${v(p.getMinutes())}`;
}
function at(l, p, v = 86400000) {
	const b = p / 2;
	if (l === null || l === void 0)
		return { visible: !1, center: b, half: 0, start: b, end: b, saturated: !1 };
	if (!Number.isFinite(l) || l <= 0)
		return { visible: !1, center: b, half: 0, start: b, end: b, saturated: !1 };
	const k = Math.min(p / 2, (l / v) * (p / 2));
	return {
		visible: !0,
		center: b,
		half: k,
		start: b - k,
		end: b + k,
		saturated: l >= v,
	};
}
function q(l) {
	if (!Number.isFinite(l) || l <= 0) return "0m";
	const p = Math.round(l / 60000);
	if (p < 60) return `${p}m`;
	return `${Math.floor(p / 60)}h ${String(p % 60).padStart(2, "0")}m`;
}
function et(l = 86400000) {
	return `${l / 3600000}h`;
}
function j(l, p, v, b) {
	const k = Math.max(1, v - p),
		w = ((l - p) / k) * b;
	return Math.max(0, Math.min(b, w));
}
function G(l) {
	const p = [];
	for (const b of l.attempt.segments) {
		if (b.end <= b.start) continue;
		p.push({ kind: b.kind, start: b.start, end: b.end });
	}
	const v = [];
	for (const b of l.milestones) {
		if (b.ts < l.windowStart || b.ts > l.windowEnd) continue;
		v.push({
			kind: "milestone",
			start: b.ts,
			end: b.ts,
			commit: b.commit,
			stage: b.stage,
		});
	}
	return { segs: p, milestones: v };
}
function yt(l, p, v, b, k) {
	for (const w of l.milestones) {
		const _ = j(w.start, v, b, k);
		if (Math.abs(p - _) <= 6) return w;
	}
	for (const w of l.segs) {
		const _ = j(w.start, v, b, k),
			E = j(w.end, v, b, k);
		if (p >= _ && p <= Math.max(E, _ + 1)) return w;
	}
	return null;
}
function X(l, p, v, b) {
	if (l.kind === "milestone")
		return [
			`artifact · ${l.stage ?? ""}`,
			v(l.start),
			`commit ${l.commit ?? ""}`,
		].join(`
`);
	const k = [`${l.kind} · ${b(l.end - l.start)}`, v(l.start, l.end)];
	if (l.kind === "firstbyte")
		k.push("first attributed ledger request — not network latency");
	if (l.kind === "tool") k.push("request-row minutes — not tool-call duration");
	if (l.kind === "unknown") k.push("no fact covers this gap");
	return (
		k.push(`attempt ${p.attempt.index} · ${p.attempt.sid}`),
		k.join(`
`)
	);
}
var ot = 13,
	lt = 14,
	F = 5;
function Tt(l) {
	const p = l.attempt.claimEnd ?? l.windowEnd,
		v = Math.min(p, l.windowEnd) - l.attempt.claimStart;
	return v > 0 ? v : null;
}
function nt(l, p) {
	return p === void 0
		? f(l)
		: L(l, p).join(`
`);
}
function Nt(l, p) {
	const { segs: v, milestones: b } = G(l),
		k = [];
	for (const w of v) {
		const _ = j(w.start, l.windowStart, l.windowEnd, p),
			E = Math.max(_ + 1, j(w.end, l.windowStart, l.windowEnd, p));
		k.push(x`<rect
				class="at-${w.kind}"
				x=${_.toFixed(1)}
				y=${ot}
				width=${(E - _).toFixed(1)}
				height=${lt}
				rx="2"
			/>`);
	}
	for (const w of b) {
		const _ = j(w.start, l.windowStart, l.windowEnd, p),
			E = ot + lt / 2;
		k.push(x`<path
				class="at-ms"
				d="M ${_.toFixed(1)},${(E - F).toFixed(1)} l ${F},${F} l -${F},${F} l -${F},-${F} Z"
			/>`);
	}
	return e`${k}`;
}
var wt = (l) => ({ kind: l.kind, start: l.start });
function _t(l) {
	return {
		hover: (b, k) => {
			const w = b.currentTarget;
			if (!k || !w) {
				l.hide();
				return;
			}
			const _ = w.getBoundingClientRect();
			if (_.width === 0) return;
			const E = yt(
				G(k),
				b.clientX - _.left,
				k.windowStart,
				k.windowEnd,
				_.width,
			);
			if (!E) {
				l.hide();
				return;
			}
			l.setTip(X(E, k, nt, q), -1, wt(E)), l.placeTip(b.clientX, b.clientY);
		},
		hide: () => l.hide(),
		keydown: (b, k) => {
			if (b.key === "Escape") {
				l.hide(), b.target.blur();
				return;
			}
			if (b.key !== "ArrowLeft" && b.key !== "ArrowRight") return;
			b.preventDefault();
			const w = l.slot(),
				{ milestones: _, segs: E } = G(k),
				R = [..._, ...E];
			if (!R.length) return;
			const C = b.key === "ArrowLeft" ? -1 : 1,
				O = Math.max(0, Math.min(R.length - 1, w + C)),
				N = R[O];
			if (!N) return;
			l.setTip(X(N, k, nt, q), O, wt(N));
			const B = b.currentTarget;
			if (B) {
				const z = B.getBoundingClientRect(),
					Z = j(N.start, k.windowStart, k.windowEnd, z.width);
				l.placeTip(z.left + Z, z.top + 8);
			}
		},
		slot: () => l.slot(),
	};
}
function $t(l, p) {
	return e`<div class="axis">
		<span>${Y(l.windowStart)}</span>
		<span>${p} · ${l.binMs / 60000}m/bin</span>
		<span>${Y(l.windowEnd)}</span>
	</div>`;
}
function St(l, p, v) {
	return e`<svg
		class="plot"
		viewBox="0 0 ${p} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${l.binMs / 60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(b) => v.hover(b, l)}
		@pointerleave=${() => v.hide()}
		@keydown=${(b) => v.keydown(b, l)}
	>
		${Nt(l, p)}
	</svg>`;
}
var Et = r`
	.plot rect.at-queue {
		fill: var(--klh-chart-axis, #898781);
	}
	.plot rect.at-firstbyte {
		fill: var(--klh-accent, #d8900f);
	}
	.plot rect.at-tool {
		fill: var(--klh-ok, #5c7a35);
	}
	.plot rect.at-pause {
		fill: var(--klh-warn, #b8860b);
	}
	.plot rect.at-unknown {
		fill: var(--klh-edge, rgba(128, 128, 128, 0.35));
	}
	.plot path.at-ms {
		fill: var(--klh-ink, #e8e6e1);
		stroke: var(--klh-edge, rgba(255, 255, 255, 0.4));
		stroke-width: 0.5;
	}
	.attempt-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 40px;
		font: 400 11px/1.5 ui-monospace, SFMono-Regular, monospace;
		color: var(--klh-chart-axis, #898781);
	}
`;
var Mt = r`${d(`@charset "UTF-8";
:host {
  display: block;
  font: 11px/1.5 ui-sans-serif, system-ui;
}

.plot {
  display: block;
  width: 100%;
  height: 40px;
}

.plot:focus-visible {
  outline: 2px solid var(--klh-accent, #d8900f);
  outline-offset: 1px;
}

/* W2267.4.2.2 spectral treatment (owner-approved 09 spec): thin
   crisp real-bin marks, green/teal spectrum, low-opacity upward
   fade — semantic chart tokens, honest bins only. */
/* W2267.4.2.2 spectral treatment (owner-approved 09 spec): thin crisp
   real-bin strokes, teal fresh over green cached, fading upward via
   ONE shared linearGradient per role (objectBoundingBox: each bar
   fades along its own height) — semantic chart tokens, honest bins
   only, no fake upsampling. Identical defs across strips make the
   duplicate-id resolution benign (first match wins, all equal). */
.plot rect.spark-fresh {
  fill: url(#klh-spec-fresh);
}

.plot rect.spark-cached {
  fill: url(#klh-spec-cached);
}

.axis {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 0;
  font: 400 10px/12px ui-monospace, SFMono-Regular, monospace;
  color: var(--klh-chart-axis, #898781);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
}

/* the duration hairline: exactly 1 CSS px, zero own margin/padding,
   flush under the plot's bottom edge (owner tight-rail contract). */
.hairline {
  display: block;
  height: 1px;
  margin: 0;
  padding: 0;
  background: transparent;
  position: relative;
}

.hairline .span {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--klh-accent, #d8900f);
}

.hairline.saturated .span {
  background: var(--klh-danger, #af2f12);
}

/* B2 (W2514): the hairline carries exact duration text — keyboard
   focus must be visible, same ring as the plot. */
.hairline:focus-visible {
  outline: 2px solid var(--klh-accent, #d8900f);
  outline-offset: 1px;
}

.tip {
  position: fixed;
  z-index: 1000;
  max-width: 260px;
  padding: 6px 8px;
  border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  background: var(--klh-surface, #1c1b19);
  color: var(--klh-ink, #e8e6e1);
  font: 11px/1.5 ui-monospace, SFMono-Regular, monospace;
  white-space: pre-line;
  pointer-events: none;
}`)}`;
class ct extends n {
	static properties = {
		points: { attribute: !1 },
		wallMs: { attribute: !1 },
		attempt: { attribute: !1 },
		mode: { attribute: !1 },
		_width: { state: !0 },
		_tip: { state: !0 },
		_slot: { state: !0 },
	};
	static styles = [Mt, Et];
	constructor() {
		super();
		(this.points = []),
			(this.wallMs = null),
			(this.attempt = null),
			(this.mode = "spend"),
			(this._width = 0),
			(this._tip = null),
			(this._slot = -1),
			(this._tipRef = null),
			(this._tipTs = null);
	}
	_ro = null;
	connectedCallback() {
		if ((super.connectedCallback(), typeof ResizeObserver < "u"))
			this._ro = new ResizeObserver(() => {
				const p = this._plotEl()?.clientWidth ?? 0;
				if (p !== this._width) (this._width = p), this.requestUpdate();
			});
		const l = this._plotEl();
		if (l && this._ro) this._ro.observe(l);
	}
	disconnectedCallback() {
		this._ro?.disconnect(), (this._ro = null), super.disconnectedCallback();
	}
	firstUpdated() {
		const l = this._plotEl();
		if (l && this._ro) (this._width = l.clientWidth), this._ro.observe(l);
	}
	updated() {
		const l = this._plotEl();
		if (l && this._ro) this._ro.observe(l);
	}
	update(l) {
		if ((super.update(l), !l.has("points") && !l.has("attempt"))) return;
		if (this.mode === "attempt") {
			if (!this.attempt || !this._tipRef) {
				this._hideTip();
				return;
			}
			const { milestones: b, segs: k } = G(this.attempt),
				w = [...b, ...k],
				_ = this._tipRef,
				E = w.findIndex((R) => R.kind === _.kind && R.start === _.start);
			if (E < 0) {
				this._hideTip();
				return;
			}
			(this._tip = X(w[E], this.attempt, nt, q)), (this._slot = E);
			return;
		}
		const p = this._spec;
		if (!p.hasData || this._tipTs === null) {
			if (!p.hasData) this._hideTip();
			return;
		}
		const v = Math.floor((this._tipTs - (p.windowStart ?? 0)) / p.slotMs);
		if (v < 0 || v >= p.count) {
			this._hideTip();
			return;
		}
		(this._slot = v), (this._tip = this._tipText(p, v));
	}
	_plotEl() {
		return this.renderRoot.querySelector("svg.plot");
	}
	get _spec() {
		return xt(this.points, this._width || 240);
	}
	_hover = (l) => {
		const p = this._plotEl(),
			v = this._spec;
		if (!p || !v.hasData) {
			this._hideTip();
			return;
		}
		const b = p.getBoundingClientRect();
		if (b.width === 0) return;
		const k = Math.max(
			0,
			Math.min(
				v.count - 1,
				Math.floor(((l.clientX - b.left) / b.width) * v.count),
			),
		);
		(this._slot = k),
			(this._tip = this._tipText(v, k)),
			(this._tipTs = (v.windowStart ?? 0) + k * v.slotMs),
			this.requestUpdate(),
			this._placeTip(l.clientX, l.clientY);
	};
	_hide = () => {
		this._hideTip(), this.requestUpdate();
	};
	_keyNav = (l) => {
		const p = this._spec;
		if (l.key === "Escape") {
			this._hide();
			return;
		}
		if (l.key !== "ArrowLeft" && l.key !== "ArrowRight") return;
		l.preventDefault();
		const v = l.key === "ArrowLeft" ? -1 : 1,
			b = Math.max(0, Math.min(p.count - 1, this._slot + v));
		(this._slot = b),
			(this._tip = this._tipText(p, b)),
			(this._tipTs = (p.windowStart ?? 0) + b * p.slotMs),
			this.requestUpdate();
		const k = this._plotEl();
		if (k) {
			const w = k.getBoundingClientRect();
			this._placeTip(w.left + ((b + 0.5) / p.count) * w.width, w.top + 8);
		}
	};
	_hideTip() {
		(this._tip = null),
			(this._slot = -1),
			(this._tipRef = null),
			(this._tipTs = null);
	}
	_tipText(l, p) {
		const v = l.bins[p],
			b = (l.windowStart ?? 0) + p * l.slotMs,
			k = [f(b), `${I(b, A(b) !== M(b))} · ${l.slotMs / 60000}-minute bin`];
		if (v)
			k.push(`Fresh input ${v.fresh.toLocaleString("en-US")}`),
				k.push(`Cached input ${v.cached.toLocaleString("en-US")}`),
				k.push(`Output ${v.out.toLocaleString("en-US")}`);
		else k.push("no requests in this bin");
		return k.join(`
`);
	}
	_barsSvg(l) {
		let v = (this._width || 240) / l.count,
			b = 0;
		for (const w of l.bins) if (w) b = Math.max(b, w.fresh + w.cached);
		const k = [];
		if (b > 0)
			for (let w = 0; w < l.count; w++) {
				const _ = l.bins[w];
				if (!_) continue;
				const E = w * v + (v - it) / 2;
				k.push(this._barRects(_, E, b));
			}
		if (!k.length) return e``;
		return x`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${k}`;
	}
	_barRects(l, p, v) {
		let k = [],
			w = 0,
			_ = [
				[l.fresh, "spark-fresh"],
				[l.cached, "spark-cached"],
			];
		for (const [E, R] of _) {
			if (E <= 0) continue;
			const C = Math.max(0.5, (E / v) * 38);
			k.push(x`<rect
					class=${R}
					x=${p.toFixed(1)}
					y=${Math.max(1, 39 - w - C).toFixed(1)}
					width=${it}
					height=${C.toFixed(1)}
				/>`),
				(w += C);
		}
		return e`${k}`;
	}
	_hairlineHtml() {
		const l = this._width || 240,
			p = at(this._hairWallMs(), l);
		if (!p.visible) return null;
		return e`<div
			class="hairline${p.saturated ? " saturated" : ""}"
			role="img"
			aria-label="elapsed ${q(this._hairWallMs() ?? 0)} of ${et()} scale${p.saturated ? " — saturated at full width" : ""}"
			title="elapsed ${q(this._hairWallMs() ?? 0)} of ${et()} scale${p.saturated ? " — saturated at full width" : ""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${p.start.toFixed(1)}px;width:${(p.end - p.start).toFixed(1)}px"
			></span>
		</div>`;
	}
	_hairFocus = () => {
		const l = this._width || 240,
			p = at(this._hairWallMs(), l);
		if (!p.visible) return;
		(this._slot = -1),
			(this._tipRef = null),
			(this._tipTs = null),
			(this._tip = `elapsed ${q(this._hairWallMs() ?? 0)} of ${et()} scale${p.saturated ? " — saturated at full width" : ""}`),
			this.requestUpdate();
		const v = this._plotEl()?.getBoundingClientRect();
		if (v)
			this._placeTip(
				v.left + (p.center / Math.max(1, l)) * v.width,
				v.bottom + 2,
			);
	};
	_hairKey = (l) => {
		if (l.key === "Escape")
			this._hideTip(), this.requestUpdate(), l.target.blur();
	};
	_axisHtml(l) {
		const p = this._tzLabel();
		return e`<div class="axis">
			<span>${l.hasData ? Y(l.windowStart ?? 0) : ""}</span>
			<span
				>${l.hasData ? `${p} · ${l.slotMs / 60000}m/bin` : "no activity"}</span
			>
			<span>${l.hasData ? Y(l.windowEnd ?? 0) : ""}</span>
		</div>`;
	}
	_tzLabel() {
		const l = -new Date().getTimezoneOffset(),
			p = Math.abs(l);
		return `UTC${l >= 0 ? "+" : "-"}${String(Math.floor(p / 60)).padStart(2, "0")}:${String(p % 60).padStart(2, "0")}`;
	}
	_tipHtml() {
		return e`<div class="tip" role="tooltip">${this._tip}</div>`;
	}
	_placeTip(l, p) {
		const v = () => {
			const k = this.renderRoot.querySelector(".tip");
			if (!k) return;
			const w = Math.min(l + 10, window.innerWidth - k.offsetWidth - 8),
				_ = p - k.offsetHeight - 10;
			(k.style.left = `${Math.max(8, w)}px`),
				(k.style.top = `${_ >= 8 ? _ : p + 12}px`);
		};
		if (this.renderRoot.querySelector(".tip")) {
			v();
			return;
		}
		this.updateComplete.then(v).catch(() => {
			return;
		});
	}
	_hairWallMs() {
		return this.mode === "attempt" && this.attempt
			? Tt(this.attempt)
			: this.wallMs;
	}
	get _stripHost() {
		return {
			setTip: (l, p, v) => {
				(this._tip = l),
					(this._slot = p),
					(this._tipRef = v ?? null),
					this.requestUpdate();
			},
			placeTip: (l, p) => this._placeTip(l, p),
			hide: () => {
				this._hideTip(), this.requestUpdate();
			},
			slot: () => this._slot,
		};
	}
	_attemptHandlers = _t(this._stripHost);
	_renderAttempt() {
		const l = this.attempt,
			p = this._width || 240;
		if (!l)
			return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;
		return e`
			${St(l, p, this._attemptHandlers)}
			${this._hairlineHtml()}
			${$t(l, this._tzLabel())}
			${this._tip ? this._tipHtml() : null}
		`;
	}
	render() {
		if (this.mode === "attempt") return this._renderAttempt();
		const l = this._spec;
		return e`
			<svg
				class="plot"
				viewBox="0 0 ${this._width || 240} 40"
				preserveAspectRatio="none"
				role="img"
				aria-label="Fresh and cached input tokens in ${l.slotMs / 60000}-minute bins across the measured track"
				tabindex="0"
				@pointermove=${this._hover}
				@pointerleave=${this._hide}
				@keydown=${this._keyNav}
			>
				${this._barsSvg(l)}
			</svg>
			${this._hairlineHtml()}
			${this._axisHtml(l)}
			${this._tip ? this._tipHtml() : null}
		`;
	}
}
var H = o(u(s())),
	V = o(u(c())),
	Kt = i({
		fresh: V,
		cached: V,
		out: V,
		wall_ms: V,
		model_groups: o(g(s(), m())),
	}),
	Dt = i({
		state: s(),
		observed_at: V,
		source: H,
		progress: o(
			u(
				i({
					stage: S(["completed", "reviewed", "review-blocked", "landed"]),
					ts: V,
				}),
			),
		),
	}),
	Bt = i({ text: H }),
	qt = i({
		id: s(),
		project: H,
		title: H,
		state: s(),
		age_s: V,
		owner_sid: H,
		owner_label: H,
		origin: H,
		model: H,
		locality: H,
		parent_id: H,
		tag_color: H,
		failure_note: H,
		wait_kind: H,
		wait_reason: H,
		requires: H,
		blocked_by: o(a(s())),
		waiting_on: o(a(s())),
		spend: o(u(Kt)),
		execution: o(u(Dt)),
		tail: o(u(Bt)),
	});
class W extends n {
	static properties = {
		t: { attribute: !1 },
		executors: { attribute: !1 },
		executorPick: { attribute: !1 },
		effortOptions: { attribute: !1 },
		series: { attribute: !1 },
		attempt: { attribute: !1 },
		attemptView: { attribute: !1 },
		pendingAction: { attribute: !1 },
		draftPick: { attribute: !1 },
		draftEffort: { attribute: !1 },
	};
	static styles = r``;
	constructor() {
		super();
		(this.t = null),
			(this.executors = []),
			(this.executorPick = ""),
			(this.effortOptions = []),
			(this.series = null),
			(this.attempt = null),
			(this.attemptView = !1),
			(this.pendingAction = ""),
			(this.draftPick = void 0),
			(this.draftEffort = void 0);
	}
	static modelOf(l) {
		let p = l.spend?.model_groups,
			v = "",
			b = -1;
		if (p)
			for (const [k, w] of Object.entries(p)) {
				const _ =
					typeof w === "object" && w !== null ? Number(w.requests ?? 0) : 0;
				if (Number.isFinite(_) && _ > b) (v = k), (b = _);
			}
		return v || l.model || void 0;
	}
	static hostOf(l) {
		const p = l.owner_label?.trim();
		if (p && p !== l.owner_sid && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(p))
			return p;
		return l.owner_sid ?? void 0;
	}
	static metricsOf(l) {
		const p = l.spend;
		if (!p) return;
		const v = p.fresh ?? void 0,
			b = p.cached ?? void 0,
			k = p.out ?? void 0,
			w = p.wall_ms ?? void 0,
			_ =
				v === void 0 && b === void 0 && k === void 0
					? void 0
					: (v ?? 0) + (b ?? 0) + (k ?? 0),
			E = w !== void 0 && w > 0 ? w / 60000 : 0,
			R = E > 0 && k !== void 0 ? k / E : void 0,
			C = (v ?? 0) + (b ?? 0),
			O = C > 0 && b !== void 0 ? (b / C) * 100 : void 0;
		return { tokens: _, wallMs: w, tokPerMin: R, cachePct: O };
	}
	static parentRefOf(l) {
		return l.parent_id ?? void 0;
	}
	contextLinesOf(l) {
		const p = [],
			v = l.execution;
		if (v) {
			const _ = v.progress?.stage;
			p.push(
				_
					? `${v.state} · ${_}`
					: `${v.state} · no artifact evidence in snapshot`,
			);
		}
		if (l.state === "WAITING" && l.wait_reason)
			p.push(`${l.wait_kind ?? "external"} · ${l.wait_reason}`);
		const b = l.blocked_by ?? [];
		if (b.length) p.push(`waiting on ${b.join(", ")}`);
		const k = l.waiting_on ?? [];
		if (k.length) p.push(`split into ${k.join(", ")}`);
		if (p.length) return p;
		const w = l.tail?.text?.trim();
		return w ? [w] : [];
	}
	modelOf(l) {
		const p = {
				id: l.id,
				project: l.project ?? void 0,
				title: l.title ?? void 0,
				state: l.state,
				ageS: l.age_s ?? void 0,
				contextLines: this.contextLinesOf(l),
				parentRef: W.parentRefOf(l),
				model: W.modelOf(l),
				host: W.hostOf(l),
				warn: l.failure_note ?? void 0,
				metrics: W.metricsOf(l),
				nested: this.hasAttribute("data-nested"),
				preferColor: l.tag_color ?? void 0,
				executors: this.executors,
				executorPick: this.draftPick ?? this.executorPick,
				effortOptions: this.effortOptions,
				effortPick: this.draftEffort ?? "",
				pendingAction: this.pendingAction || void 0,
			},
			v = ft.safeParse(p);
		return v.success ? v.data : null;
	}
	render() {
		const l = qt.safeParse(this.t);
		if (!this.t || !l.success)
			return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;
		const p = l.data,
			v = this.modelOf(p);
		if (!v) return e``;
		const b =
			this.series || this.attempt
				? e`<klh-card-activity
						slot="activity"
						.points=${this.series ?? []}
						.wallMs=${W.metricsOf(p)?.wallMs ?? null}
						.attempt=${this.attempt}
						.mode=${this.attemptView ? "attempt" : "spend"}
					></klh-card-activity>`
				: null;
		return e`<klh-task-card .card=${v}>${b}</klh-task-card>`;
	}
	createRenderRoot() {
		return this;
	}
}
var jt = () => {
	U("klh-task-card-host", W),
		U("klh-task-card", st),
		U("klh-card-activity", ct);
};
jt();
export { jt as registerBoardElements };
