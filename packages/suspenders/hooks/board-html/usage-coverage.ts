// hooks/board-html/usage-coverage.ts — W858.11: the /usage evidence panel —
// an explicit coverage + freshness strip with a per-day drilldown into the
// HOUR DETAIL table. W184 pattern: plain Lit, shadow DOM, lit-html templates
// only; reads its display slice from the #usage-data payload's
// panels.coverage (shaped by hooks/bin/usage-coverage-data.ts) and
// self-registers so the usage-panels vendor bundle carries it via the
// standard side-effect import.
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import type { UsageCoveragePanel } from "../bin/usage-chrome.ts";

// same formatting ramp as the sibling usage panels (self-contained: the
// sibling module's exports would make the vendor bundle cycle)
const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));
const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;

const readCoverage = (): UsageCoveragePanel | null => {
	const el = document.getElementById("usage-data");
	if (!el) return null;
	try {
		return (
			(
				JSON.parse(el.textContent ?? "") as {
					panels?: { coverage?: UsageCoveragePanel };
				}
			).panels?.coverage ?? null
		);
	} catch {
		return null;
	}
};

export class KlhUsageCoverage extends LitElement {
	static properties = { panel: { type: Object, state: true } };

	declare panel: UsageCoveragePanel | null;

	constructor() {
		super();
		this.panel = null;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		this.panel = readCoverage();
	}

	protected render(): TemplateResult {
		const p = this.panel;
		if (!p) return html``;
		if (p.hoursData === 0)
			return html`<div class="upanel">
				<h2>EVIDENCE · COVERAGE & FRESHNESS</h2>
				<p class="uempty">
					no usage data in this window (${p.from} → ${p.to}) — the charts
					above show honest zeros
				</p>
			</div>`;
		return this.body(p);
	}

	private body(p: UsageCoveragePanel): TemplateResult {
		return html`<div class="upanel">
			<div class="uhead">
				<h2>EVIDENCE · COVERAGE & FRESHNESS</h2>
				<p class="ufoot">${p.source}${p.demoNote ? ` · ${p.demoNote}` : ""}</p>
			</div>
			<p class="ufoot">
				window ${p.from} → ${p.to} ·
				<b
					>${String(p.hoursData)} of ${String(p.hoursTotal)}</b
				> hours with data (<b
					>${pct1(p.hoursData / Math.max(1, p.hoursTotal))}</b
				>)
				${
					p.newest
						? html`· newest data ${p.newest} (${String(p.newestAgeH)}h before
					window end)`
						: nothing
				}
			</p>
			${
				p.longestGapH > 0
					? html`<p class="ufoot">
						longest zero-run <b>${String(p.longestGapH)}h</b> ending
						${p.gapEnd}
					</p>`
					: nothing
			}
			<details class="covdetails">
				<summary>Coverage by day — jump into an hour</summary>
				<table class="uacts">
					<thead>
						<tr>
							<th>day</th>
							<th class="unum">live hours</th>
							<th class="unum">tokens</th>
							<th>drilldown</th>
						</tr>
					</thead>
					<tbody>
						${p.byDay.map(
							(day) =>
								html`<tr>
									<td><b>${day.d}</b></td>
									<td class="unum">${String(day.hoursData)}</td>
									<td class="unum">${fmtTok(day.tok)}</td>
									<td>
										${
											day.href
												? html`<a href=${day.href}>hour detail →</a>`
												: "—"
										}
									</td>
								</tr>`,
						)}
					</tbody>
				</table>
			</details>
		</div>`;
	}
}

KlhUsageCoverage.styles = css`
	:host {
		display: block;
	}
	.upanel {
		display: block;
		background: var(--klh-surface, #1c1b19);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 3px;
		padding: 12px 14px 10px;
		margin-bottom: 14px;
	}
	.upanel h2 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--klh-dim, #98958e);
	}
	.uhead {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}
	.uhead .ufoot {
		margin: 0;
	}
	.ufoot {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
		margin: 2px 0 8px;
	}
	.ufoot b {
		color: var(--klh-ink, #e8e6e1);
		font-variant-numeric: tabular-nums;
	}
	.uempty {
		color: var(--klh-dim, #98958e);
		font-size: 12px;
	}
	table.uacts {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.uacts td,
	table.uacts th {
		padding: 6px 8px;
		border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
		text-align: left;
	}
	.unum {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--klh-ink-2, #c9c6bf);
		white-space: nowrap;
	}
	.covdetails {
		margin-top: 8px;
		border-top: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		padding-top: 8px;
		font-size: 11px;
	}
	.covdetails summary {
		cursor: pointer;
		color: var(--klh-ink-2, #c9c6bf);
	}
	.covdetails a {
		color: var(--klh-accent, #d8900f);
	}
`;

customElements.define("klh-usage-coverage", KlhUsageCoverage);

declare global {
	interface HTMLElementTagNameMap {
		"klh-usage-coverage": KlhUsageCoverage;
	}
}
