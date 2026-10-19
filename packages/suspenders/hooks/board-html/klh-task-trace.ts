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

interface WorkEvent {
	ts: number;
	kind: string;
	source: string;
	note?: string | null;
	sha?: string | null;
}

interface ExecutionHop {
	at: number;
	traceId: string | null;
	hub: string;
	hop: string;
	model: string | null;
	endpoint: string | null;
	ms: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	status: "ok" | "error" | "unknown";
	requestId: string;
}

interface ExecutionTrace {
	lane: {
		sid: string;
		executor: string;
		host: string;
		state: string;
		attempt: number;
	} | null;
	days: number;
	hubs: { label: string; ok: boolean; reason: string | null }[];
	hops: ExecutionHop[];
	limited: boolean;
}

/** Observed Board orchestration hops attached to a work item. */
class KlhTaskTrace extends LitElement {
	static properties = {
		trace: { attribute: false },
		events: { attribute: false },
		execution: { attribute: false },
		loading: { type: Boolean },
		error: { type: String },
	};
	declare trace: TraceStep[];
	declare events: WorkEvent[];
	declare execution: ExecutionTrace | null;
	declare loading: boolean;
	declare error: string | null;

	static styles = css`
		:host { display: block; border-top: 1px solid var(--klh-edge, #5d5a52); padding: 12px 0; }
		h2 { margin: 0 0 8px; font: 600 13px/1.3 ui-sans-serif, system-ui; color: var(--klh-ink, #e8e4da); }
		h3 { margin: 12px 0 5px; font: 600 12px/1.3 ui-sans-serif, system-ui; color: var(--klh-ink, #e8e4da); }
		p { margin: 4px 0; font: 12px/1.45 ui-sans-serif, system-ui; color: var(--klh-dim, #97917f); }
		ol { margin: 0; padding: 0; list-style: none; }
		li { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 8px; padding: 5px 0; border-top: 1px solid var(--klh-edge, #5d5a52); font: 12px/1.45 ui-sans-serif, system-ui; }
		time, .sub, code { color: var(--klh-dim, #97917f); }
		strong { font-weight: 600; color: var(--klh-ink, #e8e4da); }
		.error { color: var(--klh-danger-ink, #e07a5f); }
		.sub { display: block; overflow-wrap: anywhere; }
		details { margin: 10px 0; border: 1px solid var(--klh-edge, #5d5a52); padding: 8px 10px; }
		summary { cursor: pointer; font: 600 12px/1.4 ui-sans-serif, system-ui; }
		summary:focus-visible { outline: 2px solid var(--klh-accent, #b87b16); outline-offset: 2px; }
		.counts { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0; font: 12px/1.45 ui-sans-serif, system-ui; }
		.counts span { color: var(--klh-dim, #97917f); }
		code { font: 11px ui-monospace, SFMono-Regular, monospace; }
	`;

	constructor() {
		super();
		this.trace = [];
		this.events = [];
		this.execution = null;
		this.loading = false;
		this.error = null;
	}

	// W902: UTC-first dual stamp — a bare local time is unreadable across hubs
	private stamp(at: number): string {
		const d = new Date(at);
		const p = (n: number): string => String(n).padStart(2, "0");
		const off = -d.getTimezoneOffset();
		const a = Math.abs(off);
		const utc = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
		const local = `${p(d.getHours())}:${p(d.getMinutes())} UTC${off >= 0 ? "+" : "-"}${p(Math.floor(a / 60))}:${p(a % 60)}`;
		return `${utc} (${local})`;
	}

	protected render() {
		const traceId = this.trace[0]?.traceId ?? "";
		const execution = this.execution;
		const hops = execution?.hops ?? [];
		const failed = hops.filter((hop) => hop.status === "error").length;
		const models = [...new Set(hops.map((hop) => hop.model).filter(Boolean))];
		return html`<h2>Work trace ${traceId ? html`<code>${traceId.slice(0, 12)}</code>` : ""}</h2>
			<h3>Work graph</h3>
			${
				this.events.length
					? html`<ol>${this.events.map(
							(event) => html`<li>
				<time datetime=${new Date(event.ts).toISOString()}>${this.stamp(event.ts)}</time>
				<div><strong>${event.kind}</strong> · ${event.source}<span class="sub">${[event.note, event.sha ? `commit ${event.sha.slice(0, 12)}` : null].filter(Boolean).join(" · ")}</span></div>
			</li>`,
						)}</ol>`
					: html`<p>No work graph events recorded for this item.</p>`
			}
			${this.trace.length ? html`<h3>Plan and registration</h3>` : ""}
			<ol>${this.trace.map(
				(step) => html`<li>
				<time datetime=${new Date(step.at).toISOString()}>${this.stamp(step.at)}</time>
				<div><strong class=${step.status === "error" ? "error" : ""}>${step.phase}</strong> · ${step.service}
					<span class="sub">${[step.model, step.endpoint, step.ms == null ? null : `${step.ms} ms`, step.inputTokens == null ? null : `${step.inputTokens} in`, step.outputTokens == null ? null : `${step.outputTokens} out`].filter(Boolean).join(" · ")}</span>
				</div>
			</li>`,
			)}</ol>
			${!this.trace.length ? html`<p>No orchestration trace recorded. Directly created work starts at the work graph.</p>` : ""}
			${this.loading ? html`<p>Checking lane requests across hubs…</p>` : ""}
			${this.error ? html`<p class="error">Request history unavailable: ${this.error}</p>` : ""}
			${
				execution?.lane
					? html`
				<h3>Execution · ${execution.days}d window</h3>
				<p>Lane <code>${execution.lane.sid}</code> · ${execution.lane.executor} on ${execution.lane.host} · ${execution.lane.state} · attempt ${execution.lane.attempt}</p>
					<p>Requests matched by lane ID. Each request shows its gateway trace ID when available.</p>
				${execution.hubs.filter((hub) => !hub.ok).map((hub) => html`<p class="error">${hub.label}: ${hub.reason ?? "unavailable"}</p>`)}
				<div class="counts"><span><strong>${hops.length}</strong> requests</span><span><strong>${failed}</strong> failed</span><span><strong>${models.length}</strong> models</span></div>
				${models.length ? html`<p>Models: ${models.join(", ")}</p>` : ""}
				${execution.limited ? html`<p>History limited to the latest 200 requests in this window.</p>` : ""}
				${
					hops.length
						? html`<details><summary>Request history · ${hops.length} Buckle hops</summary><ol>${hops.map(
								(hop) => html`<li>
					<time datetime=${new Date(hop.at).toISOString()}>${this.stamp(hop.at)}</time>
					<div><strong class=${hop.status === "error" ? "error" : ""}>${hop.hub} · ${hop.hop}</strong> → ${hop.model ?? "model unknown"}
						<span class="sub">${[hop.endpoint, hop.ms == null ? null : `${hop.ms} ms`, hop.inputTokens == null ? null : `${hop.inputTokens} in`, hop.outputTokens == null ? null : `${hop.outputTokens} out`, hop.cacheReadTokens == null ? null : `${hop.cacheReadTokens} cache read`, hop.status, hop.traceId ? `trace ${hop.traceId}` : "trace unavailable (older request)", `request ${hop.requestId.slice(0, 12)}`].filter(Boolean).join(" · ")}</span>
					</div>
				</li>`,
							)}</ol></details>`
						: html`<p>No Buckle requests for this lane in the selected window.</p>`
				}
			`
					: execution && !execution.lane
						? html`<p>No dispatched lane recorded for this item.</p>`
						: ""
			}`;
	}
}

customElements.define("klh-task-trace", KlhTaskTrace);
