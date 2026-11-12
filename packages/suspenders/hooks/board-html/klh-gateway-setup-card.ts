import { css, html, LitElement, nothing } from "lit";
import {
	GatewaySetupSchema,
	type GatewaySetup,
} from "../board/console-setup.ts";
import { cardCss } from "./klh-console-card-css.ts";

const headings = {
	unconfigured: "Setup needed",
	"configured-unavailable": "Configuration needs attention",
	ready: "Ready to test",
	unknown: "Setup check incomplete",
};

export class KlhGatewaySetupCard extends LitElement {
	static properties = {
		data: { type: Object },
		busy: { state: true },
		failed: { state: true },
	};
	static styles = [
		cardCss,
		css`
		:host { padding:24px 28px; border-top:3px solid var(--klh-ink); }
		header { display:flex; justify-content:space-between; gap:24px; align-items:start; }
		h2 { margin:0 0 6px; }
		h3 { font:500 23px/1.2 var(--klh-font-sans); letter-spacing:-.02em; margin:0 0 14px; }
		p { margin:0 0 16px; max-width:68ch; }
		table { width:100%; border-collapse:collapse; font-size:13px; }
		th,td { text-align:left; padding:10px 0; border-top:1px solid var(--klh-edge); }
		th { font-weight:500; width:24%; } td { color:var(--klh-dim); }
		footer { display:flex; align-items:center; gap:20px; margin-top:20px; font-size:12px; }
		a { color:var(--klh-ink); text-underline-offset:4px; }
		button { background:var(--klh-ink); color:var(--klh-bg); border:1px solid var(--klh-ink); border-radius:2px; padding:8px 14px; font:inherit; cursor:pointer; }
		button:disabled { opacity:.6; cursor:wait; }
		summary:focus-visible,a:focus-visible,button:focus-visible { outline:2px solid var(--klh-accent); outline-offset:4px; }
		summary { cursor:pointer; font-size:12px; padding:4px 0 8px; }
		.note { font-size:11px; margin:14px 0 0; color:var(--klh-dim); }
		@media(min-width:601px) {
 .compact { display:grid; grid-template-columns:1fr auto; gap:2px 24px; }
 .compact header { grid-column:1; } .compact header div { display:flex; align-items:baseline; gap:16px; }
 .compact h2,.compact h3 { margin:0; } .compact h3 { font-size:20px; }
 .compact > p:not(.note) { grid-column:1; margin:4px 0; font-size:13px; }
 .compact footer { grid-column:2; grid-row:1 / span 2; margin:0; align-self:center; }
 .compact details { grid-column:1; grid-row:3; } .compact .note { grid-column:2; grid-row:3; margin:4px 0 0; text-align:right; }
 }
		@media(max-width:600px) { :host { padding:18px; } th { width:32%; } h3 { font-size:22px; } }
	`,
	];
	declare data: GatewaySetup | null;
	declare busy: boolean;
	declare failed: boolean;
	private request?: AbortController;
	constructor() {
		super();
		this.data = null;
		this.busy = false;
		this.failed = false;
	}
	connectedCallback() {
		super.connectedCallback();
		if (!this.data) void this.refresh();
	}
	disconnectedCallback() {
		this.request?.abort();
		super.disconnectedCallback();
	}
	private async refresh() {
		if (this.busy) return;
		this.busy = true;
		const controller = new AbortController();
		this.request = controller;
		const timer = setTimeout(() => controller.abort(), 7000);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await fetch("/api/console/gateway-setup", {
				signal: controller.signal,
				cache: "no-store",
				redirect: "error",
			});
			if (!response.ok || !response.body) throw new Error("unavailable");
			reader = response.body.getReader();
			let text = "";
			let bytes = 0;
			const decoder = new TextDecoder("utf-8", { fatal: true });
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				bytes += next.value.length;
				if (bytes > 4096) throw new Error("oversize");
				text += decoder.decode(next.value, { stream: true });
			}
			text += decoder.decode();
			const data = GatewaySetupSchema.parse(JSON.parse(text));
			if (this.isConnected) {
				this.data = data;
				this.failed = false;
			}
		} catch {
			if (this.isConnected) this.failed = true;
		} finally {
			clearTimeout(timer);
			controller.abort();
			void reader?.cancel().catch(() => {});
			this.busy = false;
		}
	}
	protected render() {
		const d = this.data;
		const state = this.failed ? "unknown" : (d?.state ?? "unknown");
		const next =
			state === "unconfigured"
				? "Add a provider, a peer Buckle or a local model endpoint in Settings."
				: state === "configured-unavailable"
					? "Check the gateway and its configured connections in Settings."
					: state === "ready"
						? `${d?.connections ?? 0} connections configured. ${d?.models ?? 0} models advertised.`
						: "Some setup evidence is unavailable. Check again or review Settings; missing observations do not mean zero models.";
		return html`<section class=${state === "ready" ? "compact" : ""}><header><div><h2>Gateway setup</h2><h3 aria-live="polite">${headings[state]}</h3></div></header>
			<p>${next}</p>
			${this.failed ? html`<p role="status">Check unavailable. Previous observations below are retained.</p>` : nothing}
			<details ?open=${state !== "ready"}><summary>Setup checks</summary><table aria-label="Gateway setup checks"><tbody>
				<tr><th scope="row">Gateway</th><td>${!d || d.gateway === "unknown" ? "Not observed" : d.gateway === "up" ? "Responding to health checks" : "Unavailable"}</td></tr>
				<tr><th scope="row">Client access</th><td>Not tested — try an authenticated client.</td></tr>
				<tr><th scope="row">Connections</th><td>${d?.connections == null ? "Configuration unreadable" : d.defaultsOnly ? `${d.connections} shipped presets; operator setup not confirmed` : d.connections === 0 ? "None configured" : `${d.connections} connections`}</td></tr>
				<tr><th scope="row">Models</th><td>${d?.models == null ? "Current model observations unavailable" : d.models === 0 ? (d.connections && !d.defaultsOnly ? "No models currently observed" : "No models available or configured.") : `${d.models} advertised`}</td></tr>
			</tbody></table></details>
			<footer><a href="/console/settings">Settings</a><button type="button" ?disabled=${this.busy} @click=${this.refresh}>${this.busy ? "Checking…" : "Check again"}</button></footer>
			<p class="note">Checked ${d?.checkedAt ? html`<time datetime=${d.checkedAt}>${new Date(d.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>` : "time unavailable"} · Request test not run</p></section>`;
	}
}

if (!customElements.get("klh-gateway-setup-card"))
	customElements.define("klh-gateway-setup-card", KlhGatewaySetupCard);
