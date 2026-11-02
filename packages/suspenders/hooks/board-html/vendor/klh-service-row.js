import{n,e,r}from"./lit-f32c0cedac4dc611.js";import{w}from"./lit-693bd6923daa325f.js";import{p}from"./lit-ef400c34c419d6f5.js";import{a,o}from"./lit-372384db672af954.js";var v=(t)=>t.state??(t.up?"up":"down"),u=(t,i=Date.now())=>{let s=v(t),d=!!t.observation&&!p(t.observation,i),l=t.recovery,c=!d&&s!=="up"&&s!=="idle"&&l!==null;return{badge:d?"STALE":s==="idle"?"IDLE":s==="up"?"UP":s==="degraded"?"DEGRADED":"DOWN",tone:d?"dim":s==="idle"?"dim":s==="up"?"ok":s==="degraded"?"warn":"bad",where:l?.probe.kind==="launchd"?"launchd":l?.probe.kind==="http"?`:${l.probe.port}${l.probe.path}`:`:${t.port}`,showRecovery:c,open:!d&&s==="down",saw:d?`Last known ${s}: ${t.detail}. Current state unknown.`:t.detail,what:l?.what??"",causes:c&&l?l.causes:[],steps:c&&l?l.recovery:[]}};class h{probe;busy=!1;err=null;constructor(t){this.probe=t}async reprobe(t){if(this.busy)return this.probe;this.busy=!0,this.err=null;try{let i=await t(`/api/services/probe?id=${encodeURIComponent(this.probe.id)}`),s=await i.json();if(!i.ok||!s.ok||!s.service)throw Error(s.error??`HTTP ${i.status}`);this.probe=s.service}catch(i){this.err=i instanceof Error?i.message:String(i)}finally{this.busy=!1}return this.probe}}var m=15000;class b extends r{static properties={probe:{type:Object},busy:{state:!0},err:{state:!0},copied:{state:!0},now:{state:!0}};static styles=n`
		:host {
			display: block;
			background: transparent;
			border-bottom: 1px solid var(--klh-edge);
			padding: var(--klh-space-2) 0;
			font: var(--klh-text-md)/1.4 var(--klh-font-sans);
			color: var(--klh-ink, #e8e6e1);
		}
		.head {
			display: grid;
			grid-template-columns: 92px minmax(180px, 2fr) minmax(150px, 1fr) auto;
			gap: var(--klh-space-2) var(--klh-space-4);
			align-items: center;
		}
		.badge {
			font-weight: 700;
			letter-spacing: 0.06em;
			min-width: 76px;
		}
		.ok {
			color: var(--klh-ok-ink);
		}
		.warn {
			color: var(--klh-accent, #d8900f);
		}
		.bad {
			color: var(--klh-danger-ink, #c96a4f);
		}
		.name {
			font-weight: 600;
			overflow-wrap: anywhere;
		}
		.identity .dim {display:block;font:var(--klh-text-sm)/1.5 var(--klh-font-mono);}
		.tags {display:inline-flex;gap:var(--klh-space-2);align-items:center;flex-wrap:wrap;margin-left:var(--klh-space-2);}
		.tag {border:1px solid var(--klh-edge);border-radius:var(--klh-radius);padding:0 var(--klh-space-3);font:var(--klh-text-xs)/1.8 var(--klh-font-mono);color:var(--klh-ink-3);}
		@media(max-width:760px){.head{grid-template-columns:72px minmax(0,1fr) auto}.saw{grid-column:2 / -1}.actions{grid-column:3;grid-row:1}}
		.dim {
			color: var(--klh-dim, #98958e);
		}
		.saw {
			flex: 1 1 200px;
		}
		.actions { text-align:right; white-space:nowrap; }
		.evidence { position:relative; margin:var(--klh-space-1) 0 0; padding:0; border:0; font:var(--klh-text-xs)/1.4 var(--klh-font-mono); }
		.evidence summary { color:var(--klh-dim); font-weight:400; }
		.evidence[open] summary { color:var(--klh-accent); }
		.evidenceBody { position:absolute; right:0; z-index:5; width:min(300px,75vw); padding:var(--klh-space-3); border:1px solid var(--klh-edge-mid); background:var(--klh-surface-hi); box-shadow:0 3px 12px var(--klh-shadow); text-align:left; white-space:normal; }
		.evidenceBody div { margin:var(--klh-space-1) 0; overflow-wrap:anywhere; }
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
	`;ctl=null;timer=null;clock=null;constructor(){super();this.probe=null,this.busy=!1,this.err=null,this.copied=-1,this.now=Date.now()}connectedCallback(){super.connectedCallback(),this.clock=setInterval(()=>{this.now=Date.now()},1000),this.timer=setInterval(()=>{if(this.probe&&!document.hidden)this.reprobe()},m)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer);if(this.clock)clearInterval(this.clock);this.timer=null}controller(){if(!this.probe)return null;if(!this.ctl||this.ctl.probe.id!==this.probe.id)this.ctl=new h(this.probe);return this.ctl.probe=this.probe,this.ctl}async reprobe(){let t=this.controller();if(!t||this.busy)return;this.busy=!0,this.probe=await t.reprobe((i)=>fetch(i,{cache:"no-store",signal:AbortSignal.timeout(5000)})),this.err=t.err,this.busy=!1}async copy(t,i){try{await navigator.clipboard.writeText(i)}catch{let s=document.createElement("textarea");s.value=i,s.setAttribute("readonly",""),s.style.position="fixed",s.style.opacity="0",this.renderRoot.appendChild(s),s.select(),document.execCommand("copy"),s.remove()}this.copied=t,setTimeout(()=>{if(this.copied===t)this.copied=-1},1500)}when(t){return o(t)}fullWhen(t){return a(t)}render(){let t=this.probe;if(!t)return e``;let i=u(t,this.now);return e`
			<div class="head">
				<span class="badge ${i.tone}">${i.badge}</span>
				<div class="identity"><span class="name">${w(t.name)}</span><span class="dim">${i.where}</span><div class="tags"><span class="tag">${t.id.startsWith("swarm-")||t.id.startsWith("kev-")?"Model":t.id.includes("gateway")||t.id.startsWith("buckle-")||t.id.startsWith("litellm-")?"Gateway":"Service"}</span><span class="tag">${t.observation?.scope??"Local machine"}</span></div></div>
				<span class="saw dim">${i.saw}</span>
				<div class="actions">
				<button
					type="button"
					?disabled=${this.busy}
					@click=${this.reprobe}
				>
					${this.busy?"probing…":"re-probe"}
				</button>
					${t.observation?e`<details class="evidence"><summary title=${this.fullWhen(t.probed_at)}><time datetime=${t.probed_at}>${this.when(t.probed_at)}</time> · evidence</summary><div class="evidenceBody"><div>Source: ${t.observation.source}</div><div>Method: ${t.observation.kind}</div><div>Scope: ${t.observation.scope}</div><div>Expires: <time datetime=${new Date(t.observation.expiresAt).toISOString()} title=${this.fullWhen(new Date(t.observation.expiresAt).toISOString())}>${this.when(new Date(t.observation.expiresAt).toISOString())}</time></div></div></details>`:e`<time class="dim" datetime=${t.probed_at} title=${this.fullWhen(t.probed_at)}>${this.when(t.probed_at)}</time>`}</div>
			</div>
			${this.err?e`<output>re-probe failed: ${this.err}</output>`:""}
			${i.showRecovery?this.recovery(i):""}
		`}recovery(t){return e`
			<details ?open=${t.open}>
				<summary>how to recover</summary>
				<p class="what">${t.what}</p>
				<h4>what the probe saw</h4>
				<div>${t.saw}</div>
				<h4>likely cause</h4>
				<ul>
					${t.causes.map((i)=>e`<li>${i}</li>`)}
				</ul>
				<h4>recover — run in order, then re-probe</h4>
				<ol>
					${t.steps.map((i,s)=>e`<li>
							<div class="dim">${i.label}</div>
							<div class="step">
								<code>${i.cmd}</code>
								<button
									type="button"
									aria-label="copy: ${i.cmd}"
									@click=${()=>this.copy(s,i.cmd)}
								>
									${this.copied===s?"copied":"copy"}
								</button>
							</div>
						</li>`)}
				</ol>
			</details>
		`}}if(!customElements.get("klh-service-row"))customElements.define("klh-service-row",b);
