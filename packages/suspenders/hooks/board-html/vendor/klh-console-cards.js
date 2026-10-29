import{n,e,t,r}from"./lit-801c06b16c5fa88d.js";import{o}from"./lit-0a3e1e27c2ae4009.js";import{i,a}from"./lit-6a02dab585465de0.js";var u=(s)=>{if(s===null||!Number.isFinite(s))return"—";if(Math.abs(s)>=1e6)return`${(s/1e6).toFixed(1)}M`;if(Math.abs(s)>=1000)return`${(s/1000).toFixed(1)}k`;return String(s)},R=(s)=>s===null?"unknown":s<90?`${s}s`:`${Math.round(s/60)}m`,T=(s)=>{if(s===null)return 1;if(s>=100)return 4;if(s>=20)return 3;if(s>=5)return 2;return 1},_=n`
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
			</p>`,S=(s)=>{let l=s.lifecycle;if(!l.loss.length&&!l.rows.length)return e`<div class="hrow">
			<span class="hname">lifecycle</span>
			<span class="unknown">no projected events here</span>
		</div>`;return e`<div class="hrow">
		<span class="hname">lifecycle · loss</span>
		<span class="num">emitted ${l.totals.emitted}</span>
		<span class="num">observed ${l.totals.observed}</span>
		<span class="num ${l.totals.gaps>0?"hot":""}">gaps ${l.totals.gaps}</span>
	</div>
	${l.loss.filter((p)=>p.gaps>0).map((p)=>e`<div class="hrow">
				<span class="hname">${p.source}</span>
				<span class="num hot">gap ${p.gaps} of ${p.emitted}</span>
			</div>`)}
		<details class="routes">
			<summary>Lifecycle sample · ${l.rows.length}</summary>
			<div class="routesBody">
				${l.rows.length?l.rows.map((p)=>e`<div class="hrow">
							<time class="unknown" datetime=${new Date(p.admittedAt).toISOString()} title=${i(p.admittedAt)}>${a(p.admittedAt)}</time>
							<span class="title">${p.model??"?"}</span>
							<span class="unknown">${p.lane?`lane ${p.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
							<span class="num">${p.outcome??"in flight"}</span>
							<span class="num">${p.attemptsAgree?`att ${p.edgeAttempts??"?"} ok`:`att p${p.edgeAttempts??"?"}/l${p.ledgerAttempts??"?"} drift`}</span>
						</div>`):e`<p class="unknown">no joined rows</p>`}
			</div>
		</details>`},C=(s)=>e`
	<div class="hrow">
		<span class="hname">hubs (observed)</span>
		${s.hubs.length?t:e`<span class="unknown">no projection db wired here</span>`}
	</div>
	${s.hubs.map((l)=>e`<div class="hrow">
			<span class="hname">${l.source}</span>
			<span class="num">active ${l.active}</span>
			<span class="num">${l.requests} req</span>
			<span class="num ${l.errors>0?"hot":""}">${l.errors} err</span>
			<span class="unknown">obs age ${l.freshness.ageS===null?"unknown":`${l.freshness.ageS}s`} · seq ${l.freshness.lastSeq??"?"}</span>
		</div>`)}
	${s.hops.length?e`<div class="hrow">
				<span class="hname">forwarding edges</span>
				${s.hops.map((l)=>e`<span class="num">${l.origin||"local"} → ${l.peer} (${l.n})</span>`)}
			</div>`:t}
	${s.unsettled.length?e`<div class="hrow">
				<span class="hname">unsettled</span>
				${s.unsettled.map((l)=>e`<span class="num">${l.kind}: ${l.n}</span>`)}
			</div>`:t}
	${S(s)}`,D=(s)=>{let l=s.out60===null?null:Math.round(s.out60/60);return e`<div class="hrow">
		<span class="hname">${s.kind} · ${s.host??"unknown"}${s.port?`:${s.port}`:""}</span>
		<span class="num">${s.model??""}</span>
		<span class="num">${s.req60} req/60s</span>
		<span class="num ${l===null?"":l>=100?"hot":"live"}">
			${l===null?"tok/s unknown":`${l} tok/s`}
		</span>
		<span class="num">15m: ${s.req15} req · out ${u(s.out15)}</span>
		<span
			class="bar"
			style="width:${T(l)*14}px;background:var(--klh-edge)"
		></span>
	</div>`},M=(s)=>e`<div class="routeRow">
	<time class="unknown" datetime=${s.ts} title=${i(s.ts)}>${a(s.ts)}</time>
	<span class="title">${s.target_model??"model unknown"}</span>
	<span class="unknown" title=${s.lane||"No lane attribution"}>${s.lane?`lane ${s.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
	<span class="num">${s.target_kind??"?"} ${s.target_host??""}</span>
	<span class="num">${s.duration_ms===null?"—":`${s.duration_ms}ms`}</span>
	<span class="num">in ${u(s.in_tok)} · out ${u(s.out_tok)}</span>
</div>`,h=(s)=>{let l=new Date(`${s}:00Z`);if(Number.isNaN(l.getTime()))return s;let p=(d)=>String(d).padStart(2,"0");return`${p(l.getDate())}.${p(l.getMonth()+1)} ${p(l.getHours())}:00`},O=(s)=>{let l=s.throughput.buckets.slice(0,12).reverse(),p=Math.max(1,...l.map((c)=>c.out_tok)),d=l[0],m=l[l.length-1];return e`<div class="netMetrics" aria-label="Last 15 minutes">
			<div class="netMetric"><span>requests · 15m</span><strong>${s.throughput.window.requests}</strong></div>
			<div class="netMetric"><span>input tokens · 15m</span><strong>${u(s.throughput.window.in_tok)}</strong></div>
			<div class="netMetric"><span>output tokens · 15m</span><strong>${u(s.throughput.window.out_tok)}</strong></div>
		</div>
		<p class="unknown">
			${s.observations.available?"Hub observations available":"Hub observations are not collected here"}
		</p>
		<div class="hourPlot">
			<div class="hourHeading"><span class="hname">Recorded output · last 12 hours</span><span class="unknown">peak ${u(p)} tok/hour</span></div>
				<div class="hourSeries" role="img" aria-label="Recorded output tokens by hour, oldest to newest">
					${l.map((c)=>e`<span class="hourBar"
							style="height:${c.out_tok?Math.max(2,Math.round(c.out_tok/p*80)):0}px"
							title="${h(c.hour)} · ${c.requests} req · out ${u(c.out_tok)} tok"
						></span>`)}
				</div>
				<div class="hourRange"><span>${d?h(d.hour):""}</span><span>${m?h(m.hour):""}</span></div>
		</div>`},E=(s)=>s.model_health.down.length===0?e`<div class="hrow">
				<span class="hname">model health</span>
				<span class="unknown">no DOWN groups in fresh facts</span>
			</div>`:e`<div class="hrow">
				<span class="hname">model health</span>
				${s.model_health.down.map((l)=>e`<span class="num hot">DOWN ${l}</span>`)}
			</div>`,j=(s)=>{let l=s.network;if(!l.ok)return e`${g(s)}
			<p class="unknown">${l.reason}</p>`;return e`${g(s)}
		${E(s)}
		${O(l)}
		${C(l)}
		${l.throughput.interfaces.length?l.throughput.interfaces.map(D):e`<div class="hrow">
					<span class="hname">interfaces</span>
					<span class="unknown">no settled traffic in window</span>
				</div>`}
		<details class="routes">
			<summary>Recent settled routes · ${l.routes.length}</summary>
			<div class="routesBody">
				<div class="routeHead"><span>Time</span><span>Model</span><span>Lane</span><span>Target</span><span>Latency</span><span>Tokens</span></div>
				${l.routes.length?l.routes.map(M):e`<p class="unknown">No settled routes yet</p>`}
			</div>
		</details>
		<p class="legend">
			edge width 1-4px = measured output tok/s (60s): ≥100 → 4 · ≥20 → 3 ·
			≥5 → 2 · else 1 · null = unknown (gray), never zero
		</p>`},P=async()=>{try{let s=await fetch("/api/console/network",{cache:"no-store"});if(!s.ok)return null;return await s.json()}catch{return null}};class k extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[o,_];live=null;err="";timer=null;constructor(){super();this.heading="",this.data=null}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),1e4)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){let s=await P();if(s)this.live=s,this.err="";else this.err="refresh failed — last known values shown"}render(){let s=this.live??this.data;if(!s)return e`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;let l=this.err?e`<p class="unknown">${this.err}</p>`:t;return e`<h2>${this.heading} · live ${R(N(s.ts))}</h2>
			${l}${j(s)}`}}customElements.define("klh-network-card",k);var w=(s,l)=>s.flatMap((p,d)=>d?[e`${l}`,p]:[p]);class v extends r{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;if(s.kind==="missing")return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no routing-policy.yaml found on the belt chain (BELT_POLICY/
					BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)
				</p>`;if(s.kind==="no-gateway")return e`<h2>${this.heading}</h2>
				<p class="dimpl">policy resolved but no gateway section parsed</p>`;if(s.kind==="error")return e`<h2>${this.heading}</h2>
				<div class="errbox">
					resolved ${s.path} does not parse: ${s.error}
				</div>`;let l=s.gateway;return e`<h2>${this.head(s.path,s.source)}</h2>
			${l?e`
						<div class="knobs">
							<span class="kchip">num_retries: <b>${l.num_retries}</b></span>
							<span class="kchip">
								allowed_fails: <b>${l.allowed_fails}</b>
							</span>
							<span class="kchip">
								cooldown_time: <b>${l.cooldown_time}s</b>
							</span>
						</div>
						${this.compact?t:this.ladder(l.fallbacks)}
					`:t}${this.foot?e`<p class="cfoot">${this.foot}</p>`:t}`}head(s,l){let p=this.heading;if(s)p+=` · ${s}`;if(l)p+=` · source: ${l}`;return p}ladder(s){let l=Object.entries(s);if(this.compact&&l.length)return e`<span class="kchip">
				ladder: <b>${w(this.chips(l)," · ")}</b>
			</span>`;if(this.compact)return e`${t}`;return e`<table class="ct ladder">
			<thead>
				<tr>
					<th>model</th>
					<th>fallback ladder (order = priority)</th>
				</tr>
			</thead>
			<tbody>
				${l.map((p)=>e`<tr>
						<td><b>${p[0]}</b></td>
						<td>${w(this.pills(p[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(s){return s.map((l)=>e`${l[0]} → ${l[1].length} tiers`)}pills(s){return s.map((l,p)=>e`<span class="pill">${p+1}. ${l}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",v);class f extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;if(!s.groups)return e`<h2>Upstream pool</h2>
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
				${s.map((l)=>this.row(l))}
			</tbody>
		</table>
		<p class="cfoot">
			Deployment counts merge the fleet default with machine overrides.
			Reachability is shown by the endpoint checks above.
		</p>`}row(s){let l=s.dormant?e`<span class="dimpl">dormant</span>`:e`<span>configured</span>`;return e`<tr>
			<td><b>${s.name}</b></td>
			<td class="num">${s.tiers}</td>
			<td>${l}</td>
			<td>${s.source}</td>
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",f);class b extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="Registered services",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(s)}`}body(s){return e`<table class="ct">
			<thead>
				<tr>
					<th>Service</th>
					<th>Scope</th>
					<th>Upstream</th>
					<th>Observation</th>
				</tr>
			</thead>
			<tbody>
				${s.rows.map((l)=>this.row(l))}
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
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",b);class y extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let s=this.data;if(!s)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(s)}`}body(s){if(s.error)return e`<div class="errbox">
				current file does not parse: ${s.error}
			</div>`;return e`<div class="knobs">
			${s.knobs.map((l)=>e`<span class="kchip">${l.k}: <b>${l.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",y);class x extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[o,n`
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
				</p>`;let l=s.rows.slice(0,5),p=s.rows.slice(5);return e`<h2>${this.heading} · ${s.rows.length} recent actions</h2>
			${l.map((d)=>this.chip(d))}
			${p.length?e`<details class="auditolder"><summary>Earlier actions (${p.length})</summary>${p.map((d)=>this.chip(d))}</details>`:t}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`}chip(s){return e`<details class="auditrow">
			<summary><b>${s.action}</b><span>${s.actor}</span><span class="when mono">${s.when}</span></summary>
			<div class="detail">${s.target??"—"}${s.detail?e`<br />${s.detail}`:t}</div>
		</details>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",x);
