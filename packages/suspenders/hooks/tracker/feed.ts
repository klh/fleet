// hooks/tracker/feed.ts — W575: the tracker's push feed. One WS subscription
// to the canonical bus (store-server /subscribe — the same socket coord
// subscribe rides), snapshot reconciliation on every (re)connect so missed
// events re-enter in id order, and a bounded per-view history.
import { type GovernorStore, resolveStoreHttpBase } from "../lib/govdb.ts";
import { KINDS } from "./model.ts";
import { recentTransitions } from "./snapshot.ts";

// Bounded ring keyed by event id: ordering is the event id, always. A
// reconcile refills from the canonical events table, so a reconnect both
// preserves ordering and recovers any events missed while the socket was
// down — no gap, no re-ordered history.
export class TransitionRing {
	private byId = new Map<number, Transition>();
	constructor(private cap: number) {}
	get size(): number {
		return this.byId.size;
	}
	maxId(): number {
		let max = 0;
		for (const id of this.byId.keys()) if (id > max) max = id;
		return max;
	}
	rows(): Transition[] {
		return [...this.byId.values()].sort(
			(a, b) => a.eventId - b.eventId || a.ts - b.ts,
		);
	}
	push(t: Transition): void {
		this.byId.set(t.eventId, t);
		this.trim();
	}
	// Snapshot refill: replaces with the canonical timeline read; returns how
	// many ids entered the ring that pushes hadn't delivered yet.
	refill(ts: Transition[]): number {
		let added = 0;
		for (const t of ts) {
			if (!this.byId.has(t.eventId)) added++;
			this.byId.set(t.eventId, t);
		}
		this.trim();
		return added;
	}
	private trim(): void {
		if (this.byId.size <= this.cap) return;
		const ids = [...this.byId.keys()].sort((a, b) => a - b);
		for (const id of ids.slice(0, ids.length - this.cap)) this.byId.delete(id);
	}
}

// Live feed: WS push with reconnect backoff (the coord subscribe chain),
// periodic reconcile, and a liveness-refresh interval for the now-row.
export class TrackerFeed {
	private ws: WebSocket | null = null;
	private backoff = 500;
	private readonly maxBackoff = 10_000;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconcileTimer: ReturnType<typeof setInterval> | null = null;
	closed = false;
	onchange: (() => void) | null = null;

	constructor(
		private readonly db: GovernorStore,
		private readonly opts: {
			project: string | null;
			history: number;
			reconcileMs: number;
		},
		readonly ring = new TransitionRing(opts.history),
	) {}

	start(): void {
		this.reconcile(); // ring populated before the socket opens
		this.connect();
		this.reconcileTimer = setInterval(
			() => this.reconcile(),
			this.opts.reconcileMs,
		);
	}

	stop(): void {
		this.closed = true;
		if (this.reconcileTimer) clearInterval(this.reconcileTimer);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		try {
			this.ws?.close();
		} catch {}
	}

	private connect(): void {
		if (this.closed) return;
		const bound = resolveStoreHttpBase();
		if (!bound) return; // no HTTP store — reconcile-only (poll) mode
		const params = new URLSearchParams({ as: "fleet-tracker" });
		if (this.opts.project) params.set("scope", this.opts.project);
		if (bound.token) params.set("token", bound.token);
		const wsBase = bound.base.replace(/^http/, "ws");
		const ws = new WebSocket(`${wsBase}/subscribe?${params}`);
		this.ws = ws;
		ws.addEventListener("open", () => {
			this.backoff = 500;
			this.reconcile(); // fresh socket: missed events re-enter in id order
		});
		ws.addEventListener("message", (e) => this.onEvent(String(e.data)));
		ws.addEventListener("close", () => {
			if (this.closed) return;
			this.ws = null;
			this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
			this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
		});
		ws.addEventListener("error", () => ws.close());
	}

	// A pushed event becomes a cell directly from its wire row — same field
	// projection as recentTransitions, so push and reconcile agree.
	private onEvent(raw: string): void {
		try {
			const r = JSON.parse(raw) as {
				id: number;
				ts: number;
				kind: string;
				payload: string | null;
				source: string;
				target: string | null;
			};
			this.ring.push({
				eventId: r.id,
				ts: r.ts,
				project: projOf(r.payload),
				item: itemOf(r.payload),
				lane: laneOf(r),
				state: KINDS[r.kind] ?? "decision",
				note: noteOf(r.payload),
			});
			this.onchange?.();
		} catch {} // malformed frame — never kill the feed
	}

	reconcile(): void {
		if (this.closed) return;
		this.ring.refill(
			recentTransitions(this.db, this.opts.project, this.opts.history),
		);
		this.onchange?.();
	}
}

function projOf(payload: string | null): string | null {
	if (!payload) return null;
	try {
		const p = JSON.parse(payload) as Record<string, unknown>;
		return typeof p.project === "string" ? p.project : null;
	} catch {
		return null;
	}
}

function itemOf(payload: string | null): string | null {
	if (!payload) return null;
	try {
		const p = JSON.parse(payload) as Record<string, unknown>;
		if (typeof p.work === "string") return p.work;
	} catch {} // unparseable payload still renders, as an unknown-kind row
	return null;
}

function laneOf(r: {
	kind: string;
	payload: string | null;
	source: string;
	target: string | null;
}): string | null {
	if (r.kind === "NEED_DECISION") return r.target;
	if (r.kind === "consult" || r.kind === "consult.answer") return r.source;
	if (!r.payload) return null;
	try {
		const p = JSON.parse(r.payload) as Record<string, unknown>;
		return typeof p.by === "string" ? p.by : null;
	} catch {
		return null;
	}
}

function noteOf(payload: string | null): string | null {
	if (!payload) return null;
	try {
		const p = JSON.parse(payload) as Record<string, unknown>;
		const n = p.note ?? p.summary;
		return typeof n === "string" ? n : null;
	} catch {
		return null;
	}
}
