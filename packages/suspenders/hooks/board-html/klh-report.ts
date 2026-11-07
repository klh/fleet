// hooks/board-html/klh-report.ts — the report tab as a light-DOM Lit
// feature (W2550.3; replaces the legacy REPORT string chunk). It renders
// THE work-report table verbatim (the CLI renderer's bytes in a <pre> —
// W1198) plus the per-row expand chips and the expanded row's lane detail,
// into the page's light DOM — the section skeleton and CSS stay in the page
// (#tab-report ids, .rptrow/.rptdetail/.rpthead/.rpttail classes keep every
// existing locator), so `createRenderRoot` returns the host. Properties in,
// events out: expanding/closing a row rides a typed
// ReportRowToggleRequestedEvent for <klh-report-mediator> to perform; the
// table bytes land in a <pre> text node (a lit text binding, never a string
// HTML sink), and ages re-tick at 1Hz from the mediator's slice push.
import { css, html, LitElement, nothing } from "lit";
import { ago, msAgo } from "./board-format.ts";
import { ReportRowToggleRequestedEvent } from "./report-events.ts";
import type { ReportRowDetail, ReportSlice } from "./report-slice.ts";

export class KlhReport extends LitElement {
	static properties = {
		slice: { attribute: false },
	};

	declare slice: ReportSlice;

	static styles = css`
		:host {
			display: block;
		}
	`;

	constructor() {
		super();
		this.slice = {
			loaded: false,
			err: null,
			okAt: 0,
			data: null,
			open: "",
			detail: null,
			detailErr: null,
			detailBusy: false,
		};
	}

	/** Light DOM: the section skeleton and page CSS keep working. */
	protected createRenderRoot(): this {
		return this;
	}

	/** The stamp line: face + freshness + row count + capacity (W1198). */
	private stampText(): string {
		const d = this.slice.data;
		if (!d) return "";
		const rows = (d.rows ?? []).length;
		const cap = d.capacity ? ` · ${d.capacity}` : "";
		return `the work report · checked ${ago(msAgo(this.slice.okAt))} · ${rows} rows${cap}`;
	}

	/** The expanded row's head line — the old chunk's head contract:
	 * id · state · lane <sid> · last event <age> (or "no events yet"). */
	private headText(d: ReportRowDetail): string {
		const lane = d.ownerSid ? ` · lane ${d.ownerSid}` : "";
		const last = d.lastEventTs
			? ` · last event ${ago(msAgo(d.lastEventTs))}`
			: " · no events yet";
		return `${d.id ?? ""} · ${String(d.state ?? "").toLowerCase()}${lane}${last}`;
	}

	protected render() {
		const s = this.slice;
		const rows = s.data?.rows ?? [];
		return html`
			<div class="taskbar">
				<span id="reportStamp" class="dim" role="status">
					${this.stampText()}
				</span>
			</div>
			<klh-err-banner
				id="reportErr"
				class="taberr"
				feed="report"
				.text=${
					s.err
						? `report feed unavailable — last good ${
								s.okAt ? ago(msAgo(s.okAt)) : "never"
							}`
						: ""
				}
			></klh-err-banner>
			<pre id="reportTable" class="rpttable">${s.data?.table || "loading the work report..."}</pre>
			<nav
				id="reportRows"
				class="rptstrip"
				aria-label="Expand a report row for its live lane detail"
			>
				${rows.map(
					(r) => html`
						<button
							type="button"
							class="rptrow${s.open === r.id ? " on" : nothing}"
							data-rid=${r.id}
							title=${r.title}
							@click=${() =>
								this.dispatchEvent(new ReportRowToggleRequestedEvent(r.id))}
						>
							${r.id} ${r.st}
						</button>
					`,
				)}
			</nav>
			<div id="reportDetail" class="rptdetail">${this.renderDetail()}</div>
		`;
	}

	/** The expanded detail: loading → honest error → head + lane tail.
	 * Empty (closed) renders nothing — the page CSS hides :empty. */
	private renderDetail() {
		const s = this.slice;
		if (!s.open) return nothing;
		if (s.detailBusy && !s.detail && !s.detailErr)
			return html`loading row detail...`;
		if (s.detailErr) return html`row unavailable: ${s.detailErr}`;
		const d = s.detail;
		if (!d) return nothing;
		const tail = d.laneTail ?? [];
		return html`
			<div class="rpthead">${this.headText(d)}</div>
			${
				tail.length
					? html`
						<div class="rpttail">
							${tail.map(
								(l) =>
									html`<div class="trow">
										${l.ts ? `[${l.ts}] ${l.text}` : l.text}
									</div>`,
							)}
						</div>
					`
					: html`<div class="dim">
						no live lane transcript for this row
					</div>`
			}
		`;
	}
}

if (!customElements.get("klh-report"))
	customElements.define("klh-report", KlhReport);

declare global {
	interface HTMLElementTagNameMap {
		"klh-report": KlhReport;
	}
}
