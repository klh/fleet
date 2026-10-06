import{r,e,s}from"./lit-ca3y6nz3.js";import{i}from"./lit-rhcqwe98.js";var u=(t)=>t.state??(t.up?"up":"down"),d=(t,o=Date.now())=>{let a=u(t),l=!!t.observation&&!i(t.observation,o),n=t.recovery,c=!l&&a!=="up"&&a!=="idle"&&n!==null;return{badge:l?"STALE":a==="idle"?"IDLE":a==="up"?"UP":a==="degraded"?"DEGRADED":"DOWN",tone:l?"dim":a==="idle"?"dim":a==="up"?"ok":a==="degraded"?"warn":"bad",where:n?.probe.kind==="launchd"?"launchd":n?.probe.kind==="http"?`:${n.probe.port}${n.probe.path}`:`:${t.port}`,showRecovery:c,open:!l&&a==="down",saw:l?`Last known ${a}: ${t.detail}. Current state unknown.`:t.detail,what:n?.what??"",causes:c&&n?n.causes:[],steps:c&&n?n.recovery:[]}};class p{probe;busy=!1;err=null;constructor(t){this.probe=t}async reprobe(t){if(this.busy)return this.probe;this.busy=!0,this.err=null;try{let o=await t(`/api/services/probe?id=${encodeURIComponent(this.probe.id)}`),a=await o.json();if(!o.ok||!a.ok||!a.service)throw Error(a.error??`HTTP ${o.status}`);this.probe=a.service}catch(o){this.err=o instanceof Error?o.message:String(o)}finally{this.busy=!1}return this.probe}}var h=15000;class b extends s{static properties={probe:{type:Object},busy:{state:!0},err:{state:!0},copied:{state:!0},now:{state:!0}};static styles=r`
		:host {
			display: block;
			background: var(--klh-surface, #1c1b19);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.1));
			border-radius: 3px;
			padding: 8px 12px;
			margin: 0 0 8px;
			font: 12px/1.45 ui-sans-serif, system-ui;
			color: var(--klh-ink, #e8e6e1);
		}
		.head {
			display: flex;
			gap: 10px;
			align-items: baseline;
			flex-wrap: wrap;
		}
		.badge {
			font-weight: 700;
			letter-spacing: 0.06em;
			min-width: 76px;
		}
		.ok {
			color: var(--klh-ok, #5c7a35);
		}
		.warn {
			color: var(--klh-accent, #d8900f);
		}
		.bad {
			color: var(--klh-danger-ink, #c96a4f);
		}
		.name {
			font-weight: 600;
		}
		.dim {
			color: var(--klh-dim, #98958e);
		}
		.saw {
			flex: 1 1 200px;
		}
		button {
			font: inherit;
			font-size: 11px;
			cursor: pointer;
			padding: 2px 9px;
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.22));
			border-radius: 2px;
			background: var(--klh-bg, #141413);
			color: var(--klh-ink, #e8e6e1);
		}
		button:hover,
		button:focus-visible {
			border-color: var(--klh-accent, #d8900f);
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
		details {
			margin-top: 8px;
			border-left: 2px solid var(--klh-accent, #d8900f);
			padding-left: 10px;
		}
		summary {
			cursor: pointer;
			color: var(--klh-accent, #d8900f);
			font-weight: 600;
		}
		.what {
			margin: 6px 0;
		}
		h4 {
			margin: 8px 0 3px;
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
		}
		ul,
		ol {
			margin: 0;
			padding-left: 18px;
		}
		li {
			margin: 2px 0;
		}
		.step {
			display: flex;
			gap: 8px;
			align-items: center;
			margin-top: 2px;
		}
		code {
			flex: 1;
			background: var(--klh-bg, #141413);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			padding: 3px 7px;
			font: 11px/1.5 ui-monospace, Menlo, monospace;
			white-space: pre-wrap;
			word-break: break-all;
			user-select: all;
		}
		output {
			display: block;
			margin-top: 4px;
			color: var(--klh-danger-ink, #c96a4f);
		}
	`;ctl=null;timer=null;clock=null;constructor(){super();this.probe=null,this.busy=!1,this.err=null,this.copied=-1,this.now=Date.now()}connectedCallback(){super.connectedCallback(),this.clock=setInterval(()=>{this.now=Date.now()},1000),this.timer=setInterval(()=>{if(this.probe&&!document.hidden)this.reprobe()},h)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer);if(this.clock)clearInterval(this.clock);this.timer=null}controller(){if(!this.probe)return null;if(!this.ctl||this.ctl.probe.id!==this.probe.id)this.ctl=new p(this.probe);return this.ctl.probe=this.probe,this.ctl}async reprobe(){let t=this.controller();if(!t||this.busy)return;this.busy=!0,this.probe=await t.reprobe((o)=>fetch(o,{cache:"no-store",signal:AbortSignal.timeout(5000)})),this.err=t.err,this.busy=!1}async copy(t,o){try{await navigator.clipboard.writeText(o)}catch{let a=document.createElement("textarea");a.value=o,a.setAttribute("readonly",""),a.style.position="fixed",a.style.opacity="0",this.renderRoot.appendChild(a),a.select(),document.execCommand("copy"),a.remove()}this.copied=t,setTimeout(()=>{if(this.copied===t)this.copied=-1},1500)}when(t){let o=new Date(t);return Number.isNaN(o.getTime())?"":o.toLocaleTimeString()}render(){let t=this.probe;if(!t)return e``;let o=d(t,this.now);return e`
			<div class="head">
				<span class="badge ${o.tone}">${o.badge}</span>
				<span class="name">${t.name}</span>
				<span class="dim">${o.where}</span>
				<span class="saw dim">${o.saw}</span>
				<span class="dim">${this.when(t.probed_at)}</span>
				<button
					type="button"
					?disabled=${this.busy}
					@click=${this.reprobe}
				>
					${this.busy?"probing…":"re-probe"}
				</button>
			</div>
			${t.observation?e`<div class="dim">Evidence: ${t.observation.source} · ${t.observation.kind} · ${t.observation.scope} · expires ${this.when(new Date(t.observation.expiresAt).toISOString())}</div>`:""}
			${this.err?e`<output>re-probe failed: ${this.err}</output>`:""}
			${o.showRecovery?this.recovery(o):""}
		`}recovery(t){return e`
			<details ?open=${t.open}>
				<summary>how to recover</summary>
				<p class="what">${t.what}</p>
				<h4>what the probe saw</h4>
				<div>${t.saw}</div>
				<h4>likely cause</h4>
				<ul>
					${t.causes.map((o)=>e`<li>${o}</li>`)}
				</ul>
				<h4>recover — run in order, then re-probe</h4>
				<ol>
					${t.steps.map((o,a)=>e`<li>
							<div class="dim">${o.label}</div>
							<div class="step">
								<code>${o.cmd}</code>
								<button
									type="button"
									aria-label="copy: ${o.cmd}"
									@click=${()=>this.copy(a,o.cmd)}
								>
									${this.copied===a?"copied":"copy"}
								</button>
							</div>
						</li>`)}
				</ol>
			</details>
		`}}if(!customElements.get("klh-service-row"))customElements.define("klh-service-row",b);
