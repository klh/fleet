// hooks/board-html/klh-runner-card.ts — W2869.2.1: the board's read-only
// Fleet runner card. Presentation only: lists runs from the W2869.2
// control-plane listing endpoint (/api/console/runner → GET
// /v1/runner/runs) and surfaces the control listener's own monitored-
// service state (reused probe, no cross-origin browser fetch). No
// submit/resume/abort/park here — the per-reader attach/replay/detach
// cursor subscription activates once the control-plane's HTTP listener
// (parked/W2879) lands on main; until then the card says so honestly.
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { cardCss } from "./klh-console-card-css.ts";

export interface RunnerCardRunRow {
	runId: string;
	owner: string;
	generation: number;
	kind: string;
	model: string;
	provider: string;
	state: string;
	updatedAt: number;
}

export type RunnerCardRunner =
	| { ok: false; reason: string }
	| { ok: true; runs: RunnerCardRunRow[]; nextCursor: string | null };

export interface RunnerCardControl {
	state: string;
	detail: string;
}

export interface RunnerCardPayload {
	ok: true;
	ts: string;
	runner: RunnerCardRunner;
	control: RunnerCardControl | null;
}

const runnerCss = css`
	.unknown {
		color: var(--klh-dim);
		font-size: 11.5px;
		font-style: italic;
	}
	.hot {
		color: var(--klh-danger);
	}
	.live {
		color: var(--klh-accent);
	}
`;

const controlRow = (c: RunnerCardControl | null): TemplateResult =>
	c
		? html`<p>
				<span>control listener</span>
				<span class=${c.state === "up" ? "live" : "hot"}>${c.state}</span>
				<span class="unknown">· ${c.detail}</span>
			</p>`
		: html`<p>
				<span>control listener</span>
				<span class="unknown">not in the probe map</span>
			</p>`;

const runnerBody = (r: RunnerCardRunner): TemplateResult => {
	if (!r.ok) return html`<p class="unknown">${r.reason}</p>`;
	if (!r.runs.length)
		return html`<p class="unknown">no runs reported by the control plane</p>`;
	return html`<table class="ct">
		<thead>
			<tr>
				<th>run</th>
				<th>kind</th>
				<th>model</th>
				<th>state</th>
				<th>owner</th>
			</tr>
		</thead>
		<tbody>
			${r.runs.map(
				(row) => html`<tr>
					<td class="mono">${row.runId}</td>
					<td>${row.kind}</td>
					<td>${row.model}</td>
					<td>${row.state}</td>
					<td class="unknown">${row.owner}</td>
				</tr>`,
			)}
		</tbody>
	</table>`;
};

/** One live payload or null (fetch failure keeps the last known values). */
const fetchRunner = async (): Promise<RunnerCardPayload | null> => {
	try {
		const r = await fetch("/api/console/runner", { cache: "no-store" });
		if (!r.ok) return null;
		return (await r.json()) as RunnerCardPayload;
	} catch {
		return null;
	}
};

class KlhRunnerCard extends LitElement {
	static properties = { heading: { type: String }, data: { type: Object } };
	static styles = [cardCss, runnerCss];
	declare heading: string;
	declare data: RunnerCardPayload | null;
	private live: RunnerCardPayload | null = null;
	private err = "";
	private timer: ReturnType<typeof setInterval> | null = null;
	constructor() {
		super();
		this.heading = "";
		this.data = null;
	}
	connectedCallback() {
		super.connectedCallback();
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 10_000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		if (this.timer) clearInterval(this.timer);
	}
	private async refresh(): Promise<void> {
		const p = await fetchRunner();
		if (p) {
			this.live = p;
			this.err = "";
		} else this.err = "refresh failed — last known values shown";
	}
	protected render(): TemplateResult {
		const p = this.live ?? this.data;
		if (!p) return html`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;
		const errLine = this.err
			? html`<p class="unknown">${this.err}</p>`
			: nothing;
		return html`<h2>${this.heading}</h2>
			${errLine}${controlRow(p.control)}${runnerBody(p.runner)}
			<p class="cfoot">
				Read-only: attach/replay/detach per-reader cursor subscriptions
				render here once the control-plane listener lands — no control
				actions are issued from this view.
			</p>`;
	}
}

if (!customElements.get("klh-runner-card"))
	customElements.define("klh-runner-card", KlhRunnerCard);
