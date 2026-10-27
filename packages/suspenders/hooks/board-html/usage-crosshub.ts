// hooks/board-html/usage-crosshub.ts — <klh-usage-crosshub> (W365), moved
// verbatim from usage-panels.ts in the W1298 decomposition: the per-hub
// rollup table with degraded-row diagnostics.
import { css, html, LitElement, type TemplateResult } from "lit";
import type { UsagePanels } from "../bin/usage-chrome.ts";
import {
	fmtTok,
	panelCss,
	readPanels,
	readSlot,
	segT,
} from "./usage-shared.ts";

// ─── <klh-usage-crosshub> — W365 per-hub rollup table ─────────────────────
const CROSSHUB_EMPTY =
	"no hub rollups — enumerate hubs in stack.json (hubs:) or the hubs.json registry; the board fetches each hub's /federation/usage server-side (TTL-cached, per-hub degrade)";

export class KlhUsageCrossHub extends LitElement {
	static properties = { panel: { type: Object, state: true } };

	declare panel: UsagePanels["crosshub"] | null;
	private slot: Record<string, string> = {};

	constructor() {
		super();
		this.panel = null;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.panel = readPanels()?.crosshub ?? null;
		this.slot = readSlot();
	}

	protected render(): TemplateResult {
		const p = readPanels()?.crosshub;
		if (!p) return html``;
		if ("empty" in p)
			return html`<div class="upanel">
				<h2>CROSS-HUB</h2>
				<p class="uempty">${p.empty}</p>
			</div>`;
		if (!p.rows.length) return this.empty();
		return this.body(p.rows);
	}

	private empty(): TemplateResult {
		return html`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<p class="uempty">${CROSSHUB_EMPTY}</p>
		</div>`;
	}

	private row(
		r: NonNullable<UsagePanels["crosshub"]>["rows"][number],
	): TemplateResult {
		if (r.degraded) {
			const reason = r.reason ?? "No response from this hub";
			const summary = /timed out|timeout/i.test(reason)
				? "No response before the hub timeout"
				: /typeerror|host is down|connection refused|unable to connect/i.test(
							reason,
						)
					? "Cannot reach this hub"
					: /hub answered (401|403)/.test(reason)
						? "Usage access denied"
						: /hub answered 404/.test(reason)
							? "Usage endpoint unavailable"
							: /no url/i.test(reason)
								? "No usage endpoint configured"
								: "Could not read usage from this hub";
			return html`<tr>
				<td>
					<b>${r.hub}</b>
					<span class="uchip">degraded</span>
				</td>
				<td colspan="3">
					${summary}
					<details><summary>Diagnostic</summary><code>${reason}</code></details>
				</td>
			</tr>`;
		}
		const barW = Math.max(2, (r.total / Math.max(1, ...this.rowTotals)) * 100);
		return html`<tr>
			<td>
				<b>${r.hub}</b>
				<span class="uchip">${r.via}</span>
				<span class="uchip">${String(r.spokes)} spokes</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${String(barW)}%`}>
					${r.segs.map((seg) => segT(seg, r.total, this.slot))}
				</div>
			</td>
			<td class="unum">${fmtTok(r.total)}</td>
			<td class="unum">${fmtTok(r.rq)}</td>
		</tr>`;
	}

	private get rowTotals(): number[] {
		return (readPanels()?.crosshub?.rows ?? []).map((x) => x.total);
	}

	private body(
		rows: NonNullable<UsagePanels["crosshub"]>["rows"],
	): TemplateResult {
		return html`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>hub</th>
						<th style="width:38%">tokens by model class</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${rows.map((row) => this.row(row))}
				</tbody>
			</table>
			<p class="ufoot">${readPanels()?.crosshub?.foot ?? ""}</p>
		</div>`;
	}
}

// crosshub chrome — panel + shared table/bar/chip css
KlhUsageCrossHub.styles = [
	panelCss,
	css`
		:host {
			display: block;
		}
		details {
			margin-top: 4px;
			font-size: 11px;
			color: var(--klh-dim);
		}
		details code {
			overflow-wrap: anywhere;
		}
	`,
];
