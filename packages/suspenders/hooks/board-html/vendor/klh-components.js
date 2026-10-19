import { e, r, s, t } from "./lit-sq0mv1by.js";
var h = [
		["prompt.condense", "condense"],
		["prompt.enhance", "enhance (local LLM)"],
		["prompt.debug", "debug preview"],
		["prompt.log", "log all stages"],
	],
	p = {
		"prompt.condense": !1,
		"prompt.enhance": !1,
		"prompt.debug": !1,
		"prompt.log": !1,
	};
class g extends s {
	static properties = {
		settings: { state: !0 },
		view: { state: !0 },
		busy: { state: !0 },
		err: { state: !0 },
		sent: { state: !0 },
	};
	static styles = r`
		:host {
			display: block;
			margin: 4px 0;
			font: 12px/1.45 ui-sans-serif, system-ui;
			color: var(--klh-ink, #e8e4da);
		}
		summary {
			cursor: pointer;
			color: var(--klh-dim, #97917f);
		}
		.toggles {
			display: flex;
			flex-wrap: wrap;
			gap: 12px;
			padding: 4px 0;
		}
		.pv {
			margin-top: 6px;
			padding: 8px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-left: 3px solid var(--klh-accent, #d9a53a);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
		}
		.hd {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: baseline;
		}
		.dim {
			color: var(--klh-dim, #97917f);
		}
		pre {
			margin: 4px 0;
			padding: 6px 8px;
			white-space: pre-wrap;
			word-break: break-word;
			max-height: 16em;
			overflow: auto;
			font: 12px/1.4 ui-monospace, monospace;
			background: rgb(0 0 0 / 0.18);
			border-radius: 4px;
			user-select: text;
		}
		.err {
			color: #e07a5f;
		}
		.actions {
			display: flex;
			gap: 8px;
			margin-top: 6px;
		}
		button {
			font: inherit;
			cursor: pointer;
			padding: 3px 10px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
			color: var(--klh-ink, #e8e4da);
		}
		button.go {
			border-color: var(--klh-accent, #d9a53a);
			font-weight: 600;
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
	`;
	project = "";
	goal = "";
	previewId = null;
	constructor() {
		super();
		(this.settings = { ...p }),
			(this.view = null),
			(this.busy = !1),
			(this.err = null),
			(this.sent = !1);
	}
	get gated() {
		return this.settings["prompt.debug"] || this.settings["prompt.log"];
	}
	ready(i) {
		return !this.busy && !this.sent && this.goal === i && !!this.project;
	}
	connectedCallback() {
		super.connectedCallback(), this.loadSettings();
	}
	async loadSettings() {
		try {
			const n = await (await fetch("/api/prompt/settings")).json();
			if (n.settings) this.settings = { ...p, ...n.settings };
		} catch {}
	}
	async toggle(i, n) {
		const o = this.settings;
		this.settings = { ...o, [i]: n };
		try {
			const l = await fetch("/api/prompt/settings", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ [i]: n }),
				}),
				c = await l.json();
			if (!l.ok || !c.settings) throw Error(c.error ?? `HTTP ${l.status}`);
			this.settings = { ...p, ...c.settings };
		} catch (l) {
			(this.settings = o),
				(this.err = `settings not saved: ${l instanceof Error ? l.message : String(l)}`);
		}
	}
	async prepare(i, n, o) {
		(this.project = i),
			(this.goal = n),
			(this.previewId = null),
			(this.view = null),
			(this.err = null),
			(this.sent = !1),
			(this.busy = !0);
		try {
			const l = await fetch("/api/orchestrate/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(
						o?.length
							? { project: i, goal: n, attachments: o }
							: { project: i, goal: n },
					),
					signal: AbortSignal.timeout(30000),
				}),
				c = await l.json();
			if (!l.ok || !c.ok || !c.preview)
				throw Error(c.error ?? `HTTP ${l.status}`);
			(this.view = c.preview), (this.previewId = c.previewId ?? null);
		} catch (l) {
			this.err = `preview failed: ${l instanceof Error ? l.message : String(l)}`;
		} finally {
			this.busy = !1;
		}
	}
	clear() {
		(this.view = null),
			(this.err = null),
			(this.sent = !1),
			(this.goal = ""),
			(this.project = ""),
			(this.previewId = null);
	}
	dispatch() {
		if (this.busy || this.sent || !this.project) return;
		(this.sent = !0),
			this.dispatchEvent(
				new CustomEvent("klh-dispatch", {
					bubbles: !0,
					composed: !0,
					detail: {
						project: this.project,
						goal: this.goal,
						previewId: this.previewId,
					},
				}),
			);
	}
	block(i, n) {
		return e`<details ?open=${n}>
			<summary>${i.label} · ${i.bytes} B</summary>
			<pre>${i.text}</pre>
		</details>`;
	}
	summary() {
		const i = h.filter(([n]) => this.settings[n]).map(([, n]) => n);
		return `prompt transforms · ${i.length ? i.join(", ") : "all off"}`;
	}
	body() {
		if (!this.busy && !this.view && !this.err) return t;
		const i = this.view;
		return e`<section class="pv" aria-live="polite" aria-label="dispatch preview">
			<div class="hd">
				<strong>${this.sent ? "dispatched" : "will dispatch"}</strong>
				${
					i
						? e`<span class="dim"
								>${i.finalBytes} B · condense ${i.ran.condense ? "ran" : "off"} ·
								enhance ${i.ran.enhance ? "ran" : "off"}${i.wireBytes ? ` · ${i.wireBytes} B on the wire` : ""}</span
							>`
						: t
				}
			</div>
			${this.busy ? e`<div class="dim">preparing preview…</div>` : t}
			${this.err ? e`<div class="err">${this.err}</div>` : t}
			${i?.enhanceNote ? e`<div class="dim">${i.enhanceNote}</div>` : t}
			${i ? e`<pre aria-label="final prompt">${i.final}</pre>` : t}
			${
				i?.stages?.length
					? e`<div class="dim">stages</div>
							${i.stages.map((n) => this.block(n, !1))}`
					: t
			}
			${
				i?.injected?.length
					? e`<div class="dim">injected context (appended to the prompt)</div>
							${i.injected.map((n) => this.block(n, !1))}`
					: t
			}
			${
				this.sent || !this.project
					? t
					: e`<div class="actions">
							<button
								class="go"
								type="button"
								?disabled=${this.busy}
								@click=${this.dispatch}
							>
								dispatch anyway ⏎
							</button>
							<button type="button" @click=${this.clear}>cancel</button>
						</div>`
			}
		</section>`;
	}
	render() {
		return e`
			<details>
				<summary>${this.summary()}</summary>
				<div class="toggles">
					${h.map(
						([i, n]) => e`<label>
							<input
								type="checkbox"
								.checked=${this.settings[i]}
								@change=${(o) => this.toggle(i, o.target.checked)}
							/>
							${n}
						</label>`,
					)}
				</div>
			</details>
			${this.body()}
		`;
	}
}
customElements.define("klh-prompt-preview", g);
class m extends s {
	static properties = {
		trace: { attribute: !1 },
		events: { attribute: !1 },
		execution: { attribute: !1 },
		loading: { type: Boolean },
		error: { type: String },
	};
	static styles = r`
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
		(this.trace = []),
			(this.events = []),
			(this.execution = null),
			(this.loading = !1),
			(this.error = null);
	}
	stamp(i) {
		const n = new Date(i),
			o = (d) => String(d).padStart(2, "0"),
			l = -n.getTimezoneOffset(),
			c = Math.abs(l),
			a = `${o(n.getUTCHours())}:${o(n.getUTCMinutes())}:${o(n.getUTCSeconds())}Z`,
			u = `${o(n.getHours())}:${o(n.getMinutes())} UTC${l >= 0 ? "+" : "-"}${o(Math.floor(c / 60))}:${o(c % 60)}`;
		return `${a} (${u})`;
	}
	render() {
		const i = this.trace[0]?.traceId ?? "",
			n = this.execution,
			o = n?.hops ?? [],
			l = o.filter((a) => a.status === "error").length,
			c = [...new Set(o.map((a) => a.model).filter(Boolean))];
		return e`<h2>Work trace ${i ? e`<code>${i.slice(0, 12)}</code>` : ""}</h2>
			<h3>Work graph</h3>
			${
				this.events.length
					? e`<ol>${this.events.map(
							(a) => e`<li>
				<time datetime=${new Date(a.ts).toISOString()}>${this.stamp(a.ts)}</time>
				<div><strong>${a.kind}</strong> · ${a.source}<span class="sub">${[a.note, a.sha ? `commit ${a.sha.slice(0, 12)}` : null].filter(Boolean).join(" · ")}</span></div>
			</li>`,
						)}</ol>`
					: e`<p>No work graph events recorded for this item.</p>`
			}
			${this.trace.length ? e`<h3>Plan and registration</h3>` : ""}
			<ol>${this.trace.map(
				(a) => e`<li>
				<time datetime=${new Date(a.at).toISOString()}>${this.stamp(a.at)}</time>
				<div><strong class=${a.status === "error" ? "error" : ""}>${a.phase}</strong> · ${a.service}
					<span class="sub">${[a.model, a.endpoint, a.ms == null ? null : `${a.ms} ms`, a.inputTokens == null ? null : `${a.inputTokens} in`, a.outputTokens == null ? null : `${a.outputTokens} out`].filter(Boolean).join(" · ")}</span>
				</div>
			</li>`,
			)}</ol>
			${!this.trace.length ? e`<p>No orchestration trace recorded. Directly created work starts at the work graph.</p>` : ""}
			${this.loading ? e`<p>Checking lane requests across hubs…</p>` : ""}
			${this.error ? e`<p class="error">Request history unavailable: ${this.error}</p>` : ""}
			${
				n?.lane
					? e`
				<h3>Execution · ${n.days}d window</h3>
				<p>Lane <code>${n.lane.sid}</code> · ${n.lane.executor} on ${n.lane.host} · ${n.lane.state} · attempt ${n.lane.attempt}</p>
					<p>Requests matched by lane ID. Each request shows its gateway trace ID when available.</p>
				${n.hubs.filter((a) => !a.ok).map((a) => e`<p class="error">${a.label}: ${a.reason ?? "unavailable"}</p>`)}
				<div class="counts"><span><strong>${o.length}</strong> requests</span><span><strong>${l}</strong> failed</span><span><strong>${c.length}</strong> models</span></div>
				${c.length ? e`<p>Models: ${c.join(", ")}</p>` : ""}
				${n.limited ? e`<p>History limited to the latest 200 requests in this window.</p>` : ""}
				${
					o.length
						? e`<details><summary>Request history · ${o.length} Buckle hops</summary><ol>${o.map(
								(a) => e`<li>
					<time datetime=${new Date(a.at).toISOString()}>${this.stamp(a.at)}</time>
					<div><strong class=${a.status === "error" ? "error" : ""}>${a.hub} · ${a.hop}</strong> → ${a.model ?? "model unknown"}
						<span class="sub">${[a.endpoint, a.ms == null ? null : `${a.ms} ms`, a.inputTokens == null ? null : `${a.inputTokens} in`, a.outputTokens == null ? null : `${a.outputTokens} out`, a.cacheReadTokens == null ? null : `${a.cacheReadTokens} cache read`, a.status, a.traceId ? `trace ${a.traceId}` : "trace unavailable (older request)", `request ${a.requestId.slice(0, 12)}`].filter(Boolean).join(" · ")}</span>
					</div>
				</li>`,
							)}</ol></details>`
						: e`<p>No Buckle requests for this lane in the selected window.</p>`
				}
			`
					: n && !n.lane
						? e`<p>No dispatched lane recorded for this item.</p>`
						: ""
			}`;
	}
}
customElements.define("klh-task-trace", m);
class v extends s {
	static properties = {
		eventId: { type: Number, attribute: "event-id" },
		count: { state: !0 },
		latest: { state: !0 },
		busy: { state: !0 },
		err: { state: !0 },
	};
	static styles = r`
		:host {
			display: block;
			margin-top: 6px;
			font: 12px/1.45 ui-sans-serif, system-ui;
		}
		.row {
			display: flex;
			gap: 8px;
			align-items: center;
		}
		button {
			font: inherit;
			cursor: pointer;
			padding: 3px 10px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
			color: var(--klh-ink, #e8e4da);
		}
		button:hover {
			border-color: var(--klh-accent, #d9a53a);
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
		.cnt {
			color: var(--klh-dim, #97917f);
		}
		output {
			display: block;
			margin-top: 6px;
			white-space: pre-wrap;
			color: var(--klh-ink, #e8e4da);
			border-left: 2px solid var(--klh-accent, #d9a53a);
			padding-left: 8px;
		}
		output.err {
			color: var(--klh-danger-ink, #e07a5f);
			border-left-color: var(--klh-danger, #e07a5f);
		}
	`;
	constructor() {
		super();
		(this.count = 0), (this.latest = null), (this.busy = !1), (this.err = null);
	}
	connectedCallback() {
		super.connectedCallback(), this.hydrate();
	}
	async hydrate() {
		if (!this.eventId) return;
		try {
			const i = await fetch(`/api/decisions/${this.eventId}/evals`);
			if (!i.ok) return;
			const n = await i.json();
			if ((this.apply(n.evals ?? []), n.status?.running))
				this.waitForEval(n.status.startedAt)
					.catch((o) => {
						this.err = o instanceof Error ? o.message : String(o);
					})
					.finally(() => {
						this.busy = !1;
					});
		} catch {}
	}
	apply(i, n) {
		(this.count = n ?? i.length),
			(this.latest = i[i.length - 1] ?? null),
			(this.err = null);
	}
	async evaluate() {
		if (this.busy || !this.eventId) return;
		(this.busy = !0), (this.err = null);
		try {
			const i = await fetch(`/api/decisions/${this.eventId}/evaluate`, {
					method: "POST",
				}),
				n = await i.json().catch(() => null);
			if (!i.ok || !n?.ok)
				throw Error(
					n?.error ?? `Evaluation could not start (HTTP ${i.status})`,
				);
			await this.waitForEval(n.startedAt ?? Date.now());
		} catch (i) {
			this.err = i instanceof Error ? i.message : String(i);
		} finally {
			this.busy = !1;
		}
	}
	async waitForEval(i) {
		this.busy = !0;
		const n = Date.now() + 135000;
		while (this.isConnected && Date.now() < n) {
			const o = await fetch(`/api/decisions/${this.eventId}/evals`, {
				signal: AbortSignal.timeout(8000),
			});
			if (!o.ok)
				throw Error(`Evaluation status unavailable (HTTP ${o.status})`);
			const l = await o.json();
			if ((this.apply(l.evals ?? []), l.status?.error))
				throw Error(l.status.error);
			if (!l.status?.running) {
				if (this.latest && this.latest.ts >= i) return;
				throw Error("Evaluation stopped without a result — retry");
			}
			await new Promise((c) => setTimeout(c, 1500));
		}
		if (this.isConnected) throw Error("Evaluation is taking too long — retry");
	}
	when(i) {
		const n = new Date(i),
			o = (d) => String(d).padStart(2, "0"),
			l = -n.getTimezoneOffset(),
			c = Math.abs(l),
			a = `${o(n.getUTCHours())}:${o(n.getUTCMinutes())}:${o(n.getUTCSeconds())}Z`,
			u = `${o(n.getHours())}:${o(n.getMinutes())} UTC${l >= 0 ? "+" : "-"}${o(Math.floor(c / 60))}:${o(c % 60)}`;
		return `${a} (${u})`;
	}
	render() {
		return e`
			<div class="row">
				<button
					?disabled=${this.busy}
					@click=${this.evaluate}
					type="button"
				>
					${this.busy ? "evaluating…" : "re-evaluate"}
				</button>
				<span class="cnt">
					${this.count}
					${this.count === 1 ? "evaluation" : "evaluations"}
				</span>
			</div>
			${this.err ? e`<output class="err">${this.err}</output>` : ""}
			${
				this.latest
					? e`<output>
						${this.when(this.latest.ts)} — ${this.latest.text}
					</output>`
					: ""
			}
		`;
	}
}
customElements.define("klh-decision-eval", v);
function b() {
	const i = document.querySelectorAll(".dec[data-id]");
	for (const n of i) {
		if (n.querySelector("klh-decision-eval")) continue;
		const o = n.querySelector(".dec-actions") ?? n,
			l = document.createElement("klh-decision-eval");
		l.setAttribute("event-id", n.getAttribute("data-id") ?? ""),
			o.appendChild(l);
	}
}
var y = new MutationObserver(b);
function f() {
	const i = document.querySelector("#decisions");
	if (!i) {
		setTimeout(f, 300);
		return;
	}
	y.observe(i, { childList: !0, subtree: !0 }), b();
}
f();
