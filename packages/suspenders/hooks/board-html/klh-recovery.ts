import { LitElement, css, html } from "lit";
import type { RecoverySnapshot } from "../board/recovery.ts";

class KlhRecovery extends LitElement {
	static properties = {
		data: { state: true },
		error: { state: true },
		busy: { state: true },
	};
	static styles = css`
		:host { display:block; margin-bottom:20px; color:var(--klh-ink); font:13px/1.5 var(--klh-font-sans); }
		header { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; border-bottom:1px solid var(--klh-edge); }
		h2 { font-size:14px; margin:0 0 8px; } h3 { font-size:12px; margin:18px 0 4px; }
		p { margin:6px 0; } .dim { color:var(--klh-dim); } .warn { color:var(--klh-danger-ink); }
		button { margin-left:auto; font:inherit; color:inherit; background:var(--klh-surface); border:1px solid var(--klh-edge); padding:4px 10px; cursor:pointer; }
		:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		.scroll { overflow:auto; } table { width:100%; border-collapse:collapse; text-align:left; }
		th { font-weight:500; color:var(--klh-dim); font-size:11px; } th, td { padding:6px 10px 6px 0; border-bottom:1px solid var(--klh-edge); vertical-align:top; }
		code { font:11px var(--klh-font-mono); overflow-wrap:anywhere; } summary { cursor:pointer; } details { margin-top:12px; }
	`;
	declare data: RecoverySnapshot | null;
	declare error: string;
	declare busy: boolean;
	private project = "";
	private generation = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	constructor() {
		super();
		this.data = null;
		this.error = "";
		this.busy = false;
	}
	connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("change", this.projectChanged);
		window.addEventListener("hashchange", this.activated);
		this.timer = setInterval(() => {
			if (!document.hidden && !this.closest("section")?.hidden)
				void this.refresh();
		}, 10_000);
		void this.refresh();
	}
	disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.timer) clearInterval(this.timer);
		document.removeEventListener("change", this.projectChanged);
		window.removeEventListener("hashchange", this.activated);
		this.generation++;
	}
	private activated = (): void => {
		if (location.hash === "#governor") void this.refresh();
	};
	private projectChanged = (e: Event): void => {
		if ((e.target as HTMLElement)?.id === "proj") void this.refresh();
	};
	private async refresh(): Promise<void> {
		const project =
			(document.getElementById("proj") as HTMLSelectElement | null)?.value ??
			"all";
		if (this.busy && project === this.project) return;
		const generation = ++this.generation;
		if (project !== this.project) {
			this.data = null;
			this.error = "";
		}
		this.project = project;
		this.busy = true;
		try {
			const r = await fetch(
				`/api/recovery?project=${encodeURIComponent(project)}`,
				{ cache: "no-store", signal: AbortSignal.timeout(8000) },
			);
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const data = (await r.json()) as RecoverySnapshot;
			if (
				!Number.isFinite(data.ts) ||
				!Array.isArray(data.incidents) ||
				!Array.isArray(data.consults) ||
				!data.outcomes
			)
				throw new Error("Invalid recovery snapshot");
			if (generation !== this.generation) return;
			this.data = data;
			this.error = "";
		} catch (e) {
			if (generation === this.generation)
				this.error = e instanceof Error ? e.message : "Request failed";
		} finally {
			if (generation === this.generation) this.busy = false;
		}
	}
	private lane(s: string | null): string {
		return s ? (s.length > 20 ? `${s.slice(0, 12)}…` : s) : "unassigned";
	}
	protected render() {
		const d = this.data;
		const age = d ? Math.max(0, Math.round((Date.now() - d.ts) / 1000)) : null;
		return html`
			<header><h2>Recovery & collaboration</h2><span class="dim">last 24 hours · selected project</span><button type="button" ?disabled=${this.busy} @click=${this.refresh}>${this.busy ? "Refreshing…" : "Refresh recovery"}</button></header>
			<p class=${this.error || (age !== null && age > 30) ? "warn" : "dim"} role="status">${this.error ? `Recovery unavailable: ${this.error}. ${d ? "Last good snapshot retained." : "No snapshot loaded."}` : age !== null ? `${age > 30 ? "Stale snapshot" : "Checked"} · ${age}s ago` : "Loading recovery evidence…"}</p>
			${
				d
					? html`
				<p>${d.outcomes.resolved ?? 0} resolved consults · ${d.outcomes.failed ?? 0} failed · ${d.outcomes.unused ?? 0} unused${!d.feedbackAvailable ? " · outcome reporting not installed" : ""}</p>
				<h3>Governor incidents <span class="dim">most recent 30</span></h3>
				${
					!d.incidentsAvailable
						? html`<p class="dim">Incident reporting is not installed.</p>`
						: !d.incidents.length
							? html`<p class="dim">No governor incidents recorded in this window.</p>`
							: html`
				<div class="scroll"><table><thead><tr><th scope="col">State</th><th scope="col">Lane / project</th><th scope="col">Resource</th><th scope="col">Attempts</th><th scope="col">Consult</th></tr></thead><tbody>${d.incidents.map(
					(r) => html`<tr>
				<td class=${!r.resolved_at && d.ts - r.last_at < 1_800_000 ? "warn" : "dim"}>${r.resolved_at ? "Resolved" : d.ts - r.last_at >= 1_800_000 ? "Inactive · unconfirmed" : "Needs coordination"}</td>
				<td><code title=${r.sid}>${this.lane(r.sid)}</code><br><code>${r.project}</code></td><td><code>${r.resource}</code></td><td>${r.attempts}</td><td>${r.consult_id ? `C${r.consult_id}` : "None queued"}</td>
				</tr>`,
				)}</tbody></table></div>`
				}
				<details><summary>Consult threads · ${d.consults.length} most recent</summary>
				<p class="dim">An answer is a candidate until the asker confirms the result. Open threads older than one hour await expiry; they are not active evidence.</p>
				${d.consults.map((c) => html`<p><b>C${c.id}</b> · ${c.state === "OPEN" && d.ts - c.created_at >= 3_600_000 ? "OPEN · stale" : c.state} · ${c.outcome ?? "Outcome unconfirmed"}<br><code>${this.lane(c.asker_sid)} → ${this.lane(c.expert_sid)} · ${c.scope ?? "No scope"} · ${c.project}</code></p>`)}
				${!d.consults.length ? html`<p class="dim">No consult threads recorded in this window.</p>` : ""}
				</details>
			`
					: ""
			}
		`;
	}
}
if (!customElements.get("klh-recovery"))
	customElements.define("klh-recovery", KlhRecovery);
