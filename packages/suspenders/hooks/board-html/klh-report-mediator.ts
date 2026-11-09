// hooks/board-html/klh-report-mediator.ts — the report family's mediator
// (W2550.3; owns what the legacy REPORT chunk did at page scope). It
// defines and subscribes the report + reportRow feeds on the ONE page-wide
// FeedStore (boardFeeds()), holds the pane state (last good payload, the
// expanded row id, its detail/error) and pushes the computed slice down as
// a property. The row feed rides a bounded 30s cadence and only while a row
// is expanded on the report tab (url() gates — inactive feeds never fetch);
// the pane feed polls only on the report tab. Expanding/closing rides the
// typed ReportRowToggleRequestedEvent (toggling the open row closes it).
// Ages re-tick at 1Hz without a fetch. Light-DOM children stay where the
// page put them (display: contents), so ids and page CSS keep working.
import { css, html, LitElement } from "lit";
import type { FeedStore } from "./feed-store.ts";
import { boardFeeds } from "./feed-store.ts";
import type { KlhReport } from "./klh-report.ts";
import { ReportRowToggleRequestedEvent } from "./report-events.ts";
import type { ReportFeed } from "./report-slice.ts";

/** One /api/report payload (loose — the feed accept gates the wire). */
type ReportApiFeed = ReportFeed;

/** One /api/report-row payload (loose — the feed accept gates the wire). */
type ReportRowApiFeed = {
	ok?: boolean;
	error?: string;
	id?: string;
	state?: string;
	ownerSid?: string | null;
	lastEventTs?: number | null;
	laneTail?: { text: string; ts: string | null }[];
};

const reportAccept = (j: unknown): void => {
	const o = j as ReportApiFeed | null;
	if (!o || typeof o.ts !== "number" || typeof o.table !== "string")
		throw new Error("bad /api/report payload");
};

const reportRowAccept = (j: unknown): void => {
	const o = j as ReportRowApiFeed | null;
	if (!o || o.ok === false) throw new Error(o?.error || "row not found");
};

/** The report feed's project query — exported for the URL-contract pins. */
export const reportQueryOf = (scope: string): string =>
	!scope || scope === "all" ? "" : `?project=${encodeURIComponent(scope)}`;

/** The row feed URL ('' when inactive) — exported for the URL-contract
 * pins (the old chunk's reportRowUrl contract: the OPEN ROW's own project
 * wins over the global filter; '' when the tab/row is closed). */
export const reportRowUrlOf = (
	tab: string,
	open: string,
	scope: string,
	fallbackProject: string,
): string => {
	if (tab !== "report" || !open) return "";
	const project = scope && scope !== "all" ? scope : fallbackProject;
	return `/api/report-row?project=${encodeURIComponent(project)}&id=${encodeURIComponent(open)}`;
};

export class KlhReportMediator extends LitElement {
	static styles = css`
		:host {
			display: contents;
		}
	`;

	private store: FeedStore = boardFeeds();
	private unsubs: (() => void)[] = [];
	private ticker: ReturnType<typeof setInterval> | null = null;
	private open = "";
	private detail: ReportRowApiFeed | null = null;
	private detailErr: string | null = null;

	constructor() {
		super();
		this.addEventListener(
			ReportRowToggleRequestedEvent.eventName,
			this.onToggle,
		);
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.store.define("report", {
			everyMs: 2000,
			url: () =>
				this.visTab() === "report"
					? `/api/report${reportQueryOf(this.readProj())}`
					: null,
			accept: reportAccept,
			ok: () => this.push(),
			fail: () => this.push(),
		});
		this.store.define("reportRow", {
			everyMs: 30000,
			url: () => {
				const u = reportRowUrlOf(
					this.visTab(),
					this.open,
					this.readProj(),
					this.reportProject(),
				);
				return u || null;
			},
			accept: reportRowAccept,
			ok: (j) => {
				this.detail = j as ReportRowApiFeed;
				this.detailErr = null;
				this.push();
			},
			fail: (e) => {
				this.detailErr = e;
				this.push();
			},
		});
		this.unsubs = [
			this.store.subscribe("report", () => this.push()),
			this.store.subscribe("reportRow", () => this.push()),
		];
		// ages tick at 1Hz without a fetch; paused with the page
		this.ticker = setInterval(() => {
			if (!document.hidden) this.push();
		}, 1000);
		this.push();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		for (const u of this.unsubs) u();
		this.unsubs = [];
		if (this.ticker !== null) clearInterval(this.ticker);
		this.ticker = null;
	}

	/** Toggle contract: the same chip closes; a new chip swaps + refetches. */
	private onToggle(e: ReportRowToggleRequestedEvent): void {
		e.stopPropagation();
		if (this.open === e.id) {
			this.open = "";
			this.detail = null;
			this.detailErr = null;
			this.push();
			return;
		}
		this.open = e.id;
		this.detail = null;
		this.detailErr = null;
		this.store.kick("reportRow", true);
		this.push();
	}

	private visTab(): string {
		const h = (location.hash || "").replace(/^#/, "").split("?")[0];
		return h || "decisions";
	}

	private readProj(): string {
		const el = document.getElementById("proj") as HTMLSelectElement | null;
		return el?.value || "all";
	}

	/** The pane payload's own project — the row fallback scope. */
	private reportProject(): string {
		const d = this.store.get("report")?.data as ReportApiFeed | null;
		return d?.project ?? "";
	}

	/** Data down: recompute the slice and hand it to the leaf. */
	private push(): void {
		const st = this.store.get("report");
		const row = this.store.get("reportRow");
		const leaf = this.querySelector<KlhReport>("klh-report");
		if (!leaf) return;
		leaf.slice = {
			loaded: st?.loaded ?? false,
			err: st?.err ?? null,
			okAt: st?.okAt ?? 0,
			data: (st?.data as ReportApiFeed | null) ?? null,
			open: this.open,
			detail:
				this.detail ?? (this.open ? (row?.data as ReportRowApiFeed) : null),
			detailErr: this.detailErr ?? (this.open ? (row?.err ?? null) : null),
			detailBusy: Boolean(
				this.open && row?.busy && !this.detail && !this.detailErr,
			),
		};
	}

	protected render() {
		return html`<slot></slot>`;
	}
}

if (!customElements.get("klh-report-mediator"))
	customElements.define("klh-report-mediator", KlhReportMediator);

declare global {
	interface HTMLElementTagNameMap {
		"klh-report-mediator": KlhReportMediator;
	}
}
