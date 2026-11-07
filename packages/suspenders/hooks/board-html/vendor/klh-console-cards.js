import{r,e,t,n}from"./lit-f18bcbfe556b7350.js";import{u}from"./lit-dd2d5e033598fb9b.js";import{T,R}from"./lit-4d58b154a05c60be.js";var p=(a)=>{if(a===null||!Number.isFinite(a))return"—";if(Math.abs(a)>=1e6)return`${(a/1e6).toFixed(1)}M`;if(Math.abs(a)>=1000)return`${(a/1000).toFixed(1)}k`;return String(a)},N=(a)=>a===null?"unknown":a<90?`${a}s`:`${Math.round(a/60)}m`,_=(a)=>{if(a===null)return 1;if(a>=100)return 4;if(a>=20)return 3;if(a>=5)return 2;return 1},P=r`
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
`,C=(a)=>Math.max(0,Math.round((Date.now()-Date.parse(a))/1000)),m=(a)=>a.gateway?e`<p>
				<span class="hname">local spoke</span>
				<span class=${a.gateway.state==="up"?"live":"hot"}>
					${a.gateway.state}</span
				>
				<span class="unknown">· ${a.gateway.detail}</span>
			</p>`:e`<p>
				<span class="hname">local spoke</span>
				<span class="unknown">not in the probe map</span>
			</p>`,M=(a)=>{let s=a.lifecycle;if(!s.loss.length&&!s.rows.length)return e`<div class="hrow">
			<span class="hname">lifecycle</span>
			<span class="unknown">no projected events here</span>
		</div>`;return e`<div class="hrow">
		<span class="hname">lifecycle · loss</span>
		<span class="num">emitted ${s.totals.emitted}</span>
		<span class="num">observed ${s.totals.observed}</span>
		<span class="num ${s.totals.gaps>0?"hot":""}">gaps ${s.totals.gaps}</span>
	</div>
	${s.loss.filter((o)=>o.gaps>0).map((o)=>e`<div class="hrow">
				<span class="hname">${o.source}</span>
				<span class="num hot">gap ${o.gaps} of ${o.emitted}</span>
			</div>`)}
		<details class="routes">
			<summary>Lifecycle sample · ${s.rows.length}</summary>
			<div class="routesBody">
				${s.rows.length?s.rows.map((o)=>e`<div class="hrow">
							<time class="unknown" datetime=${new Date(o.admittedAt).toISOString()} title=${T(o.admittedAt)}>${R(o.admittedAt)}</time>
							<span class="title">${o.model??"?"}</span>
							<span class="unknown">${o.lane?`lane ${o.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
							<span class="num">${o.outcome??"in flight"}</span>
							<span class="num">${o.attemptsAgree?`att ${o.edgeAttempts??"?"} ok`:`att p${o.edgeAttempts??"?"}/l${o.ledgerAttempts??"?"} drift`}</span>
						</div>`):e`<p class="unknown">no joined rows</p>`}
			</div>
		</details>`},E=(a)=>e`
	<div class="hrow">
		<span class="hname">hubs (observed)</span>
		${a.hubs.length?t:e`<span class="unknown">no projection db wired here</span>`}
	</div>
	${a.hubs.map((s)=>e`<div class="hrow">
			<span class="hname">${s.source}</span>
			<span class="num">active ${s.active}</span>
			<span class="num">${s.requests} req</span>
			<span class="num ${s.errors>0?"hot":""}">${s.errors} err</span>
			<span class="unknown">obs age ${s.freshness.ageS===null?"unknown":`${s.freshness.ageS}s`} · seq ${s.freshness.lastSeq??"?"}</span>
		</div>`)}
	${a.hops.length?e`<div class="hrow">
				<span class="hname">forwarding edges</span>
				${a.hops.map((s)=>e`<span class="num">${s.origin||"local"} → ${s.peer} (${s.n})</span>`)}
			</div>`:t}
	${a.unsettled.length?e`<div class="hrow">
				<span class="hname">unsettled</span>
				${a.unsettled.map((s)=>e`<span class="num">${s.kind}: ${s.n}</span>`)}
			</div>`:t}
	${M(a)}`,O=(a)=>{let s=a.out60===null?null:Math.round(a.out60/60);return e`<div class="hrow">
		<span class="hname">${a.kind} · ${a.host??"unknown"}${a.port?`:${a.port}`:""}</span>
		<span class="num">${a.model??""}</span>
		<span class="num">${a.req60} req/60s</span>
		<span class="num ${s===null?"":s>=100?"hot":"live"}">
			${s===null?"tok/s unknown":`${s} tok/s`}
		</span>
		<span class="num">15m: ${a.req15} req · out ${p(a.out15)}</span>
		<span
			class="bar"
			style="width:${_(s)*14}px;background:var(--klh-edge)"
		></span>
	</div>`},A=(a)=>e`<div class="routeRow">
	<time class="unknown" datetime=${a.ts} title=${T(a.ts)}>${R(a.ts)}</time>
	<span class="title">${a.target_model??"model unknown"}</span>
	<span class="unknown" title=${a.lane||"No lane attribution"}>${a.lane?`lane ${a.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
	<span class="num">${a.target_kind??"?"} ${a.target_host??""}</span>
	<span class="num">${a.duration_ms===null?"—":`${a.duration_ms}ms`}</span>
	<span class="num">in ${p(a.in_tok)} · out ${p(a.out_tok)}</span>
</div>`,h=(a)=>{let s=new Date(`${a}:00Z`);if(Number.isNaN(s.getTime()))return a;let o=(l)=>String(l).padStart(2,"0");return`${o(s.getDate())}.${o(s.getMonth()+1)} ${o(s.getHours())}:00`},D=(a)=>{let s=a.throughput.buckets.slice(0,12).reverse(),o=Math.max(1,...s.map((d)=>d.out_tok)),l=s[0],i=s[s.length-1];return e`<div class="netMetrics" aria-label="Last 15 minutes">
			<div class="netMetric"><span>requests · 15m</span><strong>${a.throughput.window.requests}</strong></div>
			<div class="netMetric"><span>input tokens · 15m</span><strong>${p(a.throughput.window.in_tok)}</strong></div>
			<div class="netMetric"><span>output tokens · 15m</span><strong>${p(a.throughput.window.out_tok)}</strong></div>
		</div>
		<p class="unknown">
			${a.observations.available?"Hub observations available":"Hub observations are not collected here"}
		</p>
		<div class="hourPlot">
			<div class="hourHeading"><span class="hname">Recorded output · last 12 hours</span><span class="unknown">peak ${p(o)} tok/hour</span></div>
				<div class="hourSeries" role="img" aria-label="Recorded output tokens by hour, oldest to newest">
					${s.map((d)=>e`<span class="hourBar"
							style="height:${d.out_tok?Math.max(2,Math.round(d.out_tok/o*80)):0}px"
							title="${h(d.hour)} · ${d.requests} req · out ${p(d.out_tok)} tok"
						></span>`)}
				</div>
				<div class="hourRange"><span>${l?h(l.hour):""}</span><span>${i?h(i.hour):""}</span></div>
		</div>`},j=(a)=>a.model_health.down.length===0?e`<div class="hrow">
				<span class="hname">model health</span>
				<span class="unknown">no DOWN groups in fresh facts</span>
			</div>`:e`<div class="hrow">
				<span class="hname">model health</span>
				${a.model_health.down.map((s)=>e`<span class="num hot">DOWN ${s}</span>`)}
			</div>`,F=(a)=>{let s=a.network;if(!s.ok)return e`${m(a)}
			<p class="unknown">${s.reason}</p>`;return e`${m(a)}
		${j(a)}
		${D(s)}
		${E(s)}
		${s.throughput.interfaces.length?s.throughput.interfaces.map(O):e`<div class="hrow">
					<span class="hname">interfaces</span>
					<span class="unknown">no settled traffic in window</span>
				</div>`}
		<details class="routes">
			<summary>Recent settled routes · ${s.routes.length}</summary>
			<div class="routesBody">
				<div class="routeHead"><span>Time</span><span>Model</span><span>Lane</span><span>Target</span><span>Latency</span><span>Tokens</span></div>
				${s.routes.length?s.routes.map(A):e`<p class="unknown">No settled routes yet</p>`}
			</div>
		</details>
		<p class="legend">
			edge width 1-4px = measured output tok/s (60s): ≥100 → 4 · ≥20 → 3 ·
			≥5 → 2 · else 1 · null = unknown (gray), never zero
		</p>`},L=async()=>{try{let a=await fetch("/api/console/network",{cache:"no-store"});if(!a.ok)return null;return await a.json()}catch{return null}};class g extends n{static properties={heading:{type:String},data:{type:Object}};static styles=[u,P];live=null;err="";timer=null;constructor(){super();this.heading="",this.data=null}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),1e4)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){let a=await L();if(a)this.live=a,this.err="";else this.err="refresh failed — last known values shown"}render(){let a=this.live??this.data;if(!a)return e`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;let s=this.err?e`<p class="unknown">${this.err}</p>`:t;return e`<h2>${this.heading} · live ${N(C(a.ts))}</h2>
			${s}${F(a)}`}}customElements.define("klh-network-card",g);var I=[{value:"60",label:"1 min"},{value:"300",label:"5 min"},{value:"600",label:"10 min"}],H=[{heading:"MODELS",kind:"model"},{heading:"UPSTREAMS",kind:"upstream"}],U=(a)=>a.replace(/^autow([\d.]+)-.*/,"W$1"),W=async(a)=>{try{let s=await fetch(`/api/console/flow?window=${a}`,{cache:"no-store"});if(!s.ok)return null;return await s.json()}catch{return null}};class v extends n{static properties={heading:{type:String},src:{type:String},paused:{type:Boolean}};static styles=[u,r`
			.bar {
				display: flex;
				gap: var(--klh-space-4);
				flex-wrap: wrap;
				align-items: baseline;
				margin: 0 0 var(--klh-space-3);
			}
			.bar h2 {
				margin: 0;
			}
			.bar .spacer {
				flex: 1 1 auto;
			}
			label.win {
				color: var(--klh-dim);
				font: var(--klh-text-xs) var(--klh-font-mono);
				text-transform: uppercase;
				letter-spacing: 0.06em;
			}
			select {
				background: var(--klh-bg);
				color: var(--klh-ink);
				border: 1px solid var(--klh-edge);
				border-radius: 2px;
				font: var(--klh-text-md) var(--klh-font-mono);
				padding: 2px 6px;
			}
			button.live {
				border: 1px solid var(--klh-edge-strong);
				border-radius: 2px;
				background: var(--klh-bg);
				color: var(--klh-ink);
				font: 600 var(--klh-text-xs) var(--klh-font-sans);
				text-transform: uppercase;
				letter-spacing: 0.06em;
				padding: 4px 12px;
				cursor: pointer;
			}
			button.live[aria-pressed="true"] {
				border-color: var(--klh-accent);
				color: var(--klh-accent);
			}
			.flow {
				display: grid;
				grid-template-columns: minmax(150px, 1fr) minmax(110px, auto) minmax(
						150px,
						1fr
					);
				gap: var(--klh-space-4);
				align-items: start;
			}
			.colTitle {
				color: var(--klh-dim);
				font: var(--klh-text-xs) var(--klh-font-mono);
				text-transform: uppercase;
				letter-spacing: 0.08em;
				border-bottom: 1px solid var(--klh-rule);
				padding-bottom: var(--klh-space-2);
				margin: 0 0 var(--klh-space-2);
			}
			.node {
				border: 1px solid var(--klh-edge);
				border-radius: 2px;
				background: var(--klh-surface);
				padding: var(--klh-space-2) var(--klh-space-3);
				margin-bottom: var(--klh-space-2);
				font-size: var(--klh-text-md);
			}
			.node:focus-visible {
				outline: 2px solid var(--klh-accent);
				outline-offset: 2px;
			}
			.node .who {
				font-family: var(--klh-font-mono);
				word-break: break-all;
			}
			.node .count {
				font-variant-numeric: tabular-nums;
				color: var(--klh-ink-2);
			}
			.node .err {
				color: var(--klh-danger-ink);
			}
			.node.gatewayNode {
				border-color: var(--klh-edge-strong);
				text-align: center;
				padding: var(--klh-space-4) var(--klh-space-3);
			}
			.node.gatewayNode .rate {
				font-size: 20px;
				font-weight: 600;
				font-variant-numeric: tabular-nums;
			}
			.node.gatewayNode .sub {
				color: var(--klh-dim);
				font: var(--klh-text-xs) var(--klh-font-mono);
			}
			.spark {
				display: block;
				width: 100%;
				height: 28px;
				margin-top: var(--klh-space-2);
			}
			.edge {
				height: 5px;
				margin: 0 0 var(--klh-space-2);
				border-radius: 2px;
				background: var(--klh-edge);
			}
			.edge.api_key {
				background: var(--klh-edge-strong);
			}
			.edge.companion {
				background: repeating-linear-gradient(
					to right,
					var(--klh-edge-strong) 0 6px,
					transparent 6px 10px
				);
			}
			.edge.internal {
				background: repeating-linear-gradient(
					to right,
					var(--klh-edge) 0 2px,
					transparent 2px 7px
				);
			}
			.dot {
				display: inline-block;
				width: 8px;
				height: 8px;
				border-radius: 50%;
				margin-right: 5px;
				vertical-align: baseline;
			}
			.dot.masked {
				background: var(--klh-accent);
			}
			.dot.blocked {
				background: var(--klh-danger);
			}
			.legend {
				color: var(--klh-dim);
				font-size: 10.5px;
				margin-top: var(--klh-space-3);
			}
			.attn {
				border: 1px solid var(--klh-danger-edge);
				background: var(--klh-danger-wash);
				border-radius: 2px;
				padding: var(--klh-space-2) var(--klh-space-3);
				margin: var(--klh-space-2) 0;
				font-size: var(--klh-text-md);
			}
			.attn b {
				color: var(--klh-danger-ink);
			}
			.attn .sub {
				color: var(--klh-ink-2);
				font-size: var(--klh-text-sm);
			}
			.attn.kind_masked {
				border-color: var(--klh-accent-dim);
				background: var(--klh-accent-wash);
			}
			.empty {
				color: var(--klh-dim);
				font-size: var(--klh-text-sm);
				font-style: italic;
			}
			@media (max-width: 760px) {
				.flow {
					grid-template-columns: 1fr;
				}
			}
		`];live=null;err="";timer=null;constructor(){super();this.heading="Gateway flow",this.src="300",this.paused=!1}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),5000)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){if(this.paused)return;let a=await W(this.src);if(a)this.live=a,this.err="";else this.err="refresh failed — last known values shown";this.requestUpdate()}selectWindow(a){this.src=a.target.value,this.refresh()}togglePause(){if(this.paused=!this.paused,!this.paused)this.refresh()}render(){let a=this.live,s=this.err?e`<p class="dimpl" role="alert">${this.err}</p>`:t;if(!a)return e`<h2>${this.heading}</h2>
				<p class="dimpl">loading…</p>`;if(!a.ok)return e`<h2>${this.heading}</h2>
				${s}<div class="errbox">${a.reason}</div>`;return e`<h2>${this.heading} · window ${a.windowS/60}m · ${a.senders.length} senders</h2>
			<div class="bar">
				<label class="win">window
					<select
						aria-label="flow window"
						@change=${this.selectWindow}
					>
						${I.map((o)=>e`<option value=${o.value} ?selected=${o.value===this.src}>${o.label}</option>`)}
					</select>
				</label>
				<button
					type="button"
					class="live"
					aria-pressed=${this.paused?"false":"true"}
					@click=${this.togglePause}
				>
					${this.paused?"resume":"live"}
				</button>
				<span class="spacer"></span>
				<span class="dimpl">since ${a.windowStart.slice(11,19)}Z</span>
			</div>
			${s}
			${this.attention(a.attention)}
			<div class="flow">
				<div>
					<p class="colTitle">Senders</p>
					${a.senders.length?a.senders.map((o)=>this.senderNode(o,a.gateway.requests)):e`<p class="empty">no requests in window</p>`}
				</div>
				<div>
					<p class="colTitle">Gateway</p>
					<div
						class="node gatewayNode"
						title=${`${a.gateway.requests} requests · ${a.gateway.errors} errors · ${a.gateway.active} active (admitted, not ended) · window ${a.windowS/60}m since ${a.windowStart}`}
					>
						<div class="rate">${a.gateway.reqPerS}<span class="sub"> req/s</span></div>
						<div class="count">${a.gateway.requests} req</div>
						<div class="count">${a.gateway.active} active</div>
						${a.gateway.errors?e`<div class="count err">${a.gateway.errors} err</div>`:t}
						${this.sparkline(a.gateway.series)}
					</div>
				</div>
				<div>
					<p class="colTitle">Targets</p>
					${this.targets(a.targets)}
				</div>
			</div>
			${this.coverage(a)}
			<p class="legend">
				edge: solid = named lane · dashed = companion · dotted = unattributed —
				width = share of window requests · <span class="dot masked"></span>masked
				by guardrail · <span class="dot blocked"></span>blocked at gateway ·
				hover a node for its trace
			</p>`}senderNode(a,s){let o=a.lane?U(a.lane):a.actor?`actor ${a.actor.slice(0,8)}`:"internal",l=s>0?Math.max(6,a.requests/s*100):6,i=a.lane?a.lane.startsWith("autow")?"companion":"api_key":"internal",d=[`${a.lane||"(no lane)"}`,`${a.requests} requests · ${a.errors} errors · ${a.active} active`,`${a.reqPerS} req/s`,`last ${new Date(a.lastAt).toISOString().slice(11,19)}Z`].join(" · ");return e`<div class="node" title=${d} tabindex="0">
				<span class="who">${o}</span>
				<span class="count"> ${a.requests} req</span>
				${a.active?e`<span class="count"> · ${a.active} active</span>`:t}
				${a.errors?e`<span class="count err"> · ${a.errors} err</span>`:t}
			</div>
			<div
				class="edge ${i}"
				title=${`${o} → gateway · ${l.toFixed(0)}% of window requests`}
			></div>`}targets(a){if(!a.length)return e`<p class="empty">
				no attributed targets in window (no ledger join rows)
			</p>`;let s=H.map((i)=>({heading:i.heading,mine:a.filter((d)=>d.kind===i.kind)})).filter((i)=>i.mine.length),o=a.filter((i)=>i.kind!=="model"&&i.kind!=="upstream"),l=o.length?[...s,{heading:"OTHER",mine:o}]:s;return e`${l.map((i)=>e`<p class="colTitle">${i.heading}</p>
				${i.mine.map((d)=>this.targetNode(d))}`)}`}targetNode(a){let s=`${a.kind} · ${a.name} · ${a.requests} requests · ${a.errors} errors · ${a.reqPerS} req/s · last ${a.lastAt.slice(11,19)}Z`;return e`<div class="node" title=${s} tabindex="0">
			<span class="who">${a.name}</span>
			<span class="count"> ${a.requests} req</span>
			${a.errors?e`<span class="count err"> · ${a.errors} err</span>`:t}
		</div>`}attention(a){if(!a.length)return e`<p class="dimpl">no attention signals in window</p>`;return e`${a.map((s)=>e`<div class="attn kind_${s.kind}">
				<b>${s.subject}</b>
				<div class="sub">${s.detail} (${s.n})</div>
			</div>`)}`}sparkline(a){if(!a?.length)return e`${t}`;let s=Math.max(...a.map((c)=>c.requests),1),o=100,l=24,i=o/Math.max(a.length-1,1),d=a.map((c,q)=>`${(q*i).toFixed(1)},${(l-c.requests/s*(l-2)-1).toFixed(1)}`).join(" "),S=a[a.length-1];return e`<svg
			class="spark"
			viewBox="0 0 ${o} ${l}"
			preserveAspectRatio="none"
			role="img"
			aria-label=${`requests per 30s over the window, latest ${S.requests}`}
		>
			<polyline
				fill="none"
				stroke="var(--klh-accent)"
				stroke-width="1.5"
				points=${d}
			/>
		</svg>`}coverage(a){let s=a.coverage,o=[];if(!s.projectionAvailable)o.push("projection db unavailable");if(!s.ledgerAvailable)o.push("ledger unavailable — targets unattributed");if(s.sendersTruncated>0)o.push(`${s.sendersTruncated} senders past cap`);if(s.targetsTruncated>0)o.push(`${s.targetsTruncated} targets past cap`);if(!o.length)return e`${t}`;return e`<p class="legend" role="note">${o.join(" · ")}</p>`}}if(!customElements.get("klh-gateway-flow-card"))customElements.define("klh-gateway-flow-card",v);var k=(a,s)=>a.flatMap((o,l)=>l?[e`${s}`,o]:[o]);class w extends n{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[u];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;if(a.kind==="missing")return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no routing-policy.yaml found on the belt chain (BELT_POLICY/
					BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)
				</p>`;if(a.kind==="no-gateway")return e`<h2>${this.heading}</h2>
				<p class="dimpl">policy resolved but no gateway section parsed</p>`;if(a.kind==="error")return e`<h2>${this.heading}</h2>
				<div class="errbox">
					resolved ${a.path} does not parse: ${a.error}
				</div>`;let s=a.gateway;return e`<h2>${this.head(a.path,a.source)}</h2>
			${s?e`
						<div class="knobs">
							<span class="kchip">num_retries: <b>${s.num_retries}</b></span>
							<span class="kchip">
								allowed_fails: <b>${s.allowed_fails}</b>
							</span>
							<span class="kchip">
								cooldown_time: <b>${s.cooldown_time}s</b>
							</span>
						</div>
						${this.compact?t:this.ladder(s.fallbacks)}
					`:t}${this.foot?e`<p class="cfoot">${this.foot}</p>`:t}`}head(a,s){let o=this.heading;if(a)o+=` · ${a}`;if(s)o+=` · source: ${s}`;return o}ladder(a){let s=Object.entries(a);if(this.compact&&s.length)return e`<span class="kchip">
				ladder: <b>${k(this.chips(s)," · ")}</b>
			</span>`;if(this.compact)return e`${t}`;return e`<table class="ct ladder">
			<thead>
				<tr>
					<th>model</th>
					<th>fallback ladder (order = priority)</th>
				</tr>
			</thead>
			<tbody>
				${s.map((o)=>e`<tr>
						<td><b>${o[0]}</b></td>
						<td>${k(this.pills(o[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(a){return a.map((s)=>e`${s[0]} → ${s[1].length} tiers`)}pills(a){return a.map((s,o)=>e`<span class="pill">${o+1}. ${s}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",w);class f extends n{static properties={heading:{type:String},data:{type:Object}};static styles=[u];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;if(!a.groups)return e`<h2>Upstream pool</h2>
				<p class="dimpl">
					upstreams.yaml unreadable — the ladder above still applies
				</p>`;return e`<h2>${this.heading} · ${a.source}</h2>${this.table(a.groups)}`}table(a){return e`<table class="ct">
			<thead>
				<tr>
					<th>group</th>
					<th>deployments</th>
					<th>state</th>
					<th>source</th>
				</tr>
			</thead>
			<tbody>
				${a.map((s)=>this.row(s))}
			</tbody>
		</table>
		<p class="cfoot">
			Deployment counts merge the fleet default with machine overrides.
			Reachability is shown by the endpoint checks above.
		</p>`}row(a){let s=a.dormant?e`<span class="dimpl">dormant</span>`:e`<span>configured</span>`;return e`<tr>
			<td><b>${a.name}</b></td>
			<td class="num">${a.tiers}</td>
			<td>${s}</td>
			<td>${a.source}</td>
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",f);class b extends n{static properties={heading:{type:String},data:{type:Object}};static styles=[u];constructor(){super();this.heading="Registered services",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(a)}`}body(a){return e`<table class="ct">
			<thead>
				<tr>
					<th>Service</th>
					<th>Scope</th>
					<th>Upstream</th>
					<th>Observation</th>
				</tr>
			</thead>
			<tbody>
				${a.rows.map((s)=>this.row(s))}
			</tbody>
		</table>
		<p class="cfoot">
			Route registration is configuration; local endpoint evidence is shown
			below. <a href="https://bar.local/">Inspect Caddy checks and mDNS
			claims</a>
		</p>`}row(a){return e`<tr>
			<td><a href="https://${a.name}.local/">${a.name}.local</a></td>
			<td><span class="pill">${a.scope}</span></td>
			<td class="mono">${a.upstream}</td>
			<td>${a.monitored}</td>
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",b);class y extends n{static properties={heading:{type:String},data:{type:Object}};static styles=[u];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(a)}`}body(a){if(a.error)return e`<div class="errbox">
				current file does not parse: ${a.error}
			</div>`;return e`<div class="knobs">
			${a.knobs.map((s)=>e`<span class="kchip">${s.k}: <b>${s.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",y);class x extends n{static properties={heading:{type:String},data:{type:Object}};static styles=[u,r`
		.auditrow { border-top:1px solid var(--klh-rule); font-size:11.5px; }
		.auditrow summary { display:flex; gap:10px; align-items:baseline; padding:5px 0; cursor:pointer; list-style:none; }
		.auditrow summary::-webkit-details-marker { display:none; }
		.auditrow summary::before { content:'+'; color:var(--klh-accent); }
		.auditrow[open] summary::before { content:'−'; }
		.auditrow .when { margin-left:auto; color:var(--klh-dim); white-space:nowrap; }
		.auditrow .detail { padding:2px 12px 9px; color:var(--klh-ink-2); overflow-wrap:anywhere; }
		.auditolder { border-top:1px solid var(--klh-rule); margin-top:7px; padding-top:7px; }
		.auditolder > summary { cursor:pointer; color:var(--klh-accent); font:11px var(--klh-font-mono); }
	`];constructor(){super();this.heading="admin audit",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;if(!a.rows.length)return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no admin actions recorded yet — settings/policy applies and key
					revocations land here
				</p>`;let s=a.rows.slice(0,5),o=a.rows.slice(5);return e`<h2>${this.heading} · ${a.rows.length} recent actions</h2>
			${s.map((l)=>this.chip(l))}
			${o.length?e`<details class="auditolder"><summary>Earlier actions (${o.length})</summary>${o.map((l)=>this.chip(l))}</details>`:t}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`}chip(a){return e`<details class="auditrow">
			<summary><b>${a.action}</b><span>${a.actor}</span><span class="when mono">${a.when}</span></summary>
			<div class="detail">${a.target??"—"}${a.detail?e`<br />${a.detail}`:t}</div>
		</details>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",x);
