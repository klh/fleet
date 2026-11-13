import{n,e,t,o}from"./lit-ac8284bbd881cce8.js";import{p}from"./lit-2644f18657b50e8c.js";import{H,Te,B,w,de,f,ze,h,s,Pe,pe,Ae,Dr,Lr,jr,Ur,Fr,it,qr,at,R,b,he,ct,me,lt,r,K,m,g,ut,dt,pt,W,V,J,G,Ie,Ne,ht,mt,ft,gt,vt,bt,kt,yt,xt,$t,c,De,M,l,wt,_t,St,Et,Tt,zt,Pt,At,Rt,Mt,Ot,Ct,Zt,It,Nt,Dt,Lt,jt,Ut,Le,Ft,fe,qt,Ht,Bt,I,Kt,Y,X,Wt,Q,Vt,Jt,Gt,ee,Qt,N,er,te,tr,rr,nr,or,sr,ir,ar,re,cr,lr,ur,dr,pr,hr,mr,fr,gr,vr,br,kr,yr,xr,$r,wr,_r,Sr,Er,Tr,zr,Pr,ge,ve,be,ke,ne,Ar,oe,se,Rr,ye,ie,xe,ae,$e,we,D,_e,Ue,Fe,qe,He,Be,Ke,T,We,Ve,Je,Ge,Ye,Mr,Or,Cr}from"./lit-12a9a3472000c1cd.js";import{L,j}from"./lit-0d2d66cf0f7716f4.js";var En=Object.defineProperty;var Cn=(a)=>a;function An(a,i){this[a]=Cn.bind(null,i)}var Jn=(a,i)=>{for(var u in i)En(a,u,{get:i[u],enumerable:!0,configurable:!0,set:An.bind(i,u)})};var Xt={};Jn(Xt,{ZodISODate:()=>ot,ZodISODateTime:()=>rt,ZodISODuration:()=>st,ZodISOTime:()=>nt,date:()=>va,datetime:()=>ya,duration:()=>ka,time:()=>ba});var Oe=(a)=>{if(a===null||!Number.isFinite(a))return"—";if(Math.abs(a)>=1e6)return`${(a/1e6).toFixed(1)}M`;if(Math.abs(a)>=1000)return`${(a/1000).toFixed(1)}k`;return String(a)},jn=(a)=>a===null?"unknown":a<90?`${a}s`:`${Math.round(a/60)}m`,Mn=(a)=>{if(a===null)return 1;if(a>=100)return 4;if(a>=20)return 3;if(a>=5)return 2;return 1},Un=n`
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
`,Fn=(a)=>Math.max(0,Math.round((Date.now()-Date.parse(a))/1000)),lo=(a)=>a.gateway?e`<p>
				<span class="hname">local spoke</span>
				<span class=${a.gateway.state==="up"?"live":"hot"}>
					${a.gateway.state}</span
				>
				<span class="unknown">· ${a.gateway.detail}</span>
			</p>`:e`<p>
				<span class="hname">local spoke</span>
				<span class="unknown">not in the probe map</span>
			</p>`,Ln=(a)=>{let i=a.lifecycle;if(!i.loss.length&&!i.rows.length)return e`<div class="hrow">
			<span class="hname">lifecycle</span>
			<span class="unknown">no projected events here</span>
		</div>`;return e`<div class="hrow">
		<span class="hname">lifecycle · loss</span>
		<span class="num">emitted ${i.totals.emitted}</span>
		<span class="num">observed ${i.totals.observed}</span>
		<span class="num ${i.totals.gaps>0?"hot":""}">gaps ${i.totals.gaps}</span>
	</div>
	${i.loss.filter((u)=>u.gaps>0).map((u)=>e`<div class="hrow">
				<span class="hname">${u.source}</span>
				<span class="num hot">gap ${u.gaps} of ${u.emitted}</span>
			</div>`)}
		<details class="routes">
			<summary>Lifecycle sample · ${i.rows.length}</summary>
			<div class="routesBody">
				${i.rows.length?i.rows.map((u)=>e`<div class="hrow">
							<time class="unknown" datetime=${new Date(u.admittedAt).toISOString()} title=${L(u.admittedAt)}>${j(u.admittedAt)}</time>
							<span class="title">${u.model??"?"}</span>
							<span class="unknown">${u.lane?`lane ${u.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
							<span class="num">${u.outcome??"in flight"}</span>
							<span class="num">${u.attemptsAgree?`att ${u.edgeAttempts??"?"} ok`:`att p${u.edgeAttempts??"?"}/l${u.ledgerAttempts??"?"} drift`}</span>
						</div>`):e`<p class="unknown">no joined rows</p>`}
			</div>
		</details>`},qn=(a)=>e`
	<div class="hrow">
		<span class="hname">hubs (observed)</span>
		${a.hubs.length?t:e`<span class="unknown">no projection db wired here</span>`}
	</div>
	${a.hubs.map((i)=>e`<div class="hrow">
			<span class="hname">${i.source}</span>
			<span class="num">active ${i.active}</span>
			<span class="num">${i.requests} req</span>
			<span class="num ${i.errors>0?"hot":""}">${i.errors} err</span>
			<span class="unknown">obs age ${i.freshness.ageS===null?"unknown":`${i.freshness.ageS}s`} · seq ${i.freshness.lastSeq??"?"}</span>
		</div>`)}
	${a.hops.length?e`<div class="hrow">
				<span class="hname">forwarding edges</span>
				${a.hops.map((i)=>e`<span class="num">${i.origin||"local"} → ${i.peer} (${i.n})</span>`)}
			</div>`:t}
	${a.unsettled.length?e`<div class="hrow">
				<span class="hname">unsettled</span>
				${a.unsettled.map((i)=>e`<span class="num">${i.kind}: ${i.n}</span>`)}
			</div>`:t}
	${Ln(a)}`,Bn=(a)=>{let i=a.out60===null?null:Math.round(a.out60/60);return e`<div class="hrow">
		<span class="hname">${a.kind} · ${a.host??"unknown"}${a.port?`:${a.port}`:""}</span>
		<span class="num">${a.model??""}</span>
		<span class="num">${a.req60} req/60s</span>
		<span class="num ${i===null?"":i>=100?"hot":"live"}">
			${i===null?"tok/s unknown":`${i} tok/s`}
		</span>
		<span class="num">15m: ${a.req15} req · out ${Oe(a.out15)}</span>
		<span
			class="bar"
			style="width:${Mn(i)*14}px;background:var(--klh-edge)"
		></span>
	</div>`},Gn=(a)=>e`<div class="routeRow">
	<time class="unknown" datetime=${a.ts} title=${L(a.ts)}>${j(a.ts)}</time>
	<span class="title">${a.target_model??"model unknown"}</span>
	<span class="unknown" title=${a.lane||"No lane attribution"}>${a.lane?`lane ${a.lane.replace(/^autow([\d.]+)-.*/,"W$1")}`:"unattributed"}</span>
	<span class="num">${a.target_kind??"?"} ${a.target_host??""}</span>
	<span class="num">${a.duration_ms===null?"—":`${a.duration_ms}ms`}</span>
	<span class="num">in ${Oe(a.in_tok)} · out ${Oe(a.out_tok)}</span>
</div>`,Kr=(a)=>{let i=new Date(`${a}:00Z`);if(Number.isNaN(i.getTime()))return a;let u=(y)=>String(y).padStart(2,"0");return`${u(i.getDate())}.${u(i.getMonth()+1)} ${u(i.getHours())}:00`},Wn=(a)=>{let i=a.throughput.buckets.slice(0,12).reverse(),u=Math.max(1,...i.map((v)=>v.out_tok)),y=i[0],d=i[i.length-1];return e`<div class="netMetrics" aria-label="Last 15 minutes">
			<div class="netMetric"><span>requests · 15m</span><strong>${a.throughput.window.requests}</strong></div>
			<div class="netMetric"><span>input tokens · 15m</span><strong>${Oe(a.throughput.window.in_tok)}</strong></div>
			<div class="netMetric"><span>output tokens · 15m</span><strong>${Oe(a.throughput.window.out_tok)}</strong></div>
		</div>
		<p class="unknown">
			${a.observations.available?"Hub observations available":"Hub observations are not collected here"}
		</p>
		<div class="hourPlot">
			<div class="hourHeading"><span class="hname">Recorded output · last 12 hours</span><span class="unknown">peak ${Oe(u)} tok/hour</span></div>
				<div class="hourSeries" role="img" aria-label="Recorded output tokens by hour, oldest to newest">
					${i.map((v)=>e`<span class="hourBar"
							style="height:${v.out_tok?Math.max(2,Math.round(v.out_tok/u*80)):0}px"
							title="${Kr(v.hour)} · ${v.requests} req · out ${Oe(v.out_tok)} tok"
						></span>`)}
				</div>
				<div class="hourRange"><span>${y?Kr(y.hour):""}</span><span>${d?Kr(d.hour):""}</span></div>
		</div>`},Vn=(a)=>a.model_health.down.length===0?e`<div class="hrow">
				<span class="hname">model health</span>
				<span class="unknown">no DOWN groups in fresh facts</span>
			</div>`:e`<div class="hrow">
				<span class="hname">model health</span>
				${a.model_health.down.map((i)=>e`<span class="num hot">DOWN ${i}</span>`)}
			</div>`,Kn=(a)=>{let i=a.network;if(!i.ok)return e`${lo(a)}
			<p class="unknown">${i.reason}</p>`;return e`${lo(a)}
		${Vn(a)}
		${Wn(i)}
		${qn(i)}
		${i.throughput.interfaces.length?i.throughput.interfaces.map(Bn):e`<div class="hrow">
					<span class="hname">interfaces</span>
					<span class="unknown">no settled traffic in window</span>
				</div>`}
		<details class="routes">
			<summary>Recent settled routes · ${i.routes.length}</summary>
			<div class="routesBody">
				<div class="routeHead"><span>Time</span><span>Model</span><span>Lane</span><span>Target</span><span>Latency</span><span>Tokens</span></div>
				${i.routes.length?i.routes.map(Gn):e`<p class="unknown">No settled routes yet</p>`}
			</div>
		</details>
		<p class="legend">
			edge width 1-4px = measured output tok/s (60s): ≥100 → 4 · ≥20 → 3 ·
			≥5 → 2 · else 1 · null = unknown (gray), never zero
		</p>`},Hn=async()=>{try{let a=await fetch("/api/console/network",{cache:"no-store"});if(!a.ok)return null;return await a.json()}catch{return null}};class uo extends o{static properties={heading:{type:String},data:{type:Object}};static styles=[p,Un];live=null;err="";timer=null;constructor(){super();this.heading="",this.data=null}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),1e4)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){let a=await Hn();if(a)this.live=a,this.err="";else this.err="refresh failed — last known values shown"}render(){let a=this.live??this.data;if(!a)return e`<h2>${this.heading}</h2><p class="dimpl">loading…</p>`;let i=this.err?e`<p class="unknown">${this.err}</p>`:t;return e`<h2>${this.heading} · live ${jn(Fn(a.ts))}</h2>
			${i}${Kn(a)}`}}customElements.define("klh-network-card",uo);var Yn=[{value:"60",label:"1 min"},{value:"300",label:"5 min"},{value:"600",label:"10 min"}],Xn=[{heading:"MODELS",kind:"model"},{heading:"UPSTREAMS",kind:"upstream"}],Qn=(a)=>a.replace(/^autow([\d.]+)-.*/,"W$1"),es=async(a)=>{try{let i=await fetch(`/api/console/flow?window=${a}`,{cache:"no-store"});if(!i.ok)return null;return await i.json()}catch{return null}};class po extends o{static properties={heading:{type:String},src:{type:String},paused:{type:Boolean}};static styles=[p,n`
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
		`];live=null;err="";timer=null;constructor(){super();this.heading="Gateway flow",this.src="300",this.paused=!1}connectedCallback(){super.connectedCallback(),this.refresh(),this.timer=setInterval(()=>void this.refresh(),5000)}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer)}async refresh(){if(this.paused)return;let a=await es(this.src);if(a)this.live=a,this.err="";else this.err="refresh failed — last known values shown";this.requestUpdate()}selectWindow(a){this.src=a.target.value,this.refresh()}togglePause(){if(this.paused=!this.paused,!this.paused)this.refresh()}render(){let a=this.live,i=this.err?e`<p class="dimpl" role="alert">${this.err}</p>`:t;if(!a)return e`<h2>${this.heading}</h2>
				<p class="dimpl">loading…</p>`;if(!a.ok)return e`<h2>${this.heading}</h2>
				${i}<div class="errbox">${a.reason}</div>`;return e`<h2>${this.heading} · window ${a.windowS/60}m · ${a.senders.length} senders</h2>
			<div class="bar">
				<label class="win">window
					<select
						aria-label="flow window"
						@change=${this.selectWindow}
					>
						${Yn.map((u)=>e`<option value=${u.value} ?selected=${u.value===this.src}>${u.label}</option>`)}
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
			${i}
			${this.attention(a.attention)}
			<div class="flow">
				<div>
					<p class="colTitle">Senders</p>
					${a.senders.length?a.senders.map((u)=>this.senderNode(u,a.gateway.requests)):e`<p class="empty">no requests in window</p>`}
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
			</p>`}senderNode(a,i){let u=a.lane?Qn(a.lane):a.actor?`actor ${a.actor.slice(0,8)}`:"internal",y=i>0?Math.max(6,a.requests/i*100):6,d=a.lane?a.lane.startsWith("autow")?"companion":"api_key":"internal",v=[`${a.lane||"(no lane)"}`,`${a.requests} requests · ${a.errors} errors · ${a.active} active`,`${a.reqPerS} req/s`,`last ${new Date(a.lastAt).toISOString().slice(11,19)}Z`].join(" · ");return e`<div class="node" title=${v} tabindex="0">
				<span class="who">${u}</span>
				<span class="count"> ${a.requests} req</span>
				${a.active?e`<span class="count"> · ${a.active} active</span>`:t}
				${a.errors?e`<span class="count err"> · ${a.errors} err</span>`:t}
			</div>
			<div
				class="edge ${d}"
				title=${`${u} → gateway · ${y.toFixed(0)}% of window requests`}
			></div>`}targets(a){if(!a.length)return e`<p class="empty">
				no attributed targets in window (no ledger join rows)
			</p>`;let i=Xn.map((d)=>({heading:d.heading,mine:a.filter((v)=>v.kind===d.kind)})).filter((d)=>d.mine.length),u=a.filter((d)=>d.kind!=="model"&&d.kind!=="upstream"),y=u.length?[...i,{heading:"OTHER",mine:u}]:i;return e`${y.map((d)=>e`<p class="colTitle">${d.heading}</p>
				${d.mine.map((v)=>this.targetNode(v))}`)}`}targetNode(a){let i=`${a.kind} · ${a.name} · ${a.requests} requests · ${a.errors} errors · ${a.reqPerS} req/s · last ${a.lastAt.slice(11,19)}Z`;return e`<div class="node" title=${i} tabindex="0">
			<span class="who">${a.name}</span>
			<span class="count"> ${a.requests} req</span>
			${a.errors?e`<span class="count err"> · ${a.errors} err</span>`:t}
		</div>`}attention(a){if(!a.length)return e`<p class="dimpl">no attention signals in window</p>`;return e`${a.map((i)=>e`<div class="attn kind_${i.kind}">
				<b>${i.subject}</b>
				<div class="sub">${i.detail} (${i.n})</div>
			</div>`)}`}sparkline(a){if(!a?.length)return e`${t}`;let i=Math.max(...a.map((x)=>x.requests),1),u=100,y=24,d=u/Math.max(a.length-1,1),v=a.map((x,_)=>`${(_*d).toFixed(1)},${(y-x.requests/i*(y-2)-1).toFixed(1)}`).join(" "),k=a[a.length-1];return e`<svg
			class="spark"
			viewBox="0 0 ${u} ${y}"
			preserveAspectRatio="none"
			role="img"
			aria-label=${`requests per 30s over the window, latest ${k.requests}`}
		>
			<polyline
				fill="none"
				stroke="var(--klh-accent)"
				stroke-width="1.5"
				points=${v}
			/>
		</svg>`}coverage(a){let i=a.coverage,u=[];if(!i.projectionAvailable)u.push("projection db unavailable");if(!i.ledgerAvailable)u.push("ledger unavailable — targets unattributed");if(i.sendersTruncated>0)u.push(`${i.sendersTruncated} senders past cap`);if(i.targetsTruncated>0)u.push(`${i.targetsTruncated} targets past cap`);if(!u.length)return e`${t}`;return e`<p class="legend" role="note">${u.join(" · ")}</p>`}}if(!customElements.get("klh-gateway-flow-card"))customElements.define("klh-gateway-flow-card",po);class fo extends Error{constructor(){super("Cannot parse a reference cycle that closes through a transform");this.name="ZodCyclicError"}}var Yr="~memo",mo=[];function ho(a){return a!==null&&typeof a==="object"}function Hr(a){return a.map((i)=>i.path?{...i,path:i.path.slice()}:{...i})}var go=new WeakMap,je=0,Ir=1,Me=2;function Jr(a,i,u){let y=go.get(a);if(y!==void 0)return y?Me:je;if(i.has(a))return Me;i.add(a);let d=je,v=(O)=>{if(d!==Me&&O?._zod){let Z=Jr(O,i,u);if(Z>d)d=Z}},k=(O,Z)=>{let P=je;for(let z of Reflect.ownKeys(O)){let E=Object.getOwnPropertyDescriptor(O,z);if(Z&&!E.enumerable)continue;let ue=E.get?Ir:E.value?._zod?Jr(E.value,i,u):je;if(ue>P)P=ue}return P},x=(O)=>{if(O>d)d=O},_=a._zod.def,S=_.type;switch(S){case"object":{let O=de(_);x(O?k(O,!0):Ir),v(_.catchall);break}case"array":v(_.element);break;case"tuple":for(let O of _.items)v(O);v(_.rest);break;case"record":case"map":v(_.keyType),v(_.valueType);break;case"set":v(_.valueType);break;case"union":for(let O of _.options)v(O);break;case"intersection":v(_.left),v(_.right);break;case"optional":case"nullable":case"default":case"prefault":case"catch":case"readonly":case"nonoptional":case"promise":case"success":v(_.innerType);break;case"pipe":v(_.in),v(_.out);break;case"function":v(_.input),v(_.output);break;case"lazy":{let O=_._cachedInner??(u?a._zod.innerType:void 0);x(O?Jr(O,i,!1):Ir);break}case"template_literal":case"string":case"number":case"int":case"boolean":case"bigint":case"symbol":case"undefined":case"null":case"void":case"never":case"any":case"unknown":case"date":case"nan":case"enum":case"literal":case"file":case"transform":case"custom":break;default:for(let O in _){let Z=Object.getOwnPropertyDescriptor(_,O);if(!Z||Z.get)continue;let P=Z.value;if(!P||typeof P!=="object")continue;if(P._zod)v(P);else if(Array.isArray(P))for(let z of P)v(z)}}return i.delete(a),ts(a,d)}function ts(a,i){if(i!==Ir)go.set(a,i===Me);return i}function rs(a,i){let u=a.buckets.get(i);if(!u)u=new WeakMap,a.buckets.set(i,u);return u}var Zr,Nr=[],os={alloc(a,i,u){let y=Zr;if(!y)return u;Zr=void 0;let d={value:u,issues:null};return y.set(i.value,d),Nr.push(d),u},guard(a){var i;(i=a._zod).deferred??(i.deferred=[]),a._zod.deferred.push(()=>{let u=a._zod.parse,y=(d,v)=>{if(v.direction!=="backward"&&ns(v,d.value))throw new fo;return u(d,v)};if(a._zod.parse=y,a._zod.run===u)a._zod.run=y})},attach(a){var i;let u,y=!1,d,v;(i=a._zod).deferred??(i.deferred=[]),a._zod.deferred.push(()=>{let k=a._zod.parse,x=(_,S)=>{if(u===void 0){let ce=Jr(a,new Set,!1);if(ce===je){if(a._zod.parse=k,a._zod.run===x)a._zod.run=k;return k(_,S)}if(ce===Me||y)u=!0;else y=!0}let O=_.value;if(!ho(O))return k(_,S);let Z=S[Yr];if(!Z)Z={buckets:new WeakMap,backEdges:void 0},S[Yr]=Z;let P;if(d===S)P=v;else P=rs(Z,a),d=S,v=P;let z=P.get(O);if(z){if(_.value=z.value,z.issues){if(z.issues.length)_.issues.push(...Hr(z.issues))}else _.memo=!0,Z.backEdges??(Z.backEdges=new WeakSet),Z.backEdges.add(z.value);return _}Zr=P;let E=Nr.length,ue=k(_,S);Zr=void 0;let U=Nr.length>E?Nr.pop():void 0;if(ue instanceof Promise)return ue.then((ce)=>{if(U)U.issues=ce.issues.length?Hr(ce.issues):mo;return ce});if(U)U.issues=ue.issues.length?Hr(ue.issues):mo;return ue};if(a._zod.parse=x,a._zod.run===k)a._zod.run=x})}};function yo(){return os}function ns(a,i){let u=a[Yr]?.backEdges;return u!==void 0&&ho(i)&&u.has(i)}var ss=()=>{let a={string:{unit:"characters",verb:"to have"},file:{unit:"bytes",verb:"to have"},array:{unit:"items",verb:"to have"},set:{unit:"items",verb:"to have"},map:{unit:"entries",verb:"to have"}};function i(v){return a[v]??null}let u={regex:"input",email:"email address",url:"URL",emoji:"emoji",uuid:"UUID",uuidv4:"UUIDv4",uuidv6:"UUIDv6",nanoid:"nanoid",guid:"GUID",cuid:"cuid",cuid2:"cuid2",ulid:"ULID",xid:"XID",ksuid:"KSUID",datetime:"ISO datetime",date:"ISO date",time:"ISO time",duration:"ISO duration",ipv4:"IPv4 address",ipv6:"IPv6 address",mac:"MAC address",cidrv4:"IPv4 range",cidrv6:"IPv6 range",base64:"base64-encoded string",base64url:"base64url-encoded string",json_string:"JSON string",e164:"E.164 number",currency_code:"currency code",credit_card:"credit card number",iban:"IBAN",jwt:"JWT",template_literal:"input"},y={nan:"NaN"};function d(v,k){if(v==="number"&&typeof k==="number"&&!Number.isFinite(k))return String(k);return y[v]??v}return(v)=>{switch(v.code){case"invalid_type":{let k=d(v.expected),x=at(v.input),_=d(x,v.input);return`Invalid input: expected ${k}, received ${_}`}case"invalid_value":if(v.values.length===1)return`Invalid input: expected ${Pe(v.values[0])}`;return`Invalid option: expected one of ${Te(v.values,"|")}`;case"too_big":{let k=v.exact?"exactly ":v.inclusive?"<=":"<",x=i(v.origin);if(x)return`Too big: expected ${v.origin??"value"} to have ${k}${v.maximum.toString()} ${x.unit??"elements"}`;return`Too big: expected ${v.origin??"value"} to be ${k}${v.maximum.toString()}`}case"too_small":{let k=v.exact?"exactly ":v.inclusive?">=":">",x=i(v.origin);if(x)return`Too small: expected ${v.origin} to have ${k}${v.minimum.toString()} ${x.unit}`;return`Too small: expected ${v.origin} to be ${k}${v.minimum.toString()}`}case"invalid_format":{let k=v;if(k.format==="starts_with")return`Invalid string: must start with "${k.prefix}"`;if(k.format==="ends_with")return`Invalid string: must end with "${k.suffix}"`;if(k.format==="includes")return`Invalid string: must include "${k.includes}"`;if(k.format==="regex")return`Invalid string: must match pattern ${k.pattern}`;return`Invalid ${u[k.format]??v.format}`}case"not_multiple_of":return`Invalid number: must be a multiple of ${v.divisor}`;case"unrecognized_keys":return`Unrecognized key${v.keys.length>1?"s":""}: ${Te(v.keys,", ")}`;case"invalid_key":return`Invalid key in ${v.origin}`;case"invalid_union":if(v.options&&Array.isArray(v.options)&&v.options.length>0)return`Invalid discriminator value. Expected ${v.options.map((x)=>`'${x}'`).join(" | ")}`;if(v.inclusive===!1)return"Invalid input: more than one option matched";return"Invalid input";case"invalid_element":return`Invalid value in ${v.origin}`;default:return"Invalid input"}}};function Xr(){return{localeError:ss()}}var vo;class bo{constructor(){this._map=new WeakMap,this._idmap=new Map}add(a,...i){let u=i[0];if(this._map.set(a,u),u&&typeof u==="object"&&"id"in u)this._idmap.set(u.id,a);return this}clear(){return this._map=new WeakMap,this._idmap=new Map,this}remove(a){let i=this._map.get(a);if(i&&typeof i==="object"&&"id"in i)this._idmap.delete(i.id);return this._map.delete(a),this}get(a){let i=a._zod.parent;if(i){let u={...this.get(i)??{}};delete u.id;let y={...u,...this._map.get(a)};return Object.keys(y).length?y:void 0}return this._map.get(a)}has(a){return this._map.has(a)}}function as(){return new bo}(vo=globalThis).__zod_globalRegistry??(vo.__zod_globalRegistry=as());var Ze=globalThis.__zod_globalRegistry;function Qe(a,...i){for(let u of i)for(let y of Reflect.ownKeys(u))if(Object.prototype.propertyIsEnumerable.call(u,y))w(a,y,u[y]);return a}function eo(a){let i=a?.target??"draft-2020-12";if(i==="draft-4")i="draft-04";if(i==="draft-7")i="draft-07";return{processors:a.processors??{},metadataRegistry:a?.metadata??Ze,target:i,unrepresentable:a?.unrepresentable??"throw",override:a?.override??(()=>{}),io:a?.io??"output",counter:0,seen:new Map,sharedDefsExtractedFor:void 0,sharedEmitDoneFor:void 0,cycles:a?.cycles??"ref",reused:a?.reused??"inline",intersections:[],deferred:[],external:a?.external??void 0}}function Re(a,i,u,y,d){let v=typeof i.unrepresentable==="function"?i.unrepresentable({zodSchema:a,path:y.path,message:d}):i.unrepresentable;if(v==="any")return!1;if(v===void 0||v==="throw")throw Error(d);return Object.assign(u,v),!0}function F(a,i,u={path:[],schemaPath:[]}){var y;let d=a._zod.def,v=i.seen.get(a);if(v){if(v.count++,u.schemaPath.includes(a))v.cycle=u.path;return v.schema}let k={schema:{},count:1,cycle:void 0,path:u.path};i.seen.set(a,k),i.sharedDefsExtractedFor=void 0,i.sharedEmitDoneFor=void 0;let x=a._zod.toJSONSchema?.();if(x)k.schema=x;else{let O={...u,schemaPath:[...u.schemaPath,a],path:u.path};if(a._zod.processJSONSchema)a._zod.processJSONSchema(i,k.schema,O);else{let P=k.schema,z=i.processors[d.type];if(!z)throw Error(`[toJSONSchema]: Non-representable type encountered: ${d.type}`);z(a,i,P,O)}let Z=a._zod.parent;if(Z){if(!k.ref)k.ref=Z;F(Z,i,O),i.seen.get(Z).isParent=!0}}let _=i.metadataRegistry.get(a);if(_)Qe(k.schema,_);if(i.io==="input"&&q(a))delete k.schema.examples,delete k.schema.default;if(i.io==="input"&&"_prefault"in k.schema)(y=k.schema).default??(y.default=k.schema._prefault);return delete k.schema._prefault,i.seen.get(a).schema}function ko(a){return a.replace(/~/g,"~0").replace(/\//g,"~1")}function to(a,i){let u=a.seen.get(i);if(!u)throw Error("Unprocessed schema. This is a bug in Zod.");if(a.external&&a.sharedDefsExtractedFor===a.external)return;let y=new Map;for(let k of a.seen.entries()){let x=a.metadataRegistry.get(k[0])?.id;if(x){let _=y.get(x);if(_&&_!==k[0])throw Error(`Duplicate schema id "${x}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);y.set(x,k[0])}}let d=(k)=>{let x=a.target==="draft-2020-12"?"$defs":"definitions";if(a.external){let Z=a.external.registry.get(k[0])?.id,P=a.external.uri??((E)=>E);if(Z)return{ref:P(Z)};let z=k[1].defId??k[1].schema.id??`schema${a.counter++}`;return k[1].defId=z,{defId:z,ref:`${P("__shared")}#/${x}/${ko(z)}`}}let _="#",S=`${_}/${x}/`;if(k[1]===u&&!k[1].schema.id)return{ref:_};let O=k[1].schema.id??`__schema${a.counter++}`;return{defId:O,ref:S+ko(O)}},v=(k)=>{if(k[1].schema.$ref)return;let x=k[1],{ref:_,defId:S}=d(k);if(x.def={...x.schema},S)x.defId=S;let O=x.schema;for(let Z in O)delete O[Z];O.$ref=_};if(a.cycles==="throw")for(let k of a.seen.entries()){let x=k[1];if(x.cycle)throw Error(`Cycle detected: #/${x.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`)}for(let k of a.seen.entries()){let x=k[1];if(i===k[0]){v(k);continue}if(a.external){let S=a.external.registry.get(k[0])?.id;if(i!==k[0]&&S){v(k);continue}}if(a.metadataRegistry.get(k[0])?.id){v(k);continue}if(x.cycle){v(k);continue}if(x.count>1){if(a.reused==="ref")v(k)}}if(a.external)a.sharedDefsExtractedFor=a.external}function $o(a){let i=a.anyOf;if(!Array.isArray(i)||i.length===0||a.type!==void 0)return;let u=[];for(let y of i){if(!y||typeof y!=="object")return;$o(y);let d=Object.keys(y);if(d.length!==1||d[0]!=="type")return;let v=y.type;for(let k of Array.isArray(v)?v:[v]){if(typeof k!=="string")return;if(!u.includes(k))u.push(k)}}delete a.anyOf,a.type=u.length===1?u[0]:u}var _o=new Set(["type","properties","required","additionalProperties"]),xo=["oneOf","anyOf"];function wo(a){let i=a.additionalProperties;if(i===void 0||i===!1||typeof i!=="object"||i===null)return null;return Object.keys(i).length?i:null}function Qr(a){let i=[];for(let v of a){if(typeof v!=="object"||v.type!=="object")return null;for(let k in v)if(!_o.has(k))return null;i.push(v)}let u={},y=new Set;for(let v of i){for(let k in v.properties){if(Object.prototype.hasOwnProperty.call(u,k))continue;let x=[];for(let S of i){let O=S.properties?.[k]??wo(S);if(O===null||O===void 0)continue;if(!x.some((Z)=>JSON.stringify(Z)===JSON.stringify(O)))x.push(O)}let _=x.length===1?x[0]:Qr(x)??{allOf:x};w(u,k,_)}for(let k of v.required??[])y.add(k)}let d={type:"object",properties:u};if(y.size)d.required=[...y];if(i.every((v)=>v.additionalProperties===!1))d.additionalProperties=!1;else{let v=[];for(let k of i){let x=wo(k);if(x&&!v.some((_)=>JSON.stringify(_)===JSON.stringify(x)))v.push(x)}if(v.length===1)d.additionalProperties=v[0];else if(v.length>1)d.additionalProperties={allOf:v}}return d}function is(a){let i=a.allOf;if(!Array.isArray(i)||i.length<2)return;for(let d of _o)if(d in a)return;let u=i.filter((d)=>xo.some((v)=>Array.isArray(d[v]))),y=null;if(!u.length)y=Qr(i);else{let d=u[0],v=xo.find((_)=>Array.isArray(d[_]));if(Object.keys(d).length!==1)return;let k=i.filter((_)=>_!==d),x=d[v].map((_)=>Qr([...k,_]));if(x.some((_)=>!_))return;y={[v]:x}}if(!y)return;delete a.allOf,Qe(a,y)}function ro(a,i){let u=a.seen.get(i);if(!u)throw Error("Unprocessed schema. This is a bug in Zod.");let y=(x)=>{let _=a.seen.get(x);if(_.ref===null)return;let S=_.def??_.schema,O={...S},Z=_.ref;if(_.ref=null,Z){y(Z);let z=a.seen.get(Z),E=z.schema;if(E.$ref&&(a.target==="draft-07"||a.target==="draft-04"||a.target==="openapi-3.0"))S.allOf=S.allOf??[],S.allOf.push(E);else Qe(S,E);if(Qe(S,O),x._zod.parent===Z)for(let U in S){if(U==="$ref"||U==="allOf")continue;if(!(U in O))delete S[U]}if(E.$ref&&z.def)for(let U in S){if(U==="$ref"||U==="allOf")continue;if(U in z.def&&JSON.stringify(S[U])===JSON.stringify(z.def[U]))delete S[U]}}let P=x._zod.parent;if(P&&P!==Z){y(P);let z=a.seen.get(P);if(z?.schema.$ref){if(S.$ref=z.schema.$ref,z.def)for(let E in S){if(E==="$ref"||E==="allOf")continue;if(E in z.def&&JSON.stringify(S[E])===JSON.stringify(z.def[E]))delete S[E]}}}a.override({zodSchema:x,jsonSchema:S,path:_.path??[]})};if(!a.external||a.sharedEmitDoneFor!==a.external){for(let x of[...a.seen.entries()].reverse())y(x[0]);if(a.target!=="openapi-3.0")for(let x of a.seen.entries())$o(x[1].def??x[1].schema);for(let x of a.deferred)x();if(a.intersections.length){let x=new Map;for(let _ of a.seen.values())for(let S of[_.schema,_.def]){let O=S?.allOf;if(!Array.isArray(O))continue;let Z=x.get(O);if(Z)Z.push(S);else x.set(O,[S])}for(let _ of a.intersections)for(let S of x.get(_)??[])is(S)}}let d={};if(a.target==="draft-2020-12")d.$schema="https://json-schema.org/draft/2020-12/schema";else if(a.target==="draft-07")d.$schema="http://json-schema.org/draft-07/schema#";else if(a.target==="draft-04")d.$schema="http://json-schema.org/draft-04/schema#";else if(a.target==="openapi-3.0");if(a.external?.uri){let x=a.external.registry.get(i)?.id;if(!x)throw Error("Schema is missing an `id` property");d.$id=a.external.uri(x)}Qe(d,u.defId?u.schema:u.def??u.schema);let v=a.metadataRegistry.get(i)?.id;if(v!==void 0&&d.id===v)delete d.id;let k=a.external?.defs??{};if(!a.external||a.sharedEmitDoneFor!==a.external)for(let x of a.seen.entries()){let _=x[1];if(_.def&&_.defId){if(_.def.id===_.defId)delete _.def.id;w(k,_.defId,_.def)}}if(a.external)a.sharedEmitDoneFor=a.external;if(a.external);else if(Object.keys(k).length>0)if(a.target==="draft-2020-12")d.$defs=k;else d.definitions=k;try{let x=JSON.parse(JSON.stringify(d));return Object.defineProperty(x,"~standard",{value:{...i["~standard"],jsonSchema:{input:et(i,"input",a.processors),output:et(i,"output",a.processors)}},enumerable:!1,writable:!1}),x}catch(x){throw Error("Error converting schema to JSON.")}}function q(a,i){let u=i??{seen:new Set};if(u.seen.has(a))return!1;u.seen.add(a);let y=a._zod.def;if(y.type==="transform")return!0;if(y.type==="array")return q(y.element,u);if(y.type==="set")return q(y.valueType,u);if(y.type==="lazy")return q(y.getter(),u);if(y.type==="promise"||y.type==="optional"||y.type==="nonoptional"||y.type==="nullable"||y.type==="readonly"||y.type==="default"||y.type==="prefault"||y.type==="catch")return q(y.innerType,u);if(y.type==="intersection")return q(y.left,u)||q(y.right,u);if(y.type==="record"||y.type==="map")return q(y.keyType,u)||q(y.valueType,u);if(y.type==="pipe"){if(a._zod.traits.has("$ZodCodec"))return!0;return q(y.in,u)||q(y.out,u)}if(y.type==="object"){for(let d in y.shape)if(q(y.shape[d],u))return!0;return!1}if(y.type==="union"){for(let d of y.options)if(q(d,u))return!0;return!1}if(y.type==="tuple"){for(let d of y.items)if(q(d,u))return!0;if(y.rest&&q(y.rest,u))return!0;return!1}return!1}var So=(a,i={})=>(u)=>{let y=eo({...u,processors:i});return F(a,y),to(y,a),ro(y,a)},et=(a,i,u={})=>(y)=>{let{libraryOptions:d,target:v}=y??{},k=eo({...d??{},target:v,io:i,processors:u});return F(a,k),to(k,a),ro(k,a)};var Ee=(a,i,u)=>{if(a[i]===void 0||u>a[i])a[i]=u},Ce=(a,i,u)=>{if(a[i]===void 0||u<a[i])a[i]=u},Oo=(a,i)=>{Ee(a,"minimum",i),Ce(a,"maximum",i)},No=(a,i)=>{if(a.multipleOf??(a.multipleOf=[]),!a.multipleOf.includes(i))a.multipleOf.push(i)},Io=(a,i)=>{a.patterns??(a.patterns=new Set),a.patterns.add(i)},Ro=(a,i)=>{a.mime=a.mime?a.mime.filter((u)=>i.includes(u)):[...i]},Do=(a,i)=>{if(a.format=i,i.includes("int"))a.isInt=!0},Zo=(a,i)=>Ee(a,"minimum",i.minimum),zo=(a,i)=>Ce(a,"maximum",i.maximum),Po=(a)=>(i,u)=>{Do(i,u.format);let[y,d]=a[u.format];Ee(i,"minimum",y),Ce(i,"maximum",d)},cs={greater_than:(a,i)=>Ee(a,i.inclusive?"minimum":"exclusiveMinimum",i.value),less_than:(a,i)=>Ce(a,i.inclusive?"maximum":"exclusiveMaximum",i.value),multiple_of:(a,i)=>No(a,i.value),number_format:Po(pe),bigint_format:Po(Ae),min_length:Zo,max_length:zo,length_equals:(a,i)=>Oo(a,i.length),min_size:Zo,max_size:zo,size_equals:(a,i)=>Oo(a,i.size),string_format:(a,i)=>{if(Do(a,i.format),i.pattern)Io(a,i.pattern);if(i.format==="base64"||i.format==="base64url")a.contentEncoding=i.format;if(i.local||i.precision===-1)a.laxFormat=!0},mime_type:(a,i)=>Ro(a,i.mime)};function Se(a){let i={},u=a._zod.def,y=a._zod.traits.has("$ZodCheck")?[a,...u.checks??[]]:u.checks??[];for(let v of y)cs[v._zod.def.check]?.(i,v._zod.def);let d=a._zod.bag;if(d.minimum!==void 0)Ee(i,"minimum",d.minimum);if(d.exclusiveMinimum!==void 0)Ee(i,"exclusiveMinimum",d.exclusiveMinimum);if(d.maximum!==void 0)Ce(i,"maximum",d.maximum);if(d.exclusiveMaximum!==void 0)Ce(i,"exclusiveMaximum",d.exclusiveMaximum);if(d.multipleOf!==void 0)No(i,d.multipleOf);if(d.format!==void 0){if(i.format??(i.format=d.format),d.format.includes("int"))i.isInt=!0}if(d.mime)Ro(i,d.mime);for(let v of d.patterns??[])Io(i,v);return i}var ls={guid:"uuid",url:"uri",datetime:"date-time",json_string:"json-string",regex:""},us=new Map([[Le,xt],[fe,$t]]),ds=(a)=>us.get(a)??a,Eo=(a,i,u,y)=>{let d=u;d.type="string";let{minimum:v,maximum:k,format:x,patterns:_,contentEncoding:S,laxFormat:O}=Se(a);if(typeof v==="number")d.minLength=v;if(typeof k==="number")d.maxLength=k;if(x){if(d.format=ls[x]??x,d.format==="")delete d.format;if(x==="time"||O)delete d.format}if(S)d.contentEncoding=S;if(_&&_.size>0){let Z=[..._].map(ds);if(Z.length===1)d.pattern=Z[0].source;else if(Z.length>1)d.allOf=[...Z.map((P)=>({...i.target==="draft-07"||i.target==="draft-04"||i.target==="openapi-3.0"?{type:"string"}:{},pattern:P.source}))]}},Co=(a,i,u,y)=>{let d=u,{minimum:v,maximum:k,multipleOf:x,exclusiveMaximum:_,exclusiveMinimum:S,isInt:O}=Se(a);d.type=O?"integer":"number";let Z=typeof S==="number"&&S>=(v??Number.NEGATIVE_INFINITY),P=typeof _==="number"&&_<=(k??Number.POSITIVE_INFINITY),z=i.target==="draft-04"||i.target==="openapi-3.0";if(Z)if(z)d.minimum=S,d.exclusiveMinimum=!0;else d.exclusiveMinimum=S;else if(typeof v==="number")d.minimum=v;if(P)if(z)d.maximum=_,d.exclusiveMaximum=!0;else d.exclusiveMaximum=_;else if(typeof k==="number")d.maximum=k;if(x){let E=new Set;for(let ce of x)if(Number.isFinite(ce)&&ce!==0)E.add(Math.abs(ce));else Re(a,i,d,y,`A multipleOf divisor of ${ce} cannot be represented in JSON Schema`);let[ue,...U]=E;if(ue!==void 0)d.multipleOf=ue;if(U.length)d.allOf=[...d.allOf??[],...U.map((ce)=>({multipleOf:ce}))]}},Ao=(a,i,u,y)=>{u.type="boolean"};var Jo=(a,i,u,y)=>{u.not={}};var jo=(a,i,u,y)=>{};var Mo=(a,i,u,y)=>{let d=a._zod.def,v=H(d.entries);if(v.length===0){u.not={};return}if(v.every((k)=>typeof k==="number"))u.type="number";if(v.every((k)=>typeof k==="string"))u.type="string";u.enum=v};var Uo=(a,i,u,y)=>{Re(a,i,u,y,"Custom types cannot be represented in JSON Schema")};var Fo=(a,i,u,y)=>{Re(a,i,u,y,"Transforms cannot be represented in JSON Schema")};var Lo=(a,i,u,y)=>{let d=u,v=a._zod.def,{minimum:k,maximum:x}=Se(a);if(typeof k==="number")d.minItems=k;if(typeof x==="number")d.maxItems=x;d.type="array",d.items=F(v.element,i,{...y,path:[...y.path,"items"]})};function oo(a){let i=a._zod.def;if(i.type==="pipe"&&i.in._zod.traits.has("$ZodTransform"))return oo(i.out);if(i.type==="catch")return oo(i.innerType);return a._zod.optin}var qo=(a,i,u,y)=>{let d=u,v=a._zod.def,k=v.shape;if(Object.getOwnPropertySymbols(k).length&&Re(a,i,d,y,"Symbol keys cannot be represented in JSON Schema"))return;d.type="object",d.properties={};for(let S in k)w(d.properties,S,F(k[S],i,{...y,path:[...y.path,"properties",S]}));let _=[];for(let S of Object.keys(k)){let O=v.shape[S];if(i.io==="input"?oo(O)===void 0:O._zod.optout===void 0)_.push(S)}if(_.length>0)d.required=_;if(v.catchall?._zod.def.type==="never")d.additionalProperties=!1;else if(!v.catchall){if(i.io==="output")d.additionalProperties=!1}else if(v.catchall)d.additionalProperties=F(v.catchall,i,{...y,path:[...y.path,"additionalProperties"]})},Bo=(a,i,u,y)=>{let d=a._zod.def,v=d.inclusive===!1,k=d.options.map((x,_)=>F(x,i,{...y,path:[...y.path,v?"oneOf":"anyOf",_]}));if(v)u.oneOf=k;else u.anyOf=k},Go=(a,i,u,y)=>{let d=a._zod.def,v=F(d.left,i,{...y,path:[...y.path,"allOf",0]}),k=F(d.right,i,{...y,path:[...y.path,"allOf",1]}),x=(S)=>("allOf"in S)&&Object.keys(S).length===1,_=[...x(v)?v.allOf:[v],...x(k)?k.allOf:[k]];u.allOf=_,i.intersections.push(_)};var Wo=(a,i,u,y)=>{let d=a._zod.def,v=F(d.innerType,i,y),k=i.seen.get(a);if(i.target==="openapi-3.0")k.ref=d.innerType,u.nullable=!0;else u.anyOf=[v,{type:"null"}]},Vo=(a,i,u,y)=>{let d=a._zod.def;F(d.innerType,i,y);let v=i.seen.get(a);v.ref=d.innerType},no=Symbol();function Ko(a,i,u,y,d){let v=!1,k=JSON.stringify(a,(x,_)=>{if(typeof _!=="bigint")return _;return v=!0,null});if(!v)return JSON.parse(k);return Re(i,u,y,d,"BigInt defaults cannot be represented in JSON Schema"),no}var Ho=(a,i,u,y)=>{let d=a._zod.def;F(d.innerType,i,y);let v=i.seen.get(a);v.ref=d.innerType;let k=Ko(d.defaultValue,a,i,u,y);if(k!==no)u.default=k},Yo=(a,i,u,y)=>{let d=a._zod.def;F(d.innerType,i,y);let v=i.seen.get(a);if(v.ref=d.innerType,i.io!=="input")return;let k=Ko(d.defaultValue,a,i,u,y);if(k!==no)u._prefault=k},Xo=(a,i,u,y)=>{let d=a._zod.def;F(d.innerType,i,y);let v=i.seen.get(a);v.ref=d.innerType;let k;try{k=d.catchValue(void 0)}catch{Re(a,i,u,y,"Dynamic catch values are not supported in JSON Schema");return}u.default=k},Qo=(a,i,u,y)=>{let d=a._zod.def,v=d.in._zod.traits.has("$ZodTransform"),k=i.io==="input"?v?d.out:d.in:d.out;F(k,i,y);let x=i.seen.get(a);x.ref=k},en=(a,i,u,y)=>{let d=a._zod.def;F(d.innerType,i,y);let v=i.seen.get(a);v.ref=d.innerType,u.readOnly=!0};var so=(a,i,u,y)=>{let d=a._zod.def;F(d.innerType,i,y);let v=i.seen.get(a);v.ref=d.innerType};var tn=new WeakSet([Object.prototype,Error.prototype]);function Br(a,i,u){Object.defineProperty(a,i,{configurable:!0,enumerable:!1,get(){let y=u(this);return Object.defineProperty(this,i,{value:y,configurable:!0,writable:!0}),y},set(y){Object.defineProperty(this,i,{value:y,configurable:!0,writable:!0})}})}var ks=(a,i)=>{ut.init(a,i),a.name="ZodError";let u=Object.getPrototypeOf(a);if(tn.has(u))return;tn.add(u),Br(u,"format",(y)=>(d)=>pt(y,d)),Br(u,"flatten",(y)=>(d)=>dt(y,d)),Br(u,"addIssue",(y)=>(d)=>{y.issues.push(d),y.message=JSON.stringify(y.issues,B,2)}),Br(u,"addIssues",(y)=>(d)=>{y.issues.push(...d),y.message=JSON.stringify(y.issues,B,2)}),Object.defineProperty(u,"isEmpty",{configurable:!0,enumerable:!1,get(){return this.issues.length===0}})};var le=r("ZodError",ks,void 0,{Parent:Error});var rn=W(le),on=V(le),nn=J(le),sn=G(le),an=ht(le),cn=mt(le),ln=ft(le),un=gt(le),dn=vt(le),pn=bt(le),mn=kt(le),fn=yt(le);function ws(){if(!m.localeError)g(Xr())}function io(){if(!m.memoizer)g({memoizer:yo()})}var A=r("ZodType",(a,i)=>(ws(),c.init(a,i),a.def=i,a.type=i.type,a),{check(...a){let i=this.def;return this.clone(f(i,{checks:[...i.checks??[],...a.map((u)=>typeof u==="function"?{_zod:{check:u,def:{check:"custom"},onattach:[]}}:u)]}),{parent:!0})},with(...a){return this.check(...a)},clone(a,i){return h(this,a,i)},brand(){return this},register(a,i){return a.add(this,i),this},refine(a,i){return this.check(ha(a,i))},superRefine(a,i){return this.check(ga(a,i))},overwrite(a){return this.check(T(a))},optional(){return yn(this)},exactOptional(){return ra(this)},nullable(){return vn(this)},nullish(){return yn(vn(this))},nonoptional(a){return ca(this,a)},array(){return Wr(this)},or(a){return Ys([this,a])},and(a){return Qs(this,a)},transform(a){return bn(this,ta(a))},default(a){return sa(this,a)},prefault(a){return ia(this,a)},catch(a){return ua(this,a)},pipe(a){return bn(this,a)},readonly(){return ma(this)},describe(a){let i=this.clone();return Ze.add(i,{description:a}),i},meta(...a){if(a.length===0)return Ze.get(this);let i=this.clone();return Ze.add(i,a[0]),i},isOptional(){return this.safeParse(void 0).success},isNullable(){return this.safeParse(null).success},apply(a,...i){return i.length===0?a(this):a(this,...i)},get "~standard"(){return he(this,"~standard",{...De(this),jsonSchema:{input:et(this,"input"),output:et(this,"output")}})},set "~standard"(a){b(this,"~standard",a)},parse:function a(i,u){return rn(this,i,u,{callee:a})},parseAsync:async function a(i,u){return await on(this,i,u,{callee:a})},safeParse(a,i){return nn(this,a,i)},async safeParseAsync(a,i){return sn(this,a,i)},get spa(){return this?.safeParseAsync},set spa(a){b(this,"spa",a)},validate(a,i){return Ie(this,a,i)},validateAsync(a,i){return Ne(this,a,i)},encode:function a(i,u){return an(this,i,u,{callee:a})},decode:function a(i,u){return cn(this,i,u,{callee:a})},encodeAsync:async function a(i,u){return await ln(this,i,u,{callee:a})},decodeAsync:async function a(i,u){return await un(this,i,u,{callee:a})},safeEncode(a,i){return dn(this,a,i)},safeDecode(a,i){return pn(this,a,i)},async safeEncodeAsync(a,i){return mn(this,a,i)},async safeDecodeAsync(a,i){return fn(this,a,i)},toJSONSchema(a){return So(this,{})(a)},get description(){return Ze.get(this)?.description},get _def(){return this._zod.def}}),kn=r("_ZodString",(a,i)=>{M.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Eo(a,u,y,d)},ct({format:(a)=>Se(a).format??null,minLength:(a)=>Se(a).minimum??null,maxLength:(a)=>Se(a).maximum??null},{regex(...a){return this.check(Ue(...a))},includes(...a){return this.check(He(...a))},startsWith(...a){return this.check(Be(...a))},endsWith(...a){return this.check(Ke(...a))},min(...a){return this.check(D(...a))},max(...a){return this.check(we(...a))},length(...a){return this.check(_e(...a))},nonempty(...a){return this.check(D(1,...a))},lowercase(a){return this.check(Fe(a))},uppercase(a){return this.check(qe(a))},trim(){return this.check(Ve())},normalize(...a){return this.check(We(...a))},toLowerCase(){return this.check(Je())},toUpperCase(){return this.check(Ge())},slugify(){return this.check(Ye())}})),$s=r("ZodString",(a,i)=>{M.init(a,i),kn.init(a,i)},{email(a){return this.check(cr(_s,a))},url(a){return this.check(mr(Os,a))},jwt(a){return this.check(Pr(Us,a))},emoji(a){return this.check(fr(Zs,a))},guid(a){return this.check(lr(Ss,a))},uuid(a){return this.check(ur(Gr,a))},uuidv4(a){return this.check(dr(Gr,a))},uuidv6(a){return this.check(pr(Gr,a))},uuidv7(a){return this.check(hr(Gr,a))},nanoid(a){return this.check(gr(zs,a))},cuid(a){return this.check(vr(Ps,a))},cuid2(a){return this.check(br(Ts,a))},ulid(a){return this.check(kr(Ns,a))},base64(a){return this.check(Er(Js,a))},base64url(a){return this.check(Tr(js,a))},xid(a){return this.check(yr(Is,a))},ksuid(a){return this.check(xr(Rs,a))},ipv4(a){return this.check($r(Ds,a))},ipv6(a){return this.check(wr(Es,a))},cidrv4(a){return this.check(_r(Cs,a))},cidrv6(a){return this.check(Sr(As,a))},e164(a){return this.check(zr(Ms,a))},datetime(a){return this.check(ge(rt,a))},date(a){return this.check(ve(ot,a))},time(a){return this.check(be(nt,a))},duration(a){return this.check(ke(st,a))}});function co(a){return re($s,a)}var C=r("ZodStringFormat",(a,i)=>{l.init(a,i),kn.init(a,i)}),rt=r("ZodISODateTime",(a,i)=>{Ct.init(a,i),C.init(a,i)}),ot=r("ZodISODate",(a,i)=>{Zt.init(a,i),C.init(a,i)}),nt=r("ZodISOTime",(a,i)=>{It.init(a,i),C.init(a,i)}),st=r("ZodISODuration",(a,i)=>{Nt.init(a,i),C.init(a,i)}),_s=r("ZodEmail",(a,i)=>{St.init(a,i),C.init(a,i)});var Ss=r("ZodGUID",(a,i)=>{wt.init(a,i),C.init(a,i)});var Gr=r("ZodUUID",(a,i)=>{_t.init(a,i),C.init(a,i)});var Os=r("ZodURL",(a,i)=>{Et.init(a,i),C.init(a,i)});var Zs=r("ZodEmoji",(a,i)=>{Tt.init(a,i),C.init(a,i)});var zs=r("ZodNanoID",(a,i)=>{zt.init(a,i),C.init(a,i)});var Ps=r("ZodCUID",(a,i)=>{Pt.init(a,i),C.init(a,i)});var Ts=r("ZodCUID2",(a,i)=>{At.init(a,i),C.init(a,i)});var Ns=r("ZodULID",(a,i)=>{Rt.init(a,i),C.init(a,i)});var Is=r("ZodXID",(a,i)=>{Mt.init(a,i),C.init(a,i)});var Rs=r("ZodKSUID",(a,i)=>{Ot.init(a,i),C.init(a,i)});var Ds=r("ZodIPv4",(a,i)=>{Dt.init(a,i),C.init(a,i)});var Es=r("ZodIPv6",(a,i)=>{Lt.init(a,i),C.init(a,i)});var Cs=r("ZodCIDRv4",(a,i)=>{jt.init(a,i),C.init(a,i)});var As=r("ZodCIDRv6",(a,i)=>{Ut.init(a,i),C.init(a,i)});var Js=r("ZodBase64",(a,i)=>{Ft.init(a,i),C.init(a,i)});var js=r("ZodBase64URL",(a,i)=>{qt.init(a,i),C.init(a,i)});var Ms=r("ZodE164",(a,i)=>{Ht.init(a,i),C.init(a,i)});var Us=r("ZodJWT",(a,i)=>{Bt.init(a,i),C.init(a,i)});var xn=r("ZodNumber",(a,i)=>{I.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Co(a,u,y,d),a.isFinite=!0},ct({minValue:(a)=>{let{minimum:i,exclusiveMinimum:u}=Se(a);return Math.max(i??Number.NEGATIVE_INFINITY,u??Number.NEGATIVE_INFINITY)},maxValue:(a)=>{let{maximum:i,exclusiveMaximum:u}=Se(a);return Math.min(i??Number.POSITIVE_INFINITY,u??Number.POSITIVE_INFINITY)},isInt:(a)=>{let{isInt:i,multipleOf:u}=Se(a);return!!i||!!u?.some(Number.isSafeInteger)},format:(a)=>Se(a).format??null},{gt(a,i){return this.check(xe(a,i))},gte(a,i){return this.check(ae(a,i))},min(a,i){return this.check(ae(a,i))},lt(a,i){return this.check(ye(a,i))},lte(a,i){return this.check(ie(a,i))},max(a,i){return this.check(ie(a,i))},int(a){return this.check(hn(a))},safe(a){return this.check(hn(a))},positive(a){return this.check(xe(0,a))},nonnegative(a){return this.check(ae(0,a))},negative(a){return this.check(ye(0,a))},nonpositive(a){return this.check(ie(0,a))},multipleOf(a,i){return this.check($e(a,i))},step(a,i){return this.check($e(a,i))},finite(){return this}}));function wn(a){return ne(xn,a)}var Fs=r("ZodNumberFormat",(a,i)=>{Kt.init(a,i),xn.init(a,i)});function hn(a){return Ar(Fs,a)}var Ls=r("ZodBoolean",(a,i)=>{Y.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Ao(a,u,y,d)});function qs(a){return oe(Ls,a)}var Bs=r("ZodUnknown",(a,i)=>{X.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>jo(a,u,y,d)});function gn(){return se(Bs)}var Gs=r("ZodNever",(a,i)=>{Wt.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Jo(a,u,y,d)});function Ws(a){return Rr(Gs,a)}var Vs=r("ZodArray",(a,i)=>{io(),Q.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Lo(a,u,y,d),a.element=i.element},{min(a,i){return this.check(D(a,i))},nonempty(a){return this.check(D(1,a))},max(a,i){return this.check(we(a,i))},length(a,i){return this.check(_e(a,i))},unwrap(){return this.element}});function Wr(a,i){return Mr(Vs,a,i)}var Ks=r("ZodObject",(a,i)=>{io(),Vt.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>qo(a,u,y,d),me(a,"shape",(u)=>u._zod.def.shape,!1)},{keyof(){return Yt(Object.keys(this._zod.def.shape))},catchall(a){return this.clone(f(this._zod.def,{catchall:a}))},passthrough(){return this.clone(f(this._zod.def,{catchall:gn()}))},loose(){return this.clone(f(this._zod.def,{catchall:gn()}))},strict(){return this.clone(f(this._zod.def,{catchall:Ws()}))},strip(){return this.clone(f(this._zod.def,{catchall:void 0}))},extend(a){return jr(this,a)},safeExtend(a){return Ur(this,a)},merge(a){return Fr(this,a)},pick(a){return Dr(this,a)},omit(a){return Lr(this,a)},partial(...a){return it($n,this,a[0])},exactPartial(...a){return it(_n,this,a[0],"exactPartial")},required(...a){return qr(Sn,this,a[0])}});function Vr(a,i){let u={type:"object",shape:a??{},...s(i)};return new Ks(u)}var Hs=r("ZodUnion",(a,i)=>{Jt.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Bo(a,u,y,d),a.options=i.options});function Ys(a,i){return new Hs({type:"union",options:a,...s(i)})}var Xs=r("ZodIntersection",(a,i)=>{Gt.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Go(a,u,y,d)});function Qs(a,i){return new Xs({type:"intersection",left:a,right:i})}var ao=r("ZodEnum",(a,i)=>{ee.init(a,i),A.init(a,i),a._zod.processJSONSchema=(y,d,v)=>Mo(a,y,d,v),a.enum=i.entries,a.options=[...a._zod.values];let u=new Set(Object.keys(i.entries));a.extract=(y,d)=>{let v={};for(let k of y)if(u.has(k))v[k]=i.entries[k];else throw Error(`Key ${k} not found in enum`);return new ao({...i,checks:[],...s(d),entries:v})},a.exclude=(y,d)=>{let v={...i.entries};for(let k of y)if(u.has(k))delete v[k];else throw Error(`Key ${k} not found in enum`);return new ao({...i,checks:[],...s(d),entries:v})}});function Yt(a,i){let u=Array.isArray(a)?Object.fromEntries(a.map((y)=>[y,y])):a;return new ao({type:"enum",entries:u,...s(i)})}var ea=r("ZodTransform",(a,i)=>{io(),Qt.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Fo(a,u,y,d),a._zod.parse=(u,y)=>{if(y.direction==="backward")throw new K(a.constructor.name);u.addIssue=(v)=>{if(typeof v==="string")u.issues.push(R(v,u.value,i));else{let k=v;if(k.fatal)k.continue=!1;if(k.code??(k.code="custom"),!("input"in k))k.input=u.value;k.inst??(k.inst=a),u.issues.push(R(k))}};let d=i.transform(u.value,u);if(d instanceof Promise)return d.then((v)=>(u.value=v,u));return u.value=d,u}});function ta(a){return new ea({type:"transform",transform:a})}var $n=r("ZodOptional",(a,i)=>{N.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>so(a,u,y,d),a.unwrap=()=>a._zod.def.innerType});function yn(a){return new $n({type:"optional",innerType:a})}var _n=r("ZodExactOptional",(a,i)=>{er.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>so(a,u,y,d),a.unwrap=()=>a._zod.def.innerType});function ra(a){return new _n({type:"optional",innerType:a})}var oa=r("ZodNullable",(a,i)=>{te.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Wo(a,u,y,d),a.unwrap=()=>a._zod.def.innerType});function vn(a){return new oa({type:"nullable",innerType:a})}var na=r("ZodDefault",(a,i)=>{tr.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Ho(a,u,y,d),a.unwrap=()=>a._zod.def.innerType,a.removeDefault=a.unwrap});function sa(a,i){return new na({type:"default",innerType:a,get defaultValue(){return typeof i==="function"?i():ze(i)}})}var aa=r("ZodPrefault",(a,i)=>{rr.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Yo(a,u,y,d),a.unwrap=()=>a._zod.def.innerType});function ia(a,i){return new aa({type:"prefault",innerType:a,get defaultValue(){return typeof i==="function"?i():ze(i)}})}var Sn=r("ZodNonOptional",(a,i)=>{nr.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Vo(a,u,y,d),a.unwrap=()=>a._zod.def.innerType});function ca(a,i){return new Sn({type:"nonoptional",innerType:a,...s(i)})}var la=r("ZodCatch",(a,i)=>{or.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Xo(a,u,y,d),a.unwrap=()=>a._zod.def.innerType,a.removeCatch=a.unwrap});function ua(a,i){return new la({type:"catch",innerType:a,catchValue:typeof i==="function"?i:lt(i)})}var da=r("ZodPipe",(a,i)=>{sr.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Qo(a,u,y,d),a.in=i.in,a.out=i.out});function bn(a,i){return new da({type:"pipe",in:a,out:i})}var pa=r("ZodReadonly",(a,i)=>{ir.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>en(a,u,y,d),a.unwrap=()=>a._zod.def.innerType});function ma(a){return new pa({type:"readonly",innerType:a})}var fa=r("ZodCustom",(a,i)=>{ar.init(a,i),A.init(a,i),a._zod.processJSONSchema=(u,y,d)=>Uo(a,u,y,d)});function ha(a,i={}){return Or(fa,a,i)}function ga(a,i){return Cr(a,i)}function ya(a){return ge(rt,a)}function va(a){return ve(ot,a)}function ba(a){return be(nt,a)}function ka(a){return ke(st,a)}var xa=Yt(["up","down","unknown"]),Zn=Vr({state:Yt(["unconfigured","configured-unavailable","ready","unknown"]),gateway:xa,connections:wn().int().nonnegative().nullable(),models:wn().int().nonnegative().nullable(),defaultsOnly:qs(),checkedAt:Xt.datetime().optional()}).strict();var Uc=Vr({generatedAt:Xt.datetime(),models:Wr(Vr({id:co().min(1),exposures:Wr(Vr({evidence:Yt(["configured","catalog","probe"]),state:Yt(["up","down","unknown"]),observedAt:Xt.datetime().optional(),routeModel:co().optional(),routes:Wr(co()).max(1000).optional()})).max(1000)})).max(1e4)});var wa={unconfigured:"Setup needed","configured-unavailable":"Configuration needs attention",ready:"Ready to test",unknown:"Setup check incomplete"};class zn extends o{static properties={data:{type:Object},busy:{state:!0},failed:{state:!0}};static styles=[p,n`
		:host { padding:24px 28px; border-top:3px solid var(--klh-ink); }
		header { display:flex; justify-content:space-between; gap:24px; align-items:start; }
		h2 { margin:0 0 6px; }
		h3 { font:500 23px/1.2 var(--klh-font-sans); letter-spacing:-.02em; margin:0 0 14px; }
		p { margin:0 0 16px; max-width:68ch; }
		table { width:100%; border-collapse:collapse; font-size:13px; }
		th,td { text-align:left; padding:10px 0; border-top:1px solid var(--klh-edge); }
		th { font-weight:500; width:24%; } td { color:var(--klh-dim); }
		footer { display:flex; align-items:center; gap:20px; margin-top:20px; font-size:12px; }
		a { color:var(--klh-ink); text-underline-offset:4px; }
		button { background:var(--klh-ink); color:var(--klh-bg); border:1px solid var(--klh-ink); border-radius:2px; padding:8px 14px; font:inherit; cursor:pointer; }
		button:disabled { opacity:.6; cursor:wait; }
		summary:focus-visible,a:focus-visible,button:focus-visible { outline:2px solid var(--klh-accent); outline-offset:4px; }
		summary { cursor:pointer; font-size:12px; padding:4px 0 8px; }
		.note { font-size:11px; margin:14px 0 0; color:var(--klh-dim); }
		@media(min-width:601px) {
 .compact { display:grid; grid-template-columns:1fr auto; gap:2px 24px; }
 .compact header { grid-column:1; } .compact header div { display:flex; align-items:baseline; gap:16px; }
 .compact h2,.compact h3 { margin:0; } .compact h3 { font-size:20px; }
 .compact > p:not(.note) { grid-column:1; margin:4px 0; font-size:13px; }
 .compact footer { grid-column:2; grid-row:1 / span 2; margin:0; align-self:center; }
 .compact details { grid-column:1; grid-row:3; } .compact .note { grid-column:2; grid-row:3; margin:4px 0 0; text-align:right; }
 }
		@media(max-width:600px) { :host { padding:18px; } th { width:32%; } h3 { font-size:22px; } }
	`];request;constructor(){super();this.data=null,this.busy=!1,this.failed=!1}connectedCallback(){if(super.connectedCallback(),!this.data)this.refresh()}disconnectedCallback(){this.request?.abort(),super.disconnectedCallback()}async refresh(){if(this.busy)return;this.busy=!0;let a=new AbortController;this.request=a;let i=setTimeout(()=>a.abort(),7000),u;try{let y=await fetch("/api/console/gateway-setup",{signal:a.signal,cache:"no-store",redirect:"error"});if(!y.ok||!y.body)throw Error("unavailable");u=y.body.getReader();let d="",v=0,k=new TextDecoder("utf-8",{fatal:!0});for(;;){let _=await u.read();if(_.done)break;if(v+=_.value.length,v>4096)throw Error("oversize");d+=k.decode(_.value,{stream:!0})}d+=k.decode();let x=Zn.parse(JSON.parse(d));if(this.isConnected)this.data=x,this.failed=!1}catch{if(this.isConnected)this.failed=!0}finally{clearTimeout(i),a.abort(),u?.cancel().catch(()=>{}),this.busy=!1}}render(){let a=this.data,i=this.failed?"unknown":a?.state??"unknown",u=i==="unconfigured"?"Add a provider, a peer Buckle or a local model endpoint in Settings.":i==="configured-unavailable"?"Check the gateway and its configured connections in Settings.":i==="ready"?`${a?.connections??0} connections configured. ${a?.models??0} models advertised.`:"Some setup evidence is unavailable. Check again or review Settings; missing observations do not mean zero models.";return e`<section class=${i==="ready"?"compact":""}><header><div><h2>Gateway setup</h2><h3 aria-live="polite">${wa[i]}</h3></div></header>
			<p>${u}</p>
			${this.failed?e`<p role="status">Check unavailable. Previous observations below are retained.</p>`:t}
			<details ?open=${i!=="ready"}><summary>Setup checks</summary><table aria-label="Gateway setup checks"><tbody>
				<tr><th scope="row">Gateway</th><td>${!a||a.gateway==="unknown"?"Not observed":a.gateway==="up"?"Responding to health checks":"Unavailable"}</td></tr>
				<tr><th scope="row">Client access</th><td>Not tested — try an authenticated client.</td></tr>
				<tr><th scope="row">Connections</th><td>${a?.connections==null?"Configuration unreadable":a.defaultsOnly?`${a.connections} shipped presets; operator setup not confirmed`:a.connections===0?"None configured":`${a.connections} connections`}</td></tr>
				<tr><th scope="row">Models</th><td>${a?.models==null?"Current model observations unavailable":a.models===0?a.connections&&!a.defaultsOnly?"No models currently observed":"No models available or configured.":`${a.models} advertised`}</td></tr>
			</tbody></table></details>
			<footer><a href="/console/settings">Settings</a><button type="button" ?disabled=${this.busy} @click=${this.refresh}>${this.busy?"Checking…":"Check again"}</button></footer>
			<p class="note">Checked ${a?.checkedAt?e`<time datetime=${a.checkedAt}>${new Date(a.checkedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</time>`:"time unavailable"} · Request test not run</p></section>`}}if(!customElements.get("klh-gateway-setup-card"))customElements.define("klh-gateway-setup-card",zn);var Pn=(a,i)=>a.flatMap((u,y)=>y?[e`${i}`,u]:[u]);class Tn extends o{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[p];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;if(a.kind==="missing")return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no routing-policy.yaml found on the belt chain (BELT_POLICY/
					BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)
				</p>`;if(a.kind==="no-gateway")return e`<h2>${this.heading}</h2>
				<p class="dimpl">policy resolved but no gateway section parsed</p>`;if(a.kind==="error")return e`<h2>${this.heading}</h2>
				<div class="errbox">
					resolved ${a.path} does not parse: ${a.error}
				</div>`;let i=a.gateway;return e`<h2>${this.head(a.path,a.source)}</h2>
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
					`:t}${this.foot?e`<p class="cfoot">${this.foot}</p>`:t}`}head(a,i){let u=this.heading;if(a)u+=` · ${a}`;if(i)u+=` · source: ${i}`;return u}ladder(a){let i=Object.entries(a);if(this.compact&&i.length)return e`<span class="kchip">
				ladder: <b>${Pn(this.chips(i)," · ")}</b>
			</span>`;if(this.compact)return e`${t}`;return e`<table class="ct ladder">
			<thead>
				<tr>
					<th>model</th>
					<th>fallback ladder (order = priority)</th>
				</tr>
			</thead>
			<tbody>
				${i.map((u)=>e`<tr>
						<td><b>${u[0]}</b></td>
						<td>${Pn(this.pills(u[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(a){return a.map((i)=>e`${i[0]} → ${i[1].length} tiers`)}pills(a){return a.map((i,u)=>e`<span class="pill">${u+1}. ${i}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",Tn);class Nn extends o{static properties={heading:{type:String},data:{type:Object}};static styles=[p];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;if(!a.groups)return e`<h2>Upstream pool</h2>
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
				${a.map((i)=>this.row(i))}
			</tbody>
		</table>
		<p class="cfoot">
			Deployment counts merge the fleet default with machine overrides.
			Reachability is shown by the endpoint checks above.
		</p>`}row(a){let i=a.dormant?e`<span class="dimpl">dormant</span>`:e`<span>configured</span>`;return e`<tr>
			<td><b>${a.name}</b></td>
			<td class="num">${a.tiers}</td>
			<td>${i}</td>
			<td>${a.source}</td>
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",Nn);class In extends o{static properties={heading:{type:String},data:{type:Object}};static styles=[p];constructor(){super();this.heading="Registered services",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(a)}`}body(a){return e`<table class="ct">
			<thead>
				<tr>
					<th>Service</th>
					<th>Scope</th>
					<th>Upstream</th>
					<th>Observation</th>
				</tr>
			</thead>
			<tbody>
				${a.rows.map((i)=>this.row(i))}
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
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",In);class Rn extends o{static properties={heading:{type:String},data:{type:Object}};static styles=[p];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(a)}`}body(a){if(a.error)return e`<div class="errbox">
				current file does not parse: ${a.error}
			</div>`;return e`<div class="knobs">
			${a.knobs.map((i)=>e`<span class="kchip">${i.k}: <b>${i.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",Rn);class Dn extends o{static properties={heading:{type:String},data:{type:Object}};static styles=[p,n`
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
				</p>`;let i=a.rows.slice(0,5),u=a.rows.slice(5);return e`<h2>${this.heading} · ${a.rows.length} recent actions</h2>
			${i.map((y)=>this.chip(y))}
			${u.length?e`<details class="auditolder"><summary>Earlier actions (${u.length})</summary>${u.map((y)=>this.chip(y))}</details>`:t}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`}chip(a){return e`<details class="auditrow">
			<summary><b>${a.action}</b><span>${a.actor}</span><span class="when mono">${a.when}</span></summary>
			<div class="detail">${a.target??"—"}${a.detail?e`<br />${a.detail}`:t}</div>
		</details>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",Dn);
