import{LitElement as u,css as b,html as a,nothing as s}from"./lit-shared.js";function c(e,r=Date.now()){return!!e&&Number.isFinite(e.observedAt)&&Number.isFinite(e.expiresAt)&&e.observedAt<=r+5000&&e.expiresAt>e.observedAt&&r<e.expiresAt}var g=(e)=>{if(!e)return"";let r=new Date(e);if(Number.isNaN(r.getTime()))return String(e);let o=(h)=>String(h).padStart(2,"0"),n=-r.getTimezoneOffset(),i=Math.abs(n),l=n>=0?"+":"-",t=r.toISOString().replace(/\.\d{3}Z$/,"Z"),p=`local ${o(r.getHours())}:${o(r.getMinutes())}, UTC${l}${o(Math.floor(i/60))}:${o(i%60)}`;return`${t} (${p})`},m=(e)=>{let r=new Date(e??Number.NaN);if(Number.isNaN(r.getTime()))return"unknown";let o=(n)=>String(n).padStart(2,"0");return`${o(r.getDate())}.${o(r.getMonth()+1)}.${String(r.getFullYear()).slice(-2)} ${o(r.getHours())}:${o(r.getMinutes())}`};class d extends u{static properties={snapshot:{state:!0},error:{state:!0},pending:{state:!0},query:{state:!0},attention:{state:!0},now:{state:!0}};static styles=b`
		:host{display:block;max-width:1400px;margin:auto;padding:24px;box-sizing:border-box}
		*{box-sizing:border-box} nav{display:flex;gap:24px;flex-wrap:wrap;border-bottom:1px solid var(--klh-edge);padding-bottom:16px}
		a{color:var(--klh-ink);text-underline-offset:5px} a:hover{color:var(--klh-accent)} a[aria-current]{color:var(--klh-accent)}
		header{margin:24px 0 24px} h1{font-size:28px;margin:0} h2{font-size:18px;margin:28px 0 8px}
		p{margin:8px 0}.mut,small{color:var(--klh-ink-3)} .ok{color:var(--klh-ok-ink)} .bad{color:var(--klh-danger-ink)}
		.toolbar{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:20px 0}
		input,button{font:inherit;color:var(--klh-ink);background:transparent;border:1px solid var(--klh-edge);padding:8px 12px;border-radius:3px}
		input[type=checkbox]{accent-color:var(--klh-accent)} button{cursor:pointer}button:disabled{opacity:.6;cursor:wait}
		:focus-visible{outline:2px solid var(--klh-accent);outline-offset:4px} .notice{border-left:3px solid var(--klh-accent);padding:12px 16px}
		.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}
		th{text-align:left;font-size:12px;font-weight:400;color:var(--klh-ink-3);text-transform:uppercase;letter-spacing:.06em}
		td,th{padding:14px 18px 14px 0;border-bottom:1px solid var(--klh-edge);vertical-align:top}td small{display:block;font:var(--klh-text-sm)/1.6 var(--klh-font-mono)} td:last-child{padding-right:0}
		footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--klh-edge);color:var(--klh-ink-3);font-size:12px}
		@media(max-width:600px){:host{padding:16px}header{margin-top:24px}h1{font-size:24px}.toolbar{align-items:stretch}.toolbar label:first-child{width:100%}.toolbar input[type=search]{width:100%}}
	`;timer;clock;controller;constructor(){super();this.snapshot=null,this.error="",this.pending=!1,this.query="",this.attention=!1,this.now=Date.now()}connectedCallback(){super.connectedCallback(),this.refresh(),this.clock=setInterval(()=>{this.now=Date.now()},1000)}disconnectedCallback(){super.disconnectedCallback(),clearTimeout(this.timer),clearInterval(this.clock),this.controller?.abort()}async refresh(){if(this.pending)return;clearTimeout(this.timer),this.pending=!0,this.controller=new AbortController;let e=setTimeout(()=>this.controller?.abort(),6000);try{let r=await fetch("/api/status",{cache:"no-store",signal:this.controller.signal});if(!r.ok)throw Error(`Status request failed: HTTP ${r.status}`);let o=await r.json();if(!f(o))throw Error("Invalid status snapshot");this.snapshot=o,this.error=""}catch(r){this.error=r instanceof Error&&r.message?r.message:"Status request timed out"}finally{if(clearTimeout(e),this.pending=!1,this.isConnected)this.timer=setTimeout(()=>this.refresh(),3000)}}needsAttention(e){return!e.health.ok||!e.fragment||Boolean(e.dns.claimed&&!e.dns.alive)}render(){let e=this.snapshot,r=e?Math.max(0,Math.floor((this.now-Date.parse(e.ts))/1000)):0,o=Boolean(this.error)||!c(e?.observation,this.now),n=(e?.services??[]).filter((t)=>t.name.toLowerCase().includes(this.query.toLowerCase())&&(!this.attention||this.needsAttention(t))),i=(e?.services??[]).filter((t)=>t.health.ok).length,l=(e?.services??[]).filter((t)=>this.needsAttention(t)).length;return a`
			<header><h1>Local services</h1><p class="mut">Caddy routes, configured endpoint checks and mDNS registrations.</p>
			<p role="status" class=${o?"bad":"mut"}>${e?`${o?"Stale snapshot":"Last observation"} · ${r}s ago`:"Waiting for first observation"}${this.pending?" · refreshing":""}</p></header>
			${e?.observation?a`<p class="mut">Evidence: ${e.observation.source} · ${e.observation.scope} · expires <time title=${g(e.observation.expiresAt)}>${m(e.observation.expiresAt)}</time></p>`:s}
			${this.error?a`<p class="notice bad" role="alert">${this.error}. ${e?"Showing the last successful snapshot.":"No service state is available yet."}</p>`:s}
			${e?.error?a`<p class="notice bad" role="alert">${e.error}</p>`:s}
			<h2>Caddy front</h2>
			<p>${e?a`<span class=${e.caddy.listening?"ok":"bad"}>${e.caddy.listening?"TCP reachable on :80":"Not reachable on :80"}</span> <small title=${e.caddy.version||"version unavailable"}>· ${(e.caddy.version||"version unavailable").split(/\s+/)[0]}</small>`:"Waiting for observation"}</p>
			<p class="mut">TCP reachability does not verify HTTPS, authentication or a route. Open a service to check its front.</p>
			<h2>Registered services ${e?`(${e.services.length})`:""}</h2>
			${e?a`<p class="mut">${i} responding · ${l} need attention · ${e.services.length} registered</p>`:s}
			<p class="mut">A 2xx response passes the configured check. A homepage check establishes reachability; application readiness needs a dedicated endpoint or independent health probe.</p>
			<div class="toolbar"><label>Find service <input type="search" aria-label="Find service" .value=${this.query} @input=${(t)=>{this.query=t.target.value}}></label>
			<label><input type="checkbox" .checked=${this.attention} @change=${(t)=>{this.attention=t.target.checked}}> Needs attention</label>
			<button type="button" ?disabled=${this.pending} @click=${()=>this.refresh()}>Refresh now</button><a href="/api/status">Snapshot JSON</a></div>
			<div class="scroll" tabindex="0" role="region" aria-label="Registered services table"><table><thead><tr><th scope="col">Service</th><th scope="col">Probe target</th><th scope="col">Configured check</th><th scope="col">mDNS claim</th><th scope="col">Route fragment</th></tr></thead>
			<tbody>${n.map((t)=>a`<tr><td><a href=${`https://${t.name}.local/`}>${t.name}</a><small>${t.upstream?"Remote upstream":"Local upstream"}</small></td>
				<td>${t.target}<small>${t.health_path||"/"}</small></td>
				<td class=${t.health.ok?"ok":"bad"}>${t.health.ok?"Passed":t.health.reachable?"HTTP check failed":"Unreachable"}<small>${t.health.code?`HTTP ${t.health.code} · `:""}${t.health.ms}ms</small></td>
				<td class=${t.dns.claimed&&!t.dns.alive?"bad":"mut"}>${t.dns.claimed?t.dns.alive?"Claim process alive":"Claim process stopped":"Not requested"}<small>${t.dns.pid?`PID ${t.dns.pid}`:""}</small></td>
				<td class=${t.fragment?"":"bad"}>${t.fragment?"Present":"Missing"}<small>${(t.created_at||"").slice(0,10)}</small></td></tr>`)}
			${n.length?s:a`<tr><td colspan="5">${!e?"Waiting for service data.":e.error?"Registry data unavailable.":e.services.length?"No services match these filters.":"No services registered. Use klh-local register &lt;name&gt; --port N."}</td></tr>`}
			</tbody></table></div>
			<footer>${e?.registry||"~/.local/state/klh-local/registry.json"} · refresh 3s · <a href="https://github.com/klh/fleet/tree/main/packages/local">Documentation</a></footer>
		`}}function f(e){if(typeof e!=="object"||e===null)return!1;let r=e;return Array.isArray(r.services)&&typeof r.caddy==="object"&&r.caddy!==null&&Number.isFinite(Date.parse(String(r.ts)))}customElements.define("fleet-local-board",d);
