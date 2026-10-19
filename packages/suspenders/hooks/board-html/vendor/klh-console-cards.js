import{r,e,t,s}from"./lit-bc7ky2yb.js";import{a}from"./lit-hg52k985.js";var d=(n)=>{if(n===null||!Number.isFinite(n))return"—";if(Math.abs(n)>=1e6)return`${(n/1e6).toFixed(1)}M`;if(Math.abs(n)>=1000)return`${(n/1000).toFixed(1)}k`;return String(n)},y=(n)=>n===null?"unknown":n<90?`${n}s`:`${Math.round(n/60)}m`,x=(n)=>{if(n===null)return 1;if(n>=100)return 4;if(n>=20)return 3;if(n>=5)return 2;return 1},R=r`
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
		max-width: 760px;
		margin: var(--klh-space-4) 0;
		padding: var(--klh-space-4) 0;
		border-block: 1px solid var(--klh-edge);
	}
	.netMetric span { display:block; color:var(--klh-dim); font:var(--klh-text-xs) var(--klh-font-mono); }
	.netMetric strong { display:block; color:var(--klh-ink); font:600 18px/1.3 var(--klh-font-sans); font-variant-numeric:tabular-nums; }
	.hourPlot { width:min(760px,100%); margin:var(--klh-space-4) 0; }
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
`,T=(n)=>Math.max(0,Math.round((Date.now()-Date.parse(n))/1000)),h=(n)=>n.gateway?e`<p>
				<span class="hname">local spoke</span>
				<span class=${n.gateway.state==="up"?"live":"hot"}>
					${n.gateway.state}</span
				>
				<span class="unknown">· ${n.gateway.detail}</span>
			</p>`:e`<p>
				<span class="hname">local spoke</span>
				<span class="unknown">not in the probe map</span>
			</p>`,_=(n)=>e`
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
			</div>`:t}`,N=(n)=>{let o=n.out60===null?null:Math.round(n.out60/60);return e`<div class="hrow">
		<span class="hname">${n.kind} · ${n.host??"unknown"}${n.port?`:${n.port}`:""}</span>
		<span class="num">${n.model??""}</span>
		<span class="num">${n.req60} req/60s</span>
		<span class="num ${o===null?"":o>=100?"hot":"live"}">
			${o===null?"tok/s unknown":`${o} tok/s`}
		</span>
		<span class="num">15m: ${n.req15} req · out ${d(n.out15)}</span>
		<span
			class="bar"
			style="width:${x(o)*14}px;background:var(--klh-edge)"
		></span>
	</div>`},S=(n)=>e`<div class="routeRow">
	<time class="unknown" datetime=${n.ts} title=${n.ts}>${new Date(n.ts).toLocaleTimeString("da-DK",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</time>
	<span class="title">${n.target_model??"model unknown"}</span>
	<span class="unknown" title=${n.lane||"No lane attribution"}>${n.lane?`lane ${n.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
	<span class="num">${n.target_kind??"?"} ${n.target_host??""}</span>
	<span class="num">${n.duration_ms===null?"—":`${n.duration_ms}ms`}</span>
	<span class="num">in ${d(n.in_tok)} · out ${d(n.out_tok)}</span>
</div>`,c=(n)=>{let o=new Date(`${n}:00Z`);if(Number.isNaN(o.getTime()))return n;let i=(l)=>String(l).padStart(2,"0");return`${i(o.getDate())}.${i(o.getMonth()+1)} ${i(o.getHours())}:00`},C=(n)=>{let o=n.throughput.buckets.slice(0,12).reverse(),i=Math.max(1,...o.map((p)=>p.out_tok)),l=o[0],u=o[o.length-1];return e`<div class="netMetrics" aria-label="Last 15 minutes">
			<div class="netMetric"><span>requests · 15m</span><strong>${n.throughput.window.requests}</strong></div>
			<div class="netMetric"><span>input tokens · 15m</span><strong>${d(n.throughput.window.in_tok)}</strong></div>
			<div class="netMetric"><span>output tokens · 15m</span><strong>${d(n.throughput.window.out_tok)}</strong></div>
		</div>
		<p class="unknown">
			${n.observations.available?"Hub observations available":"Hub observations are not collected here"}
		</p>
		<div class="hourPlot">
			<div class="hourHeading"><span class="hname">Recorded output · last 12 hours</span><span class="unknown">peak ${d(i)} tok/hour</span></div>
				<div class="hourSeries" role="img" aria-label="Recorded output tokens by hour, oldest to newest">
					${o.map((p)=>e`<span class="hourBar"
							style="height:${p.out_tok?Math.max(2,Math.round(p.out_tok/i*80)):0}px"
							title="${c(p.hour)} · ${p.requests} req · out ${d(p.out_tok)} tok"
						></span>`)}
				</div>
				<div class="hourRange"><span>${l?c(l.hour):""}</span><span>${u?c(u.hour):""}</span></div>
		</div>`},M=(n)=>{let o=n.network;if(!o.ok)return e`${h(n)}
			<p class="unknown">${o.reason}</p>`;return e`${h(n)}
		${C(o)}
		${_(o)}
		${o.throughput.interfaces.length?o.throughput.interfaces.map(N):e`<div class="hrow">
					<span class="hname">interfaces</span>
					<span class="unknown">no settled traffic in window</span>
				</div>`}
		<details class="routes">
			<summary>Recent settled routes · ${o.routes.length}</summary>
			<div class="routesBody">
				<div class="routeHead"><span>Time</span><span>Model</span><span>Lane</span><span>Target</span><span>Latency</span><span>Tokens</span></div>
				${o.routes.length?o.routes.map(S):e`<p class="unknown">No settled routes yet</p>`}
			</div>
		</details>
		<p class="legend">
			edge width 1-4px = measured output tok/s (60s): ≥100 → 4 · ≥20 → 3 ·
			≥5 → 2 · else 1 · null = unknown (gray), never zero
		</p>`},D=async()=>{try{let n=await fetch("/api/console/network",{cache:"no-store"});if(!n.ok)return null;return await n.json()}catch{return null}};class m extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a,R];live=null;err="";timer=null;constructor(){super();this.heading="",this.data=null}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),1e4)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){let n=await D();if(n)this.live=n,this.err="";else this.err="refresh failed — last known values shown"}render(){let n=this.live??this.data;if(!n)return e`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;let o=this.err?e`<p class="unknown">${this.err}</p>`:t;return e`<h2>${this.heading} · live ${y(T(n.ts))}</h2>
			${o}${M(n)}`}}customElements.define("klh-network-card",m);var g=(n,o)=>n.flatMap((i,l)=>l?[e`${o}`,i]:[i]);class k extends s{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;if(n.kind==="missing")return e`<h2>${this.heading}</h2>
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
				ladder: <b>${g(this.chips(o)," · ")}</b>
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
						<td>${g(this.pills(i[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(n){return n.map((o)=>e`${o[0]} → ${o[1].length} tiers`)}pills(n){return n.map((o,i)=>e`<span class="pill">${i+1}. ${o}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",k);class w extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;if(!n.groups)return e`<h2>Upstream pool</h2>
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
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",w);class v extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="Registered services",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(n)}`}body(n){return e`<table class="ct">
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
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",v);class b extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let n=this.data;if(!n)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(n)}`}body(n){if(n.error)return e`<div class="errbox">
				current file does not parse: ${n.error}
			</div>`;return e`<div class="knobs">
			${n.knobs.map((o)=>e`<span class="kchip">${o.k}: <b>${o.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",b);class f extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a,r`
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
		</details>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",f);
