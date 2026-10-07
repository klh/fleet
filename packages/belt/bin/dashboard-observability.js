import { html, css, LitElement } from "/vendor/lit.js";
import { supervisorFresh, restartEvidence } from "/dashboard-state.js";
import { observationFresh } from "/observation.js";

class BeltSupervisor extends LitElement {
	static properties = {
		snapshot: { state: true },
		error: { state: true },
		busy: { state: true },
		now: { state: true },
	};
	static styles = css`
		:host { display:block; border-block:1px solid var(--klh-edge); margin-block:var(--klh-space-4); padding-block:var(--klh-space-3); }
		.heading { display:flex; align-items:baseline; gap:var(--klh-space-3); flex-wrap:wrap; }
		h2 { font:inherit; font-size:var(--klh-text-sm); margin:0; }
		p { margin:var(--klh-space-2) 0; color:var(--klh-dim); font-size:var(--klh-text-sm); }
		button { margin-left:auto; background:transparent; border:1px solid var(--klh-edge); border-radius:var(--klh-radius); color:var(--klh-ink); padding:4px 10px; font:inherit; cursor:pointer; }
		button:focus-visible, summary:focus-visible { outline:2px solid var(--klh-accent); outline-offset:3px; }
		button:disabled { opacity:.6; cursor:wait; }
		details { border-top:1px solid var(--klh-edge-faint); padding-block:var(--klh-space-2); }
		summary { cursor:pointer; overflow-wrap:anywhere; }
		.state { margin-inline:var(--klh-space-3); color:var(--klh-dim); }
		.alert { color:var(--klh-danger); }
		.reason { color:var(--klh-ink); overflow-wrap:anywhere; }
	`;
	constructor() {
		super();
		this.snapshot = null;
		this.error = "";
		this.busy = false;
		this.now = Date.now();
	}
	connectedCallback() {
		super.connectedCallback();
		this.refresh();
		this.timer = setInterval(() => {
			this.now = Date.now();
			this.refresh();
		}, 5000);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		clearInterval(this.timer);
		this.controller?.abort();
	}
	async refresh() {
		if (this.busy) return;
		this.busy = true;
		this.controller = new AbortController();
		const timeout = setTimeout(() => this.controller.abort(), 5000);
		try {
			const response = await fetch("/api/supervisor", {
				signal: this.controller.signal,
				cache: "no-store",
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const snapshot = await response.json();
			if (
				snapshot &&
				(!Array.isArray(snapshot.targets) ||
					!Number.isFinite(snapshot.intervalMs))
			)
				throw new Error("Invalid supervisor snapshot");
			this.snapshot = snapshot;
			this.error = "";
		} catch (error) {
			this.error = `Supervisor feed unavailable: ${error.message}`;
		} finally {
			clearTimeout(timeout);
			this.now = Date.now();
			this.busy = false;
		}
	}
	render() {
		const doc = this.snapshot;
		const fresh =
			!this.error &&
			supervisorFresh(doc, this.now) &&
			observationFresh(doc?.observation, this.now);
		const targets = doc?.targets ?? [];
		const alerts = targets.filter(
			(target) => target.alert || target.preflightError,
		).length;
		const idle = targets.filter((target) => target.state === "idle").length;
		const age = doc
			? Math.max(0, Math.round((this.now - Date.parse(doc.updated)) / 1000))
			: null;
		return html`
			<div class="heading"><h2>Supervisor</h2><button type="button" ?disabled=${this.busy} @click=${this.refresh}>${this.busy ? "Refreshing…" : "Refresh status"}</button></div>
			<p role="status" class=${fresh ? "" : "alert"}>${this.error || (doc ? (fresh ? `${alerts} need attention · ${idle} on demand · probes ${age}s ago` : `Supervisor snapshot stale (${age}s old). Current service state is unknown.`) : "No supervisor snapshot. Current service state is unknown.")}</p>
			${doc?.observation ? html`<p>Evidence: ${doc.observation.source} · ${doc.observation.scope} · expires ${new Date(doc.observation.expiresAt).toLocaleTimeString()}</p>` : ""}
			${targets.map(
				(
					target,
				) => html`<details><summary>${displayLabel(target.name)} :${target.port}<span class="state ${fresh && target.alert ? "alert" : ""}">${fresh && this.targetFresh(target, doc) ? this.label(target) : `last known: ${this.label(target)}`}</span></summary>
				<p>${target.kind} · ${target.owned ? "supervised" : "observed"} · ${restartEvidence(target)}</p>
				<p>Last successful probe: ${target.lastOk || "none recorded"}${target.nextRetryAt ? ` · retry after ${target.nextRetryAt}` : ""}</p>
				${target.preflightError || target.lastError ? html`<p class="reason">${target.preflightError || target.lastError}</p>` : ""}
			</details>`,
			)}
		`;
	}
	targetFresh(target, doc) {
		const at = Date.parse(target.lastProbe || "");
		return (
			Number.isFinite(at) &&
			at <= this.now + 5000 &&
			this.now - at <= Math.max(15000, doc.intervalMs * 3)
		);
	}
	label(target) {
		if (target.preflightError) return "dependency blocked";
		if (target.state === "idle") return "idle · on demand";
		if (target.state === "unhealthy") return "restart limit reached";
		if (target.state === "backoff") return "retry scheduled";
		return target.state;
	}
}
customElements.define("belt-supervisor", BeltSupervisor);
