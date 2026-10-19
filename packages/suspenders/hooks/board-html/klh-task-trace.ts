import { css, html, LitElement } from "lit";

interface TraceStep {
	traceId: string;
	at: number;
	phase: string;
	service: string;
	status: "ok" | "error";
	model?: string | null;
	endpoint?: string | null;
	ms?: number | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
}

/** Observed Board orchestration hops attached to a work item. */
class KlhTaskTrace extends LitElement {
	static properties = { trace: { attribute: false } };
	declare trace: TraceStep[];

	static styles = css`
		:host { display: block; border-top: 1px solid var(--klh-edge, #5d5a52); padding: 12px 0; }
		h2 { margin: 0 0 8px; font: 600 13px/1.3 ui-sans-serif, system-ui; color: var(--klh-ink, #e8e4da); }
		ol { margin: 0; padding: 0; list-style: none; }
		li { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 8px; padding: 5px 0; border-top: 1px solid var(--klh-edge, #5d5a52); font: 12px/1.45 ui-sans-serif, system-ui; }
		time, .sub, code { color: var(--klh-dim, #97917f); }
		strong { font-weight: 600; color: var(--klh-ink, #e8e4da); }
		.error { color: var(--klh-danger-ink, #e07a5f); }
		.sub { display: block; overflow-wrap: anywhere; }
		code { font: 11px ui-monospace, SFMono-Regular, monospace; }
	`;

	constructor() {
		super();
		this.trace = [];
	}

	protected render() {
		const traceId = this.trace[0]?.traceId ?? "";
		return html`<h2>Request trace <code>${traceId.slice(0, 12)}</code></h2>
			<ol>${this.trace.map(
				(step) => html`<li>
				<time datetime=${new Date(step.at).toISOString()}>${new Date(step.at).toLocaleTimeString()}</time>
				<div><strong class=${step.status === "error" ? "error" : ""}>${step.phase}</strong> · ${step.service}
					<span class="sub">${[step.model, step.endpoint, step.ms == null ? null : `${step.ms} ms`, step.inputTokens == null ? null : `${step.inputTokens} in`, step.outputTokens == null ? null : `${step.outputTokens} out`].filter(Boolean).join(" · ")}</span>
				</div>
			</li>`,
			)}</ol>`;
	}
}

customElements.define("klh-task-trace", KlhTaskTrace);
