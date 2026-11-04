// hooks/board-html/klh-decisions-mediator.ts — the decisions family's
// mediator (W2550.1; owns what the legacy DECISIONS/HISTORY chunks did at
// page scope). It defines and subscribes the dec + hist feeds on the ONE
// page-wide FeedStore (boardFeeds()), performs every side effect the leaf
// asks for via typed Decision*RequestedEvents (answer POST — W798 dup-class
// ids[] payload; advise + W667 transport backoff 2s/4s/8s max 3; cancel with
// confirm), holds the request state (drafts, option picks, sent/err flags)
// and pushes the computed slice down as properties. The section collapse,
// needs-you badge, document title, and history toggle land here because they
// are page-level concerns the legacy chunk owned. Light-DOM children stay
// where the page put them (display: contents), so ids and page CSS keep
// working.
import { LitElement, css, html } from "lit";
import { boardFeeds } from "./feed-store.ts";
import type {
	AdviceRow,
	DecisionsSlice,
	DecisionRow,
	DecisionRequestState,
	GatedRow,
} from "./klh-decisions.ts";
import {
	DecisionAnswerRequestedEvent,
	DecisionAdviseRequestedEvent,
	DecisionCancelRequestedEvent,
} from "./decisions-events.ts";
import type { FeedStore } from "./feed-store.ts";

/** One /api/decisions payload (loose — the feed schema gates the wire). */
type DecFeed = {
	ts?: number;
	decisions?: DecisionRow[];
	gated?: GatedRow[];
	projects?: string[];
};

type HistFeed = { ts?: number; ok?: boolean; decisions?: DecisionRow[] };

const decAccept = (j: unknown): void => {
	const o = j as DecFeed | null;
	if (!o || typeof o.ts !== "number" || !Array.isArray(o.decisions))
		throw new Error("bad /api/decisions payload");
};

// hist: the named DecisionsHistoryFeedSchema validates at the FeedStore
// boundary (FEED_SCHEMAS — schema law W1238.4, no hand-cast accept here);
// histAccept is retired. The dec accept stays the local fast path the
// board-mediator validator composes with.

/** Scoped POST — 8s timeout, HTTP error mapped to the body's `error`. */
async function postJSON(
	url: string,
	body: unknown,
): Promise<Record<string, unknown>> {
	const r = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(8000),
	});
	const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
	if (!r.ok && !j.error && !j.output) j.error = `HTTP ${r.status}`;
	return j;
}

/** The dec feed's project query ('' for the all-scope) — exported for the
 * unit scope pins (the old chunk's projQuery contract). */
export const projQueryOf = (scope: string): string =>
	!scope || scope === "all" ? "" : `?project=${encodeURIComponent(scope)}`;

/** The hist feed URL ('' when inactive) — the ?/& splice is the old chunk's. */
export const histUrlOf = (scope: string, active: boolean): string => {
	if (!active) return "";
	const q = projQueryOf(scope);
	return `/api/decisions${q}${q ? "&" : "?"}history=1`;
};

export class KlhDecisionsMediator extends LitElement {
	static override styles = css`
		:host {
			display: contents;
		}
	`;

	private store: FeedStore = boardFeeds();
	private unsubs: (() => void)[] = [];
	private slice: DecisionsSlice = {
		dec: { loaded: false, err: null, okAt: 0, data: null },
		hist: { loaded: false, err: null, okAt: 0, data: null },
		open: true,
		query: "",
		filter: "",
		project: "",
		needs: {},
	};
	private requests: DecisionRequestState = {
		answering: {},
		ansErr: {},
		sentOk: {},
		drafts: {},
		selOpt: {},
		advising: {},
		advRetry: {},
		advAttempts: {},
		advErr: {},
	};
	private collapsed = false;
	private histOpen = false;
	private ticker: ReturnType<typeof setInterval> | null = null;
	private onProjChange = (): void => {};
	/** the project scope the dec feed's payload is already scoped to */
	private projScope = "all";
	/** decision ids ever toasted (baselined on first good fetch) */
	private seen = new Set<string>();
	private decBaseline = false;
	private projBaseline = false;

	constructor() {
		super();
		this.addEventListener(
			DecisionAnswerRequestedEvent.eventName,
			this.onAnswer,
		);
		this.addEventListener(
			DecisionAdviseRequestedEvent.eventName,
			this.onAdvise,
		);
		this.addEventListener(
			DecisionCancelRequestedEvent.eventName,
			this.onCancel,
		);
		// the leaf's native-element controls (collapse caret, history toggle)
		this.addEventListener("collapse-toggle", (e: Event) => {
			e.stopPropagation();
			this.setCollapsed(Boolean((e as CustomEvent).detail));
		});
		this.addEventListener("hist-toggle", (e: Event) => {
			e.stopPropagation();
			this.setHistOpen(Boolean((e as CustomEvent).detail));
		});
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.store.define("dec", {
			url: () => `/api/decisions${this.projQuery()}`,
			accept: decAccept,
			ok: (j) => this.onDecOk(j),
			fail: () => this.push(),
		});
		this.store.define("hist", {
			url: () => {
				const u = histUrlOf(
					this.projScope,
					this.histOpen && this.visTab() === "decisions",
				);
				return u || null;
			},
			// no accept: the named DecisionsHistoryFeedSchema (FEED_SCHEMAS)
			// validates this feed at the FeedStore boundary
			ok: (j) => this.onHistOk(j),
			fail: () => this.push(),
		});
		this.unsubs = [
			this.store.subscribe("dec", () => this.push()),
			this.store.subscribe("hist", () => this.push()),
		];
		// the page's project filter drives the feed scope (the sel change
		// also rescope()s the whole store from the chunk scope)
		this.onProjChange = () => {
			this.projScope = this.readProj();
			this.projBaseline = true; // fresh scope — re-baseline toasts
			this.push();
		};
		document
			.getElementById("proj")
			?.addEventListener("change", this.onProjChange);
		// ages tick at 1Hz without a fetch; paused with the page
		this.ticker = setInterval(() => {
			if (!document.hidden) this.push();
		}, 1000);
		this.projScope = this.readProj();
		this.push();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		for (const u of this.unsubs) u();
		this.unsubs = [];
		document
			.getElementById("proj")
			?.removeEventListener("change", this.onProjChange);
		if (this.ticker !== null) clearInterval(this.ticker);
		this.ticker = null;
	}

	private projQuery(): string {
		return projQueryOf(this.projScope);
	}

	private visTab(): string {
		const h = (location.hash || "").replace(/^#/, "").split("?")[0];
		return h || "decisions";
	}

	private readProj(): string {
		const el = document.getElementById("proj") as HTMLSelectElement | null;
		return el?.value || "all";
	}

	private onDecOk(j: unknown): void {
		const feed = j as DecFeed | null;
		if (feed?.projects) noteProjectsBridge(feed.projects);
		this.push();
	}

	private onHistOk(_j: unknown): void {
		this.push();
	}

	/** Public: the chunk scope's setCollapsed() bridge + badge click. */
	setCollapsed(v: boolean): void {
		this.collapsed = v;
		this.push();
	}

	/** Public: re-filter (board search input / hash filter changed). */
	refresh(): void {
		this.push();
	}

	private setHistOpen(v: boolean): void {
		this.histOpen = v;
		this.push();
		if (v) this.store.kick("hist", true);
	}

	/** Data down: recompute the slice and hand it to the leaf. */
	private push(): void {
		const dec = this.store.get("dec");
		const hist = this.store.get("hist");
		const data = this.store.get("data");
		const decData = dec?.data as DecFeed | null;
		const decisions = decData?.decisions ?? [];
		this.slice = {
			dec: {
				loaded: dec?.loaded ?? false,
				err: dec?.err ?? null,
				okAt: dec?.okAt ?? 0,
				data: decData
					? {
							decisions,
							gated: decData.gated ?? [],
						}
					: null,
			},
			hist: {
				loaded: hist?.loaded ?? false,
				err: hist?.err ?? null,
				okAt: hist?.okAt ?? 0,
				data: (hist?.data as HistFeed | null) ?? null,
			},
			open: true,
			query: this.boardQuery(),
			filter: this.hashFilter(),
			project: this.projScope,
			needs: this.needsMap(data?.data),
		};
		this.lifecycle(decisions);
		// the tag map (declare global in klh-decisions.ts) types the lookup —
		// a type-only class import can't satisfy the Element constraint
		const leaf = this.querySelector("klh-decisions");
		if (leaf) {
			leaf.slice = this.slice;
			leaf.requests = this.requests;
			leaf.collapsed = this.collapsed;
			leaf.histOpen = this.histOpen;
		}
		this.noteNew();
		this.paintChrome();
	}

	/** /api/data needs map ({source: [rows]}) flattened to id → row. */
	private needsMap(data: unknown): Record<string, AdviceRow> {
		const out: Record<string, AdviceRow> = {};
		const needs = (data as { needs?: Record<string, AdviceRow[]> } | null)
			?.needs;
		if (!needs) return out;
		for (const rows of Object.values(needs))
			for (const row of rows) out[row.id] = row;
		return out;
	}

	/** W667 advise lifecycle (the 1Hz tick drives it) — see advSettle. */
	private lifecycle(decisions: DecisionRow[]): void {
		const live = new Set(decisions.filter((d) => !d.dup_of).map((d) => d.id));
		const keys = [
			"advising",
			"advErr",
			"answering",
			"sentOk",
			"advRetry",
			"advAttempts",
		] as const;
		for (const key of keys)
			for (const id of Object.keys(this.requests[key]))
				if (!live.has(id)) delete this.requests[key][id];
		const needs = this.needsMap(this.store.get("data")?.data);
		for (const d of decisions) {
			if (d.dup_of) continue;
			const advice = (d as AdviceRow).advice
				? (d as AdviceRow)
				: (needs[d.id] ?? null);
			const pending = advice?.advicePending ?? null;
			if (pending && this.requests.advising[d.id] === undefined)
				this.requests.advising[d.id] = Date.now();
			this.advSettle(d.id, advice, pending);
			const backoff = this.requests.advRetry[d.id];
			if (backoff && backoff.at <= Date.now()) {
				delete this.requests.advRetry[d.id];
				this.askAdv(d.id); // exhaustion landed in advErr inside queueAdvRetry
			}
		}
	}

	/** advice landing clears request state; a spinner past the server's max
	 * runtime (5m30s) reads dead honestly with a manual retry. */
	private advSettle(id: string, advice: AdviceRow | null, pending: unknown) {
		if (
			(this.requests.advising[id] !== undefined ||
				this.requests.advRetry[id]) &&
			advice &&
			!pending &&
			Date.now() - (this.requests.advising[id] ?? 0) > 1500 &&
			(advice.advice || advice.adviceError)
		) {
			delete this.requests.advising[id];
			delete this.requests.advRetry[id];
			delete this.requests.advErr[id];
			delete this.requests.advAttempts[id];
		}
		if (
			this.requests.advising[id] !== undefined &&
			Date.now() - this.requests.advising[id] > 330000
		) {
			delete this.requests.advising[id];
			delete this.requests.advRetry[id];
			this.requests.advErr[id] = "advice did not land in 5m 30s — press retry";
		}
	}

	private boardQuery(): string {
		const el = document.getElementById("boardSearch");
		return el ? String((el as HTMLInputElement).value || "").trim() : "";
	}

	private hashFilter(): string {
		const m = (location.hash || "").match(/^#filter=([^&]*)/);
		if (m) return m[1] ? safeDecode(m[1]) : "";
		const i = (location.hash || "").indexOf("?");
		if (i < 0) return "";
		for (const pair of (location.hash || "").slice(i + 1).split("&")) {
			const eq = pair.indexOf("=");
			const k = eq < 0 ? pair : pair.slice(0, eq);
			if (k === "q" || k === "filter")
				return safeDecode(eq < 0 ? "" : pair.slice(eq + 1));
		}
		return "";
	}

	/** W798 baseline: toast only decisions new since the last good fetch. */
	private noteNew(): void {
		const ds = this.slice.dec.data?.decisions ?? [];
		if (!ds.length) return;
		const base = this.projBaseline || !this.decBaseline;
		this.projBaseline = false;
		for (const d of ds) {
			if (!d.state || d.state !== "OPEN") continue;
			if (base) {
				this.seen.add(d.id);
				continue;
			}
			if (this.seen.has(d.id)) continue;
			this.seen.add(d.id);
			const t = document.getElementById("toasts");
			if (t) {
				const div = document.createElement("div");
				div.className = "toast";
				div.textContent = `new decision #${d.id} — ${String(d.question || "").slice(0, 90)}`;
				t.appendChild(div);
				setTimeout(() => div.remove(), 6000);
			}
		}
		this.decBaseline = true;
	}

	/** The badge + title the legacy chunk painted at page scope. */
	private paintChrome(): void {
		const all = this.slice.dec.data?.decisions ?? [];
		let open = 0;
		for (const d of all) {
			if (d.dup_of) continue;
			if (!d.state || d.state === "OPEN") open++;
		}
		const badge = document.getElementById("needsn");
		if (badge) {
			const txt = open ? `${open} need you` : "";
			if (badge.textContent !== txt) badge.textContent = txt;
		}
		const pb =
			this.projScope === "all"
				? null
				: (String(this.projScope).split("/").pop() ?? "").replace(/\.git$/, "");
		const base = pb ? `${pb.toUpperCase()} · FLEET BOARD` : "FLEET BOARD";
		const ttl = this.collapsed && open ? `${base} (${open})` : base;
		if (document.title !== ttl) document.title = ttl;
	}

	/** W667: backoff 2s/4s/8s, max 3 auto-retries, exhaustion in advErr. */
	private queueAdvRetry(id: string, msg: string): void {
		const n = (this.requests.advAttempts[id] ?? 0) + 1;
		this.requests.advAttempts[id] = n;
		if (n > 3) {
			delete this.requests.advising[id];
			delete this.requests.advRetry[id];
			this.requests.advErr[id] = msg;
			return;
		}
		this.requests.advRetry[id] = { n, at: Date.now() + 1000 * 2 ** n };
	}

	private onAnswer = (e: DecisionAnswerRequestedEvent): void => {
		e.stopPropagation();
		this.sendAns(e.id, e.note);
	};

	private onAdvise = (e: DecisionAdviseRequestedEvent): void => {
		e.stopPropagation();
		this.askAdv(e.id);
	};

	private onCancel = (e: DecisionCancelRequestedEvent): void => {
		e.stopPropagation();
		this.cancelDec(e.id);
	};

	private decById(id: string): DecisionRow | null {
		for (const d of this.slice.dec.data?.decisions ?? [])
			if (d.id === id) return d;
		return null;
	}

	private sendAns(id: string, note: string): void {
		const busy = this.requests.answering[id];
		const d = busy ? null : this.decById(id);
		if (busy || !d) return; // in flight — never resubmit
		this.requests.answering[id] = true;
		delete this.requests.ansErr[id];
		this.push();
		void this.answerPost(id, note, d);
	}

	private async answerPost(
		id: string,
		note: string,
		d: DecisionRow,
	): Promise<void> {
		try {
			// W798 class ruling: a primary with dup_count resolves the whole
			// class — members (dup_of === id) ride the same POST as ids[]
			const members: string[] = [];
			for (const m of this.slice.dec.data?.decisions ?? [])
				if (m.dup_of === id) members.push(m.id);
			const payload =
				(d.dup_count ?? 0) > 1
					? { ids: [id, ...members], note }
					: {
							id,
							token: d.answer_token,
							note,
							to: d.asked_by,
							forEvent: id,
						};
			const res = (await postJSON("/api/answer", payload)) as {
				ok?: boolean;
				error?: string;
				output?: string;
			};
			delete this.requests.answering[id];
			if (res?.ok) {
				this.requests.sentOk[id] = true;
				delete this.requests.drafts[id];
				delete this.requests.selOpt[id];
			} else {
				const stale = res?.error === "stale";
				this.requests.ansErr[id] = stale
					? "stale — changed elsewhere, reloading"
					: res?.error || res?.output || "send failed — press Send to retry";
			}
		} catch (e) {
			delete this.requests.answering[id];
			this.requests.ansErr[id] =
				`${String((e as Error)?.message || e)} — press Send to retry`;
		}
		this.push();
		this.store.kick("dec", true);
	}

	private askAdv(id: string): void {
		const backoff = this.requests.advRetry[id];
		if (backoff && backoff.at > Date.now()) return; // backoff armed
		delete this.requests.advErr[id];
		delete this.requests.advRetry[id];
		if (this.requests.advising[id] === undefined)
			this.requests.advising[id] = Date.now(); // age continuity across retries
		this.push();
		void this.advisePost(id);
	}

	private async advisePost(id: string): Promise<void> {
		try {
			const res = (await postJSON("/api/advise", { id })) as {
				ok?: boolean;
				error?: string;
			};
			// started:true → child spawned; started:false+inFlight → an earlier
			// child still runs — keep the spinner, the poll picks the fact up
			if (!res?.ok)
				this.queueAdvRetry(id, res?.error || "advise failed to start");
		} catch (e) {
			// W667: a transport failure (8s fetch timeout etc.) is NOT advice
			// failure — the detached child keeps running server-side. Back off
			// and re-fire instead of surfacing a dead "signal timed out".
			this.queueAdvRetry(id, String((e as Error)?.message || e));
		}
		this.push();
	}

	private cancelDec(id: string): void {
		const d = this.decById(id);
		const prompt =
			d?.owner_reason === "target-dead"
				? "Dismiss this obsolete decision? Its target lane is absent. The decision will be recorded as cancelled."
				: "Cancel this decision? The asking lane will see it as cancelled.";
		if (!window.confirm(prompt)) return;
		void this.cancelPost(id);
	}

	private async cancelPost(id: string): Promise<void> {
		try {
			const res = (await postJSON("/api/ack", { id })) as {
				ok?: boolean;
				error?: string;
				output?: string;
			};
			if (!res?.ok) {
				this.requests.ansErr[id] =
					res?.error || res?.output || "cancel failed — retry";
				this.push();
			}
			this.store.kick("dec", true);
		} catch (e) {
			this.requests.ansErr[id] =
				`${String((e as Error)?.message || e)} — retry`;
			this.push();
		}
	}

	protected override render() {
		return html`<slot></slot>`;
	}
}

const safeDecode = (s: string): string => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

/** The chunk scope owns the #proj option list (noteProjects); the mediator
 * publishes each good dec payload's projects back into it via a window
 * event — the chunk scope forwards list merges it hears. */
function noteProjectsBridge(list: string[]): void {
	window.dispatchEvent(
		new CustomEvent("dec-projects", { detail: list, composed: true }),
	);
}

if (!customElements.get("klh-decisions-mediator"))
	customElements.define("klh-decisions-mediator", KlhDecisionsMediator);

declare global {
	interface HTMLElementTagNameMap {
		"klh-decisions-mediator": KlhDecisionsMediator;
	}
}
