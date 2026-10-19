import{r,e,t,s}from"./lit-sq0mv1by.js";import{a}from"./lit-aqxetgnz.js";var p=(n)=>{if(n===null||!Number.isFinite(n))return"—";if(Math.abs(n)>=1e6)return`${(n/1e6).toFixed(1)}M`;if(Math.abs(n)>=1000)return`${(n/1000).toFixed(1)}k`;return String(n)},b=(n)=>n===null?"unknown":n<90?`${n}s`:`${Math.round(n/60)}m`,f=(n)=>{if(n===null)return 1;if(n>=100)return 4;if(n>=20)return 3;if(n>=5)return 2;return 1},y=r`
	.hrow {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: baseline;
		padding: 3px 0;
	}
	.hname {
		min-width: 16ch;
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.unknown,
	.legend {
		color: var(--klh-dim);
		font-size: 10.5px;
	}
	.unknown {
		font-style: italic;
	}
	.hot {
		color: var(--klh-danger);
	}
	.live {
		color: var(--klh-accent);
	}
`,v=(n)=>Math.max(0,Math.round((Date.now()-Date.parse(n))/1000)),d=(n)=>n.gateway?e`<p>
				<span class="hname">local spoke</span>
				<span class=${n.gateway.state==="up"?"live":"hot"}>
					${n.gateway.state}</span
				>
				<span class="unknown">· ${n.gateway.detail}</span>
			</p>`:e`<p>
				<span class="hname">local spoke</span>
				<span class="unknown">not in the probe map</span>
			</p>`,R=(n)=>e`
	<div class="hrow">
		<span class="hname">hubs (observed)</span>
		${n.hubs.length?t:e`<span class="unknown">no projection db wired here</span>`}
	</div>
	${n.hubs.map((o)=>e`<div class="hrow">
			<span class="hname">${o.source}</span>
			<span class="num">active ${o.active}</span>
			<span class="num">${o.requests} req</span>
			<span class="num ${o.errors>0?"hot":""}">${o.errors} err</span>
			<span class="unknown">obs age ${o.freshness.ageS===null?"unknown":`${o.freshness.ageS}s`} · seq ${o.freshness.lastSeq??"?"}</span>
		</div>`)}
	${n.hops.length?e`<div class="hrow">
				<span class="hname">forwarding edges</span>
				${n.hops.map((o)=>e`<span class="num">${o.origin||"local"} → ${o.peer} (${o.n})</span>`)}
			</div>`:t}
	${n.unsettled.length?e`<div class="hrow">
				<span class="hname">unsettled</span>
				${n.unsettled.map((o)=>e`<span class="num">${o.kind}: ${o.n}</span>`)}
			</div>`:t}`,x=(n)=>{let o=n.out60===null?null:Math.round(n.out60/60);return e`<div class="hrow">
		<span class="hname">${n.kind} · ${n.host??"unknown"}${n.port?`:${n.port}`:""}</span>
		<span class="num">${n.model??""}</span>
		<span class="num">${n.req60} req/60s</span>
		<span class="num ${o===null?"":o>=100?"hot":"live"}">
			${o===null?"tok/s unknown":`${o} tok/s`}
		</span>
		<span class="num">15m: ${n.req15} req · out ${p(n.out15)}</span>
		<span
			class="bar"
			style="width:${f(o)*14}px;background:var(--klh-edge)"
		></span>
	</div>`},_=(n)=>e`<div class="hrow">
	<span class="unknown">${n.ts.slice(11,19)}</span>
	<span class="title">${n.target_model??"model unknown"}</span>
	<span class="unknown" title=${n.lane||"No lane attribution"}>${n.lane?`lane ${n.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
	<span class="num">${n.target_kind??"?"} ${n.target_host??""}</span>
	<span class="num">${n.duration_ms===null?"—":`${n.duration_ms}ms`}</span>
	<span class="num">in ${p(n.in_tok)} · out ${p(n.out_tok)}</span>
</div>`,T=(n)=>{let o=n.throughput.buckets.slice(0,12).reverse(),i=Math.max(1,...n.throughput.buckets.map((l)=>l.out_tok));return e`<p class="hrow">
			<span class="hname">window 15m</span>
			<span class="num">${n.throughput.window.requests} req</span>
			<span class="num">in ${p(n.throughput.window.in_tok)}</span>
			<span class="num">out ${p(n.throughput.window.out_tok)} tok</span>
			${n.observations.available?t:e`<span class="unknown">observations: not collected here</span>`}
		</p>
		<div class="hrow">
			<span class="hname">hour buckets</span>
			${o.map((l)=>e`<span
					class="bar"
					style="width:${Math.max(2,Math.round(l.out_tok/i*32))}px;background:var(--klh-edge)"
					title="${l.hour} · out ${p(l.out_tok)} tok"
				></span>`)}
		</div>`},C=(n)=>{let o=n.network;if(!o.ok)return e`${d(n)}
			<p class="unknown">${o.reason}</p>`;return e`${d(n)}
		${T(o)}
		${R(o)}
		${o.throughput.interfaces.length?o.throughput.interfaces.map(x):e`<div class="hrow">
					<span class="hname">interfaces</span>
					<span class="unknown">no settled traffic in window</span>
				</div>`}
		${o.routes.length?o.routes.map(_):e`<div class="hrow">
					<span class="hname">routes</span>
					<span class="unknown">none settled yet</span>
				</div>`}
		<p class="legend">
			edge width 1-4px = measured output tok/s (60s): ≥100 → 4 · ≥20 → 3 ·
			≥5 → 2 · else 1 · null = unknown (gray), never zero
		</p>`},N=async()=>{try{let n=await fetch("/api/console/network",{cache:"no-store"});if(!n.ok)return null;return await n.json()}catch{return null}};class c extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a,y];live=null;err="";timer=null;constructor(){super();this.heading="",this.data=null}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),1e4)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){let n=await N();if(n)this.live=n,this.err="";else this.err="refresh failed — last known values shown"}render(){let n=this.live??this.data;if(!n)return e`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;let o=this.err?e`<p class="unknown">${this.err}</p>`:t;return e`<h2>${this.heading} · live ${b(v(n.ts))}</h2>
			${o}${C(n)}`}}customElements.define("klh-network-card",c);var u=(n,o)=>n.flatMap((i,l)=>l?[e`${o}`,i]:[i]);class h extends s{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;if(n.kind==="missing")return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no routing-policy.yaml found on the belt chain (BELT_POLICY/
					BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)
				</p>`;if(n.kind==="no-gateway")return e`<h2>${this.heading}</h2>
				<p class="dimpl">policy resolved but no gateway section parsed</p>`;if(n.kind==="error")return e`<h2>${this.heading}</h2>
				<div class="errbox">
					resolved ${n.path} does not parse: ${n.error}
				</div>`;let o=n.gateway;return e`<h2>${this.head(n.path,n.source)}</h2>
			${o?e`
						<div class="knobs">
							<span class="kchip">num_retries: <b>${o.num_retries}</b></span>
							<span class="kchip">
								allowed_fails: <b>${o.allowed_fails}</b>
							</span>
							<span class="kchip">
								cooldown_time: <b>${o.cooldown_time}s</b>
							</span>
						</div>
						${this.compact?t:this.ladder(o.fallbacks)}
					`:t}${this.foot?e`<p class="cfoot">${this.foot}</p>`:t}`}head(n,o){let i=this.heading;if(n)i+=` · ${n}`;if(o)i+=` · source: ${o}`;return i}ladder(n){let o=Object.entries(n);if(this.compact&&o.length)return e`<span class="kchip">
				ladder: <b>${u(this.chips(o)," · ")}</b>
			</span>`;if(this.compact)return e`${t}`;return e`<table class="ct ladder">
			<thead>
				<tr>
					<th>model</th>
					<th>fallback ladder (order = priority)</th>
				</tr>
			</thead>
			<tbody>
				${o.map((i)=>e`<tr>
						<td><b>${i[0]}</b></td>
						<td>${u(this.pills(i[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(n){return n.map((o)=>e`${o[0]} → ${o[1].length} tiers`)}pills(n){return n.map((o,i)=>e`<span class="pill">${i+1}. ${o}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",h);class m extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;if(!n.groups)return e`<h2>Upstream pool</h2>
				<p class="dimpl">
					upstreams.yaml unreadable — the ladder above still applies
				</p>`;return e`<h2>${this.heading} · ${n.source}</h2>${this.table(n.groups)}`}table(n){return e`<table class="ct">
			<thead>
				<tr>
					<th>group</th>
					<th>deployments</th>
					<th>state</th>
					<th>source</th>
				</tr>
			</thead>
			<tbody>
				${n.map((o)=>this.row(o))}
			</tbody>
		</table>
		<p class="cfoot">
			Deployment counts merge the fleet default with machine overrides.
			Reachability is shown by the endpoint checks above.
		</p>`}row(n){let o=n.dormant?e`<span class="dimpl">dormant</span>`:e`<span>configured</span>`;return e`<tr>
			<td><b>${n.name}</b></td>
			<td class="num">${n.tiers}</td>
			<td>${o}</td>
			<td>${n.source}</td>
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",m);class g extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="Registered services",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(n)}`}body(n){return e`<table class="ct">
			<thead>
				<tr>
					<th>Service</th>
					<th>Scope</th>
					<th>Upstream</th>
					<th>Observation</th>
				</tr>
			</thead>
			<tbody>
				${n.rows.map((o)=>this.row(o))}
			</tbody>
		</table>
		<p class="cfoot">
			Route registration is configuration; local endpoint evidence is shown
			below. <a href="https://bar.local/">Inspect Caddy checks and mDNS
			claims</a>
		</p>`}row(n){return e`<tr>
			<td><a href="https://${n.name}.local/">${n.name}.local</a></td>
			<td><span class="pill">${n.scope}</span></td>
			<td class="mono">${n.upstream}</td>
			<td>${n.monitored}</td>
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",g);class w extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(n)}`}body(n){if(n.error)return e`<div class="errbox">
				current file does not parse: ${n.error}
			</div>`;return e`<div class="knobs">
			${n.knobs.map((o)=>e`<span class="kchip">${o.k}: <b>${o.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",w);class k extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a,r`
		.auditrow { border-top:1px solid var(--klh-rule); font-size:11.5px; }
		.auditrow summary { display:flex; gap:10px; align-items:baseline; padding:5px 0; cursor:pointer; list-style:none; }
		.auditrow summary::-webkit-details-marker { display:none; }
		.auditrow summary::before { content:'+'; color:var(--klh-accent); }
		.auditrow[open] summary::before { content:'−'; }
		.auditrow .when { margin-left:auto; color:var(--klh-dim); white-space:nowrap; }
		.auditrow .detail { padding:2px 12px 9px; color:var(--klh-ink-2); overflow-wrap:anywhere; }
		.auditolder { border-top:1px solid var(--klh-rule); margin-top:7px; padding-top:7px; }
		.auditolder > summary { cursor:pointer; color:var(--klh-accent); font:11px var(--klh-font-mono); }
	`];constructor(){super();this.heading="admin audit",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;if(!n.rows.length)return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no admin actions recorded yet — settings/policy applies and key
					revocations land here
				</p>`;let o=n.rows.slice(0,5),i=n.rows.slice(5);return e`<h2>${this.heading} · ${n.rows.length} recent actions</h2>
			${o.map((l)=>this.chip(l))}
			${i.length?e`<details class="auditolder"><summary>Earlier actions (${i.length})</summary>${i.map((l)=>this.chip(l))}</details>`:t}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`}chip(n){return e`<details class="auditrow">
			<summary><b>${n.action}</b><span>${n.actor}</span><span class="when mono">${n.when}</span></summary>
			<div class="detail">${n.target??"—"}${n.detail?e`<br />${n.detail}`:t}</div>
		</details>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",k);
