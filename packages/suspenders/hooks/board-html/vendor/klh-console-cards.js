import{n,e,t,r}from"./lit-f32c0cedac4dc611.js";import{s}from"./lit-ebc85c9b74f7507e.js";import{a,o}from"./lit-372384db672af954.js";var u=(l)=>{if(l===null||!Number.isFinite(l))return"—";if(Math.abs(l)>=1e6)return`${(l/1e6).toFixed(1)}M`;if(Math.abs(l)>=1000)return`${(l/1000).toFixed(1)}k`;return String(l)},R=(l)=>l===null?"unknown":l<90?`${l}s`:`${Math.round(l/60)}m`,T=(l)=>{if(l===null)return 1;if(l>=100)return 4;if(l>=20)return 3;if(l>=5)return 2;return 1},_=n`
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
`,N=(l)=>Math.max(0,Math.round((Date.now()-Date.parse(l))/1000)),g=(l)=>l.gateway?e`<p>
				<span class="hname">local spoke</span>
				<span class=${l.gateway.state==="up"?"live":"hot"}>
					${l.gateway.state}</span
				>
				<span class="unknown">· ${l.gateway.detail}</span>
			</p>`:e`<p>
				<span class="hname">local spoke</span>
				<span class="unknown">not in the probe map</span>
			</p>`,S=(l)=>{let i=l.lifecycle;if(!i.loss.length&&!i.rows.length)return e`<div class="hrow">
			<span class="hname">lifecycle</span>
			<span class="unknown">no projected events here</span>
		</div>`;return e`<div class="hrow">
		<span class="hname">lifecycle · loss</span>
		<span class="num">emitted ${i.totals.emitted}</span>
		<span class="num">observed ${i.totals.observed}</span>
		<span class="num ${i.totals.gaps>0?"hot":""}">gaps ${i.totals.gaps}</span>
	</div>
	${i.loss.filter((p)=>p.gaps>0).map((p)=>e`<div class="hrow">
				<span class="hname">${p.source}</span>
				<span class="num hot">gap ${p.gaps} of ${p.emitted}</span>
			</div>`)}
		<details class="routes">
			<summary>Lifecycle sample · ${i.rows.length}</summary>
			<div class="routesBody">
				${i.rows.length?i.rows.map((p)=>e`<div class="hrow">
							<time class="unknown" datetime=${new Date(p.admittedAt).toISOString()} title=${a(p.admittedAt)}>${o(p.admittedAt)}</time>
							<span class="title">${p.model??"?"}</span>
							<span class="unknown">${p.lane?`lane ${p.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
							<span class="num">${p.outcome??"in flight"}</span>
							<span class="num">${p.attemptsAgree?`att ${p.edgeAttempts??"?"} ok`:`att p${p.edgeAttempts??"?"}/l${p.ledgerAttempts??"?"} drift`}</span>
						</div>`):e`<p class="unknown">no joined rows</p>`}
			</div>
		</details>`},C=(l)=>e`
	<div class="hrow">
		<span class="hname">hubs (observed)</span>
		${l.hubs.length?t:e`<span class="unknown">no projection db wired here</span>`}
	</div>
	${l.hubs.map((i)=>e`<div class="hrow">
			<span class="hname">${i.source}</span>
			<span class="num">active ${i.active}</span>
			<span class="num">${i.requests} req</span>
			<span class="num ${i.errors>0?"hot":""}">${i.errors} err</span>
			<span class="unknown">obs age ${i.freshness.ageS===null?"unknown":`${i.freshness.ageS}s`} · seq ${i.freshness.lastSeq??"?"}</span>
		</div>`)}
	${l.hops.length?e`<div class="hrow">
				<span class="hname">forwarding edges</span>
				${l.hops.map((i)=>e`<span class="num">${i.origin||"local"} → ${i.peer} (${i.n})</span>`)}
			</div>`:t}
	${l.unsettled.length?e`<div class="hrow">
				<span class="hname">unsettled</span>
				${l.unsettled.map((i)=>e`<span class="num">${i.kind}: ${i.n}</span>`)}
			</div>`:t}
	${S(l)}`,D=(l)=>{let i=l.out60===null?null:Math.round(l.out60/60);return e`<div class="hrow">
		<span class="hname">${l.kind} · ${l.host??"unknown"}${l.port?`:${l.port}`:""}</span>
		<span class="num">${l.model??""}</span>
		<span class="num">${l.req60} req/60s</span>
		<span class="num ${i===null?"":i>=100?"hot":"live"}">
			${i===null?"tok/s unknown":`${i} tok/s`}
		</span>
		<span class="num">15m: ${l.req15} req · out ${u(l.out15)}</span>
		<span
			class="bar"
			style="width:${T(i)*14}px;background:var(--klh-edge)"
		></span>
	</div>`},M=(l)=>e`<div class="routeRow">
	<time class="unknown" datetime=${l.ts} title=${a(l.ts)}>${o(l.ts)}</time>
	<span class="title">${l.target_model??"model unknown"}</span>
	<span class="unknown" title=${l.lane||"No lane attribution"}>${l.lane?`lane ${l.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
	<span class="num">${l.target_kind??"?"} ${l.target_host??""}</span>
	<span class="num">${l.duration_ms===null?"—":`${l.duration_ms}ms`}</span>
	<span class="num">in ${u(l.in_tok)} · out ${u(l.out_tok)}</span>
</div>`,h=(l)=>{let i=new Date(`${l}:00Z`);if(Number.isNaN(i.getTime()))return l;let p=(d)=>String(d).padStart(2,"0");return`${p(i.getDate())}.${p(i.getMonth()+1)} ${p(i.getHours())}:00`},O=(l)=>{let i=l.throughput.buckets.slice(0,12).reverse(),p=Math.max(1,...i.map((c)=>c.out_tok)),d=i[0],m=i[i.length-1];return e`<div class="netMetrics" aria-label="Last 15 minutes">
			<div class="netMetric"><span>requests · 15m</span><strong>${l.throughput.window.requests}</strong></div>
			<div class="netMetric"><span>input tokens · 15m</span><strong>${u(l.throughput.window.in_tok)}</strong></div>
			<div class="netMetric"><span>output tokens · 15m</span><strong>${u(l.throughput.window.out_tok)}</strong></div>
		</div>
		<p class="unknown">
			${l.observations.available?"Hub observations available":"Hub observations are not collected here"}
		</p>
		<div class="hourPlot">
			<div class="hourHeading"><span class="hname">Recorded output · last 12 hours</span><span class="unknown">peak ${u(p)} tok/hour</span></div>
				<div class="hourSeries" role="img" aria-label="Recorded output tokens by hour, oldest to newest">
					${i.map((c)=>e`<span class="hourBar"
							style="height:${c.out_tok?Math.max(2,Math.round(c.out_tok/p*80)):0}px"
							title="${h(c.hour)} · ${c.requests} req · out ${u(c.out_tok)} tok"
						></span>`)}
				</div>
				<div class="hourRange"><span>${d?h(d.hour):""}</span><span>${m?h(m.hour):""}</span></div>
		</div>`},E=(l)=>l.model_health.down.length===0?e`<div class="hrow">
				<span class="hname">model health</span>
				<span class="unknown">no DOWN groups in fresh facts</span>
			</div>`:e`<div class="hrow">
				<span class="hname">model health</span>
				${l.model_health.down.map((i)=>e`<span class="num hot">DOWN ${i}</span>`)}
			</div>`,j=(l)=>{let i=l.network;if(!i.ok)return e`${g(l)}
			<p class="unknown">${i.reason}</p>`;return e`${g(l)}
		${E(l)}
		${O(i)}
		${C(i)}
		${i.throughput.interfaces.length?i.throughput.interfaces.map(D):e`<div class="hrow">
					<span class="hname">interfaces</span>
					<span class="unknown">no settled traffic in window</span>
				</div>`}
		<details class="routes">
			<summary>Recent settled routes · ${i.routes.length}</summary>
			<div class="routesBody">
				<div class="routeHead"><span>Time</span><span>Model</span><span>Lane</span><span>Target</span><span>Latency</span><span>Tokens</span></div>
				${i.routes.length?i.routes.map(M):e`<p class="unknown">No settled routes yet</p>`}
			</div>
		</details>
		<p class="legend">
			edge width 1-4px = measured output tok/s (60s): ≥100 → 4 · ≥20 → 3 ·
			≥5 → 2 · else 1 · null = unknown (gray), never zero
		</p>`},P=async()=>{try{let l=await fetch("/api/console/network",{cache:"no-store"});if(!l.ok)return null;return await l.json()}catch{return null}};class k extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[s,_];live=null;err="";timer=null;constructor(){super();this.heading="",this.data=null}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),1e4)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){let l=await P();if(l)this.live=l,this.err="";else this.err="refresh failed — last known values shown"}render(){let l=this.live??this.data;if(!l)return e`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;let i=this.err?e`<p class="unknown">${this.err}</p>`:t;return e`<h2>${this.heading} · live ${R(N(l.ts))}</h2>
			${i}${j(l)}`}}customElements.define("klh-network-card",k);var w=(l,i)=>l.flatMap((p,d)=>d?[e`${i}`,p]:[p]);class v extends r{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[s];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let l=this.data;if(!l)return e`${t}`;if(l.kind==="missing")return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no routing-policy.yaml found on the belt chain (BELT_POLICY/
					BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)
				</p>`;if(l.kind==="no-gateway")return e`<h2>${this.heading}</h2>
				<p class="dimpl">policy resolved but no gateway section parsed</p>`;if(l.kind==="error")return e`<h2>${this.heading}</h2>
				<div class="errbox">
					resolved ${l.path} does not parse: ${l.error}
				</div>`;let i=l.gateway;return e`<h2>${this.head(l.path,l.source)}</h2>
			${i?e`
						<div class="knobs">
							<span class="kchip">num_retries: <b>${i.num_retries}</b></span>
							<span class="kchip">
								allowed_fails: <b>${i.allowed_fails}</b>
							</span>
							<span class="kchip">
								cooldown_time: <b>${i.cooldown_time}s</b>
							</span>
						</div>
						${this.compact?t:this.ladder(i.fallbacks)}
					`:t}${this.foot?e`<p class="cfoot">${this.foot}</p>`:t}`}head(l,i){let p=this.heading;if(l)p+=` · ${l}`;if(i)p+=` · source: ${i}`;return p}ladder(l){let i=Object.entries(l);if(this.compact&&i.length)return e`<span class="kchip">
				ladder: <b>${w(this.chips(i)," · ")}</b>
			</span>`;if(this.compact)return e`${t}`;return e`<table class="ct ladder">
			<thead>
				<tr>
					<th>model</th>
					<th>fallback ladder (order = priority)</th>
				</tr>
			</thead>
			<tbody>
				${i.map((p)=>e`<tr>
						<td><b>${p[0]}</b></td>
						<td>${w(this.pills(p[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(l){return l.map((i)=>e`${i[0]} → ${i[1].length} tiers`)}pills(l){return l.map((i,p)=>e`<span class="pill">${p+1}. ${i}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",v);class f extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[s];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let l=this.data;if(!l)return e`${t}`;if(!l.groups)return e`<h2>Upstream pool</h2>
				<p class="dimpl">
					upstreams.yaml unreadable — the ladder above still applies
				</p>`;return e`<h2>${this.heading} · ${l.source}</h2>${this.table(l.groups)}`}table(l){return e`<table class="ct">
			<thead>
				<tr>
					<th>group</th>
					<th>deployments</th>
					<th>state</th>
					<th>source</th>
				</tr>
			</thead>
			<tbody>
				${l.map((i)=>this.row(i))}
			</tbody>
		</table>
		<p class="cfoot">
			Deployment counts merge the fleet default with machine overrides.
			Reachability is shown by the endpoint checks above.
		</p>`}row(l){let i=l.dormant?e`<span class="dimpl">dormant</span>`:e`<span>configured</span>`;return e`<tr>
			<td><b>${l.name}</b></td>
			<td class="num">${l.tiers}</td>
			<td>${i}</td>
			<td>${l.source}</td>
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",f);class b extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[s];constructor(){super();this.heading="Registered services",this.data=null}render(){let l=this.data;if(!l)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(l)}`}body(l){return e`<table class="ct">
			<thead>
				<tr>
					<th>Service</th>
					<th>Scope</th>
					<th>Upstream</th>
					<th>Observation</th>
				</tr>
			</thead>
			<tbody>
				${l.rows.map((i)=>this.row(i))}
			</tbody>
		</table>
		<p class="cfoot">
			Route registration is configuration; local endpoint evidence is shown
			below. <a href="https://bar.local/">Inspect Caddy checks and mDNS
			claims</a>
		</p>`}row(l){return e`<tr>
			<td><a href="https://${l.name}.local/">${l.name}.local</a></td>
			<td><span class="pill">${l.scope}</span></td>
			<td class="mono">${l.upstream}</td>
			<td>${l.monitored}</td>
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",b);class y extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[s];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let l=this.data;if(!l)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(l)}`}body(l){if(l.error)return e`<div class="errbox">
				current file does not parse: ${l.error}
			</div>`;return e`<div class="knobs">
			${l.knobs.map((i)=>e`<span class="kchip">${i.k}: <b>${i.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",y);class x extends r{static properties={heading:{type:String},data:{type:Object}};static styles=[s,n`
		.auditrow { border-top:1px solid var(--klh-rule); font-size:11.5px; }
		.auditrow summary { display:flex; gap:10px; align-items:baseline; padding:5px 0; cursor:pointer; list-style:none; }
		.auditrow summary::-webkit-details-marker { display:none; }
		.auditrow summary::before { content:'+'; color:var(--klh-accent); }
		.auditrow[open] summary::before { content:'−'; }
		.auditrow .when { margin-left:auto; color:var(--klh-dim); white-space:nowrap; }
		.auditrow .detail { padding:2px 12px 9px; color:var(--klh-ink-2); overflow-wrap:anywhere; }
		.auditolder { border-top:1px solid var(--klh-rule); margin-top:7px; padding-top:7px; }
		.auditolder > summary { cursor:pointer; color:var(--klh-accent); font:11px var(--klh-font-mono); }
	`];constructor(){super();this.heading="admin audit",this.data=null}render(){let l=this.data;if(!l)return e`${t}`;if(!l.rows.length)return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no admin actions recorded yet — settings/policy applies and key
					revocations land here
				</p>`;let i=l.rows.slice(0,5),p=l.rows.slice(5);return e`<h2>${this.heading} · ${l.rows.length} recent actions</h2>
			${i.map((d)=>this.chip(d))}
			${p.length?e`<details class="auditolder"><summary>Earlier actions (${p.length})</summary>${p.map((d)=>this.chip(d))}</details>`:t}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`}chip(l){return e`<details class="auditrow">
			<summary><b>${l.action}</b><span>${l.actor}</span><span class="when mono">${l.when}</span></summary>
			<div class="detail">${l.target??"—"}${l.detail?e`<br />${l.detail}`:t}</div>
		</details>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",x);
