import{r,e,s}from"./lit-ca3y6nz3.js";import{i}from"./lit-rhcqwe98.js";var m={"--klh-bg":["#141413","#f6f4ef"],"--klh-field":["#121110","#ffffff"],"--klh-panel":["#171614","#fbfaf7"],"--klh-surface":["#1c1b19","#ffffff"],"--klh-overlay":["#1a1917","#ffffff"],"--klh-surface-hi":["#232220","#ece9e2"],"--klh-ink":["#e8e6e1","#1c1b19"],"--klh-ink-2":["#c3c2b7","#3b3934"],"--klh-ink-3":["#a5a29a","#55524b"],"--klh-dim":["#98958e","#6b675f"],"--klh-accent":["#d8900f","#a86a00"],"--klh-on-accent":["#141413","#ffffff"],"--klh-accent-bg":["#221f14","#fbf1dc"],"--klh-accent-wash":["rgba(216,144,15,.12)","rgba(168,106,0,.10)"],"--klh-warm":["#221f1c","#f8efe4"],"--klh-danger":["#af2f12","#af2f12"],"--klh-danger-ink":["#c96a4f","#a3361a"],"--klh-danger-bg":["#221512","#fbe9e4"],"--klh-danger-edge":["rgba(175,47,18,.6)","rgba(175,47,18,.5)"],"--klh-danger-wash":["rgba(175,47,18,.16)","rgba(175,47,18,.10)"],"--klh-ok":["#5c7a35","#5c7a35"],"--klh-ok-ink":["#7da652","#3f6a1c"],"--klh-ok-hi":["#a5c78a","#35591a"],"--klh-ok-bg":["#1a2015","#eaf3e0"],"--klh-ok-wash":["rgba(92,122,53,.18)","rgba(92,122,53,.14)"],"--klh-info":["#8cbbad","#2f7a68"],"--klh-wash":["rgba(255,255,255,.03)","rgba(0,0,0,.025)"],"--klh-edge-faint":["rgba(255,255,255,.07)","rgba(0,0,0,.07)"],"--klh-edge-soft":["rgba(255,255,255,.10)","rgba(0,0,0,.10)"],"--klh-edge":["rgba(255,255,255,.12)","rgba(0,0,0,.13)"],"--klh-edge-mid":["rgba(255,255,255,.18)","rgba(0,0,0,.18)"],"--klh-edge-strong":["rgba(255,255,255,.24)","rgba(0,0,0,.24)"],"--klh-edge-hover":["rgba(255,255,255,.4)","rgba(0,0,0,.4)"],"--klh-rule":["#2c2c2a","#e2dfd8"],"--klh-shadow":["rgba(0,0,0,.5)","rgba(0,0,0,.14)"],"--klh-chart-grid":["#2c2c2a","#e2dfd8"],"--klh-chart-hair":["#383835","#cfcbc2"],"--klh-chart-axis":["#898781","#6b675f"]},u={"--klh-font-mono":"ui-monospace,SFMono-Regular,Menlo,Consolas,monospace","--klh-font-sans":'-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif',"--klh-text-xs":"10px","--klh-text-sm":"11px","--klh-text-md":"12.5px","--klh-text-lg":"13px","--klh-text-xl":"14px","--klh-space-1":"2px","--klh-space-2":"4px","--klh-space-3":"8px","--klh-space-4":"12px","--klh-space-5":"16px","--klh-space-6":"20px","--klh-space-7":"28px","--klh-radius":"2px","--klh-radius-lg":"3px"};var p=(t)=>Object.entries(m).map(([a,o])=>`${a}:${o[t]};`).join(""),f=Object.entries(u).map(([t,a])=>`${t}:${a};`).join(""),v=`:root{${f}}:root,:root[data-theme="dark"]{color-scheme:dark;${p(0)}}:root[data-theme="light"]{color-scheme:light;${p(1)}}@media (prefers-color-scheme: light){:root:not([data-theme]){color-scheme:light;${p(1)}}}`;var w=`<style id="klh-theme-tokens" data-klh-theme="1.2.0">${v}</style><script>(function(){var K="klh-theme",d=document.documentElement,mq=window.matchMedia?window.matchMedia("(prefers-color-scheme: light)"):null;
function pref(){var v=null;try{v=window.localStorage.getItem(K);}catch(e){}return v==="light"||v==="dark"?v:"system";}
function resolve(p){return p==="light"||p==="dark"?p:(mq&&mq.matches?"light":"dark");}
function apply(){var p=pref(),t=resolve(p);d.setAttribute("data-theme",t);d.setAttribute("data-theme-pref",p);
if(typeof CustomEvent==="function"&&document.dispatchEvent)document.dispatchEvent(new CustomEvent("klh-themechange",{detail:{theme:t,pref:p}}));return t;}
function set(p){try{if(p==="light"||p==="dark")window.localStorage.setItem(K,p);else window.localStorage.removeItem(K);}catch(e){}return apply();}
apply();
if(mq){var on=function(){if(pref()==="system")apply();};if(mq.addEventListener)mq.addEventListener("change",on);else if(mq.addListener)mq.addListener(on);}
if(window.addEventListener)window.addEventListener("storage",function(e){if(e.key===K)apply();});
window.klhTheme={pref:pref,resolve:resolve,apply:apply,set:set};})();</script>`;var h=(t)=>t.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu,"").trim();var b=(t)=>t.state??(t.up?"up":"down"),k=(t,a=Date.now())=>{let o=b(t),n=!!t.observation&&!i(t.observation,a),l=t.recovery,c=!n&&o!=="up"&&o!=="idle"&&l!==null;return{badge:n?"STALE":o==="idle"?"IDLE":o==="up"?"UP":o==="degraded"?"DEGRADED":"DOWN",tone:n?"dim":o==="idle"?"dim":o==="up"?"ok":o==="degraded"?"warn":"bad",where:l?.probe.kind==="launchd"?"launchd":l?.probe.kind==="http"?`:${l.probe.port}${l.probe.path}`:`:${t.port}`,showRecovery:c,open:!n&&o==="down",saw:n?`Last known ${o}: ${t.detail}. Current state unknown.`:t.detail,what:l?.what??"",causes:c&&l?l.causes:[],steps:c&&l?l.recovery:[]}};class d{probe;busy=!1;err=null;constructor(t){this.probe=t}async reprobe(t){if(this.busy)return this.probe;this.busy=!0,this.err=null;try{let a=await t(`/api/services/probe?id=${encodeURIComponent(this.probe.id)}`),o=await a.json();if(!a.ok||!o.ok||!o.service)throw Error(o.error??`HTTP ${a.status}`);this.probe=o.service}catch(a){this.err=a instanceof Error?a.message:String(a)}finally{this.busy=!1}return this.probe}}var x=15000;class g extends s{static properties={probe:{type:Object},busy:{state:!0},err:{state:!0},copied:{state:!0},now:{state:!0}};static styles=r`
		:host {
			display: block;
			background: transparent;
			border-bottom: 1px solid var(--klh-edge);
			padding: var(--klh-space-4) 0;
			font: var(--klh-text-lg)/1.6 var(--klh-font-sans);
			color: var(--klh-ink, #e8e6e1);
		}
		.head {
			display: grid;
			grid-template-columns: 92px minmax(180px, 2fr) minmax(150px, 1fr) auto;
			gap: var(--klh-space-3) var(--klh-space-5);
			align-items: start;
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
		.tags {display:flex;gap:var(--klh-space-3);align-items:center;flex-wrap:wrap;margin:var(--klh-space-2) 0;}
		.tag {border:1px solid var(--klh-edge);border-radius:var(--klh-radius);padding:0 var(--klh-space-3);font:var(--klh-text-xs)/1.8 var(--klh-font-mono);color:var(--klh-ink-3);}
		@media(max-width:760px){.head{grid-template-columns:80px minmax(0,1fr) auto}.saw{grid-column:2 / -1}.actions{grid-column:3;grid-row:1}}
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
	`;ctl=null;timer=null;clock=null;constructor(){super();this.probe=null,this.busy=!1,this.err=null,this.copied=-1,this.now=Date.now()}connectedCallback(){super.connectedCallback(),this.clock=setInterval(()=>{this.now=Date.now()},1000),this.timer=setInterval(()=>{if(this.probe&&!document.hidden)this.reprobe()},x)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer);if(this.clock)clearInterval(this.clock);this.timer=null}controller(){if(!this.probe)return null;if(!this.ctl||this.ctl.probe.id!==this.probe.id)this.ctl=new d(this.probe);return this.ctl.probe=this.probe,this.ctl}async reprobe(){let t=this.controller();if(!t||this.busy)return;this.busy=!0,this.probe=await t.reprobe((a)=>fetch(a,{cache:"no-store",signal:AbortSignal.timeout(5000)})),this.err=t.err,this.busy=!1}async copy(t,a){try{await navigator.clipboard.writeText(a)}catch{let o=document.createElement("textarea");o.value=a,o.setAttribute("readonly",""),o.style.position="fixed",o.style.opacity="0",this.renderRoot.appendChild(o),o.select(),document.execCommand("copy"),o.remove()}this.copied=t,setTimeout(()=>{if(this.copied===t)this.copied=-1},1500)}when(t){let a=new Date(t);return Number.isNaN(a.getTime())?"":a.toLocaleTimeString()}render(){let t=this.probe;if(!t)return e``;let a=k(t,this.now);return e`
			<div class="head">
				<span class="badge ${a.tone}">${a.badge}</span>
				<div class="identity"><span class="name">${h(t.name)}</span><span class="dim">${a.where}</span><div class="tags"><span class="tag">${t.id.startsWith("swarm-")||t.id.startsWith("kev-")?"Model":t.id.includes("gateway")||t.id.startsWith("buckle-")||t.id.startsWith("litellm-")?"Gateway":"Service"}</span><span class="tag">${t.observation?.scope??"Local machine"}</span></div></div>
				<span class="saw dim">${a.saw}</span>
				<div class="actions">
				<button
					type="button"
					?disabled=${this.busy}
					@click=${this.reprobe}
				>
					${this.busy?"probing…":"re-probe"}
				</button>
				<div class="dim">${this.when(t.probed_at)}</div></div>
			</div>
			${t.observation?e`<div class="dim">Evidence: ${t.observation.source} · ${t.observation.kind} · ${t.observation.scope} · expires ${this.when(new Date(t.observation.expiresAt).toISOString())}</div>`:""}
			${this.err?e`<output>re-probe failed: ${this.err}</output>`:""}
			${a.showRecovery?this.recovery(a):""}
		`}recovery(t){return e`
			<details ?open=${t.open}>
				<summary>how to recover</summary>
				<p class="what">${t.what}</p>
				<h4>what the probe saw</h4>
				<div>${t.saw}</div>
				<h4>likely cause</h4>
				<ul>
					${t.causes.map((a)=>e`<li>${a}</li>`)}
				</ul>
				<h4>recover — run in order, then re-probe</h4>
				<ol>
					${t.steps.map((a,o)=>e`<li>
							<div class="dim">${a.label}</div>
							<div class="step">
								<code>${a.cmd}</code>
								<button
									type="button"
									aria-label="copy: ${a.cmd}"
									@click=${()=>this.copy(o,a.cmd)}
								>
									${this.copied===o?"copied":"copy"}
								</button>
							</div>
						</li>`)}
				</ol>
			</details>
		`}}if(!customElements.get("klh-service-row"))customElements.define("klh-service-row",g);
