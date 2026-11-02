import{n,e,t,r}from"./lit-96e87015cf7d620b.js";import{a}from"./lit-5e71342cb6e5645a.js";import{p,h}from"./lit-0ea1c8bc45d251b9.js";var c=(s)=>{if(s===null||!Number.isFinite(s))return"—";if(Math.abs(s)>=1e6)return`${(s/1e6).toFixed(1)}M`;if(Math.abs(s)>=1000)return`${(s/1000).toFixed(1)}k`;return String(s)},R=(s)=>s===null?"unknown":s<90?`${s}s`:`${Math.round(s/60)}m`,T=(s)=>{if(s===null)return 1;if(s>=100)return 4;if(s>=20)return 3;if(s>=5)return 2;return 1},_=n`
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
	.netMetrics {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--klh-space-4);
		width: 100%;
		margin: var(--klh-space-4) 0;
		padding: var(--klh-space-4) 0;
		border-block: 1px solid var(--klh-edge);
	}
	.netMetric span { display:block; color:var(--klh-dim); font:var(--klh-text-xs) var(--klh-font-mono); }
	.netMetric strong { display:block; color:var(--klh-ink); font:600 18px/1.3 var(--klh-font-sans); font-variant-numeric:tabular-nums; }
	.hourPlot { width:100%; margin:var(--klh-space-4) 0; }
	.hourHeading { display:flex; justify-content:space-between; gap:var(--klh-space-4); margin-bottom:var(--klh-space-2); }
	.hourHeading .hname { min-width:0; }
	.hourSeries {
		display: flex;
		align-items: end;
		gap: 4px;
		width: 100%;
		height: 84px;
		border-bottom: 1px solid var(--klh-edge-mid);
	}
	.hourBar {
		flex: 1 1 0;
		min-width: 3px;
		max-height: 100%;
		background: var(--klh-accent);
	}
	.hourRange {
		width: 100%;
		display: flex;
		justify-content: space-between;
		font: var(--klh-text-xs) var(--klh-font-mono);
		color: var(--klh-dim);
	}
	.routes { margin-top:var(--klh-space-4); border-top:1px solid var(--klh-edge); padding-top:var(--klh-space-3); }
	.routes summary { cursor:pointer; color:var(--klh-ink); font-weight:600; }
	.routes summary:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
	.routesBody { overflow-x:auto; margin-top:var(--klh-space-3); }
	.routeHead, .routeRow { display:grid; grid-template-columns:78px minmax(140px,1fr) 110px 150px 80px 140px; gap:8px; min-width:780px; align-items:baseline; }
	.routeHead { color:var(--klh-dim); font:var(--klh-text-xs) var(--klh-font-mono); text-transform:uppercase; border-bottom:1px solid var(--klh-edge); }
	.routeRow { border-bottom:1px solid var(--klh-edge-faint); padding:var(--klh-space-2) 0; }
	@media(max-width:680px){.netMetrics{gap:var(--klh-space-2)}.netMetric strong{font-size:14px}.hourSeries{height:64px}}
`,N=(s)=>Math.max(0,Math.round((Date.now()-Date.parse(s))/1000)),g=(s)=>s.gateway?e`<p>
				<span class="hname">local spoke</span>
				<span class=${s.gateway.state==="up"?"live":"hot"}>
					${s.gateway.state}</span
				>
				<span class="unknown">· ${s.gateway.detail}</span>
			</p>`:e`<p>
				<span class="hname">local spoke</span>
				<span class="unknown">not in the probe map</span>
			</p>`,S=(s)=>{let o=s.lifecycle;if(!o.loss.length&&!o.rows.length)return e`<div class="hrow">
			<span class="hname">lifecycle</span>
			<span class="unknown">no projected events here</span>
		</div>`;return e`<div class="hrow">
		<span class="hname">lifecycle · loss</span>
		<span class="num">emitted ${o.totals.emitted}</span>
		<span class="num">observed ${o.totals.observed}</span>
		<span class="num ${o.totals.gaps>0?"hot":""}">gaps ${o.totals.gaps}</span>
	</div>
	${o.loss.filter((l)=>l.gaps>0).map((l)=>e`<div class="hrow">
				<span class="hname">${l.source}</span>
				<span class="num hot">gap ${l.gaps} of ${l.emitted}</span>
			</div>`)}
		<details class="routes">
			<summary>Lifecycle sample · ${o.rows.length}</summary>
			<div class="routesBody">
				${o.rows.length?o.rows.map((l)=>e`<div class="hrow">
							<time class="unknown" datetime=${new Date(l.admittedAt).toISOString()} title=${p(l.admittedAt)}>${h(l.admittedAt)}</time>
							<span class="title">${l.model??"?"}</span>
							<span class="unknown">${l.lane?`lane ${l.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
							<span class="num">${l.outcome??"in flight"}</span>
							<span class="num">${l.attemptsAgree?`att ${l.edgeAttempts??"?"} ok`:`att p${l.edgeAttempts??"?"}/l${l.ledgerAttempts??"?"} drift`}</span>
						</div>`):e`<p class="unknown">no joined rows</p>`}
			</div>
		</details>`},C=(s)=>e`
	<div class="hrow">
		<span class="hname">hubs (observed)</span>
		${s.hubs.length?t:e`<span class="unknown">no projection db wired here</span>`}
	</div>
	${s.hubs.map((o)=>e`<div class="hrow">
			<span class="hname">${o.source}</span>
			<span class="num">active ${o.active}</span>
			<span class="num">${o.requests} req</span>
			<span class="num ${o.errors>0?"hot":""}">${o.errors} err</span>
			<span class="unknown">obs age ${o.freshness.ageS===null?"unknown":`${o.freshness.ageS}s`} · seq ${o.freshness.lastSeq??"?"}</span>
		</div>`)}
	${s.hops.length?e`<div class="hrow">
				<span class="hname">forwarding edges</span>
				${s.hops.map((o)=>e`<span class="num">${o.origin||"local"} → ${o.peer} (${o.n})</span>`)}
			</div>`:t}
	${s.unsettled.length?e`<div class="hrow">
				<span class="hname">unsettled</span>
				${s.unsettled.map((o)=>e`<span class="num">${o.kind}: ${o.n}</span>`)}
			</div>`:t}
	${S(s)}`,D=(s)=>{let o=s.out60===null?null:Math.round(s.out60/60);return e`<div class="hrow">
		<span class="hname">${s.kind} · ${s.host??"unknown"}${s.port?`:${s.port}`:""}</span>
		<span class="num">${s.model??""}</span>
		<span class="num">${s.req60} req/60s</span>
		<span class="num ${o===null?"":o>=100?"hot":"live"}">
			${o===null?"tok/s unknown":`${o} tok/s`}
		</span>
		<span class="num">15m: ${s.req15} req · out ${c(s.out15)}</span>
		<span
			class="bar"
			style="width:${T(o)*14}px;background:var(--klh-edge)"
		></span>
	</div>`},M=(s)=>e`<div class="routeRow">
	<time class="unknown" datetime=${s.ts} title=${p(s.ts)}>${h(s.ts)}</time>
	<span class="title">${s.target_model??"model unknown"}</span>
	<span class="unknown" title=${s.lane||"No lane attribution"}>${s.lane?`lane ${s.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
	<span class="num">${s.target_kind??"?"} ${s.target_host??""}</span>
	<span class="num">${s.duration_ms===null?"—":`${s.duration_ms}ms`}</span>
	<span class="num">in ${c(s.in_tok)} · out ${c(s.out_tok)}</span>
</div>`,u=(s)=>{let o=new Date(`${s}:00Z`);if(Number.isNaN(o.getTime()))return s;let l=(i)=>String(i).padStart(2,"0");return`${l(o.getDate())}.${l(o.getMonth()+1)} ${l(o.getHours())}:00`},O=(s)=>{let o=s.throughput.buckets.slice(0,12).reverse(),l=Math.max(1,...o.map((d)=>d.out_tok)),i=o[0],m=o[o.length-1];return e`<div class="netMetrics" aria-label="Last 15 minutes">
			<div class="netMetric"><span>requests · 15m</span><strong>${s.throughput.window.requests}</strong></div>
			<div class="netMetric"><span>input tokens · 15m</span><strong>${c(s.throughput.window.in_tok)}</strong></div>
			<div class="netMetric"><span>output tokens · 15m</span><strong>${c(s.throughput.window.out_tok)}</strong></div>
		</div>
		<p class="unknown">
			${s.observations.available?"Hub observations available":"Hub observations are not collected here"}
		</p>
		<div class="hourPlot">
			<div class="hourHeading"><span class="hname">Recorded output · last 12 hours</span><span class="unknown">peak ${c(l)} tok/hour</span></div>
				<div class="hourSeries" role="img" aria-label="Recorded output tokens by hour, oldest to newest">
					${o.map((d)=>e`<span class="hourBar"
							style="height:${d.out_tok?Math.max(2,Math.round(d.out_tok/l*80)):0}px"
							title="${u(d.hour)} · ${d.requests} req · out ${c(d.out_tok)} tok"
						></span>`)}
				</div>
				<div class="hourRange"><span>${i?u(i.hour):""}</span><span>${m?u(m.hour):""}</span></div>
		</div>`},E=(s)=>s.model_health.down.length===0?e`<div class="hrow">
				<span class="hname">model health</span>
				<span class="unknown">no DOWN groups in fresh facts</span>
			</div>`:e`<div class="hrow">
				<span class="hname">model health</span>
				${s.model_health.down.map((o)=>e`<span class="num hot">DOWN ${o}</span>`)}
			</div>`,j=(s)=>{let o=s.network;if(!o.ok)return e`${g(s)}
			<p class="unknown">${o.reason}</p>`;return e`${g(s)}
		${E(s)}
		${O(o)}
		${C(o)}
		${o.throughput.interfaces.length?o.throughput.interfaces.map(D):e`<div class="hrow">
					<span class="hname">interfaces</span>
					<span class="unknown">no settled traffic in window</span>
				</div>`}
		<details class="routes">
			<summary>Recent settled routes · ${o.routes.length}</summary>
			<div class="routesBody">
				<div class="routeHead"><span>Time</span><span>Model</span><span>Lane</span><span>Target</span><span>Latency</span><span>Tokens</span></div>
				${o.routes.length?o.routes.map(M):e`<p class="unknown">No settled routes yet</p>`}
			</div>
		</details>
		<p class="legend">
			edge width 1-4px = measured output tok/s (60s): ≥100 → 4 · ≥20 → 3 ·
			≥5 → 2 · else 1 · null = unknown (gray), never zero
		</p>`},P=async()=>{try{let s=await fetch("/api/console/network",{cache:"no-store"});if(!s.ok)return null;return await s.json()}catch{return null}};class k extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[a,_];live=null;err="";timer=null;constructor(){super();this.heading="",this.data=null}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),1e4)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){let s=await P();if(s)this.live=s,this.err="";else this.err="refresh failed — last known values shown"}render(){let s=this.live??this.data;if(!s)return e`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;let o=this.err?e`<p class="unknown">${this.err}</p>`:t;return e`<h2>${this.heading} · live ${R(N(s.ts))}</h2>
			${o}${j(s)}`}}customElements.define("klh-network-card",k);var w=(s,o)=>s.flatMap((l,i)=>i?[e`${o}`,l]:[l]);class v extends r{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;if(s.kind==="missing")return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no routing-policy.yaml found on the belt chain (BELT_POLICY/
					BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)
				</p>`;if(s.kind==="no-gateway")return e`<h2>${this.heading}</h2>
				<p class="dimpl">policy resolved but no gateway section parsed</p>`;if(s.kind==="error")return e`<h2>${this.heading}</h2>
				<div class="errbox">
					resolved ${s.path} does not parse: ${s.error}
				</div>`;let o=s.gateway;return e`<h2>${this.head(s.path,s.source)}</h2>
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
					`:t}${this.foot?e`<p class="cfoot">${this.foot}</p>`:t}`}head(s,o){let l=this.heading;if(s)l+=` · ${s}`;if(o)l+=` · source: ${o}`;return l}ladder(s){let o=Object.entries(s);if(this.compact&&o.length)return e`<span class="kchip">
				ladder: <b>${w(this.chips(o)," · ")}</b>
			</span>`;if(this.compact)return e`${t}`;return e`<table class="ct ladder">
			<thead>
				<tr>
					<th>model</th>
					<th>fallback ladder (order = priority)</th>
				</tr>
			</thead>
			<tbody>
				${o.map((l)=>e`<tr>
						<td><b>${l[0]}</b></td>
						<td>${w(this.pills(l[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(s){return s.map((o)=>e`${o[0]} → ${o[1].length} tiers`)}pills(s){return s.map((o,l)=>e`<span class="pill">${l+1}. ${o}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",v);class f extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;if(!s.groups)return e`<h2>Upstream pool</h2>
				<p class="dimpl">
					upstreams.yaml unreadable — the ladder above still applies
				</p>`;return e`<h2>${this.heading} · ${s.source}</h2>${this.table(s.groups)}`}table(s){return e`<table class="ct">
			<thead>
				<tr>
					<th>group</th>
					<th>deployments</th>
					<th>state</th>
					<th>source</th>
				</tr>
			</thead>
			<tbody>
				${s.map((o)=>this.row(o))}
			</tbody>
		</table>
		<p class="cfoot">
			Deployment counts merge the fleet default with machine overrides.
			Reachability is shown by the endpoint checks above.
		</p>`}row(s){let o=s.dormant?e`<span class="dimpl">dormant</span>`:e`<span>configured</span>`;return e`<tr>
			<td><b>${s.name}</b></td>
			<td class="num">${s.tiers}</td>
			<td>${o}</td>
			<td>${s.source}</td>
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",f);class b extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="Registered services",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(s)}`}body(s){return e`<table class="ct">
			<thead>
				<tr>
					<th>Service</th>
					<th>Scope</th>
					<th>Upstream</th>
					<th>Observation</th>
				</tr>
			</thead>
			<tbody>
				${s.rows.map((o)=>this.row(o))}
			</tbody>
		</table>
		<p class="cfoot">
			Route registration is configuration; local endpoint evidence is shown
			below. <a href="https://bar.local/">Inspect Caddy checks and mDNS
			claims</a>
		</p>`}row(s){return e`<tr>
			<td><a href="https://${s.name}.local/">${s.name}.local</a></td>
			<td><span class="pill">${s.scope}</span></td>
			<td class="mono">${s.upstream}</td>
			<td>${s.monitored}</td>
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",b);class y extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(s)}`}body(s){if(s.error)return e`<div class="errbox">
				current file does not parse: ${s.error}
			</div>`;return e`<div class="knobs">
			${s.knobs.map((o)=>e`<span class="kchip">${o.k}: <b>${o.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",y);class x extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[a,n`
		.auditrow { border-top:1px solid var(--klh-rule); font-size:11.5px; }
		.auditrow summary { display:flex; gap:10px; align-items:baseline; padding:5px 0; cursor:pointer; list-style:none; }
		.auditrow summary::-webkit-details-marker { display:none; }
		.auditrow summary::before { content:'+'; color:var(--klh-accent); }
		.auditrow[open] summary::before { content:'−'; }
		.auditrow .when { margin-left:auto; color:var(--klh-dim); white-space:nowrap; }
		.auditrow .detail { padding:2px 12px 9px; color:var(--klh-ink-2); overflow-wrap:anywhere; }
		.auditolder { border-top:1px solid var(--klh-rule); margin-top:7px; padding-top:7px; }
		.auditolder > summary { cursor:pointer; color:var(--klh-accent); font:11px var(--klh-font-mono); }
	`];constructor(){super();this.heading="admin audit",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;if(!s.rows.length)return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no admin actions recorded yet — settings/policy applies and key
					revocations land here
				</p>`;let o=s.rows.slice(0,5),l=s.rows.slice(5);return e`<h2>${this.heading} · ${s.rows.length} recent actions</h2>
			${o.map((i)=>this.chip(i))}
			${l.length?e`<details class="auditolder"><summary>Earlier actions (${l.length})</summary>${l.map((i)=>this.chip(i))}</details>`:t}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`}chip(s){return e`<details class="auditrow">
			<summary><b>${s.action}</b><span>${s.actor}</span><span class="when mono">${s.when}</span></summary>
			<div class="detail">${s.target??"—"}${s.detail?e`<br />${s.detail}`:t}</div>
		</details>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",x);
