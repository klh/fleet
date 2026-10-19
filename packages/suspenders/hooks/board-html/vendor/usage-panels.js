import{r,e,t,s}from"./lit-bc7ky2yb.js";var F=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"").head??null}catch{return null}};class S extends s{static properties={head:{type:Object,state:!0}};constructor(){super();this.head=null}connectedCallback(){super.connectedCallback(),this.head=F()}render(){let a=this.head;if(a===null)return t;return e`<h1 class="utitle">${a.title}</h1>
			<div class="uback">
				<a href=${a.backHref}>&larr; ${a.backLabel}</a>
				<span class=${a.note.kind==="on"?"uon":"uwin"}
					>${a.note.text}</span
				>
			</div>
			<div class="ufilters">
				${a.filters.map((l)=>e`<span class="ufgroup" data-label=${l.label}>
						${l.options.map((i)=>e`<a class=${i.on?"ufilter on":"ufilter"} href=${i.href}
									>${i.label}</a
								>`)}
					</span>`)}
			</div>`}}S.styles=r`
	:host {
		display: block;
	}
	a {
		color: var(--klh-accent, #e0a458);
	}
	.utitle {
		font-size: 14px;
		letter-spacing: 0.08em;
		margin: 14px 0 10px;
		color: var(--klh-ink, #e8e6e1);
	}
	.uback {
		display: flex;
		gap: 16px;
		align-items: baseline;
		margin: 12px 0 0;
	}
	.uwin {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
	}
	.uon {
		font-size: 10.5px;
		color: var(--klh-accent, #e0a458);
	}
	.ufilters {
		display: flex;
		gap: 18px;
		align-items: center;
		margin: 12px 0 14px;
		flex-wrap: wrap;
	}
	.ufgroup {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.ufgroup::before {
		content: attr(data-label);
		font-size: 9.5px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.ufilter {
		font-size: 11px;
		color: var(--klh-dim, #98958e);
		text-decoration: none;
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 2px 9px;
	}
	.ufilter.on {
		color: var(--klh-accent, #e0a458);
		border-color: var(--klh-accent, #e0a458);
	}
`;customElements.define("klh-usage-head",S);var g=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),x=(a)=>`${(a*100).toFixed(1)}%`,T=(a,l=!1)=>{if(a===null)return"—";let i=new Date(a);if(Number.isNaN(i.getTime()))return"—";let n=(c)=>String(c).padStart(2,"0"),o=`${n(i.getHours())}:${n(i.getMinutes())}`;return l?`${o}:${n(i.getSeconds())}`:o};class E extends s{static properties={report:{type:Object,state:!0},err:{type:String,state:!0},loading:{type:Boolean,state:!0},lane:{type:String,state:!0},days:{type:Number,state:!0},model:{type:String,state:!0},day:{type:String,state:!0},missOnly:{type:Boolean,state:!0}};constructor(){super();this.report=null,this.err="",this.loading=!0,this.lane="",this.days=7,this.model="",this.day="",this.missOnly=!1}connectedCallback(){super.connectedCallback(),this.refresh()}refresh(){let a=new URLSearchParams;if(a.set("days",String(this.days)),this.lane)a.set("lane",this.lane);if(this.model)a.set("model",this.model);if(this.day)a.set("day",this.day);if(this.missOnly)a.set("miss_only","1");this.loading=!0,this.err="",fetch(`/api/usage/cache-drill?${a.toString()}`,{signal:AbortSignal.timeout(15000)}).then((l)=>{if(!l.ok)throw Error(`HTTP ${String(l.status)}`);return l.json()}).then((l)=>{this.report=l,this.loading=!1}).catch((l)=>{this.err=String(l.message??l),this.loading=!1})}render(){if(this.err)return e`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">drilldown unavailable — ${this.err}</p>
			</div>`;let a=this.report;if(a===null)return e`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">loading…</p>
			</div>`;return e`${this.lanePanel(a)} ${this.scopePanel(a)}`}lanePanel(a){let l=a.hubs.filter((n)=>!n.ok),i=a.hubs.filter((n)=>(n.excluded??0)>0);return e`<div class="upanel">
			<div class="uhead">
				<h2>CACHE EFFICIENCY · WARM RATIO PER LANE</h2>
				<p class="ufoot">
					warm = share of requests that HIT provider cache (cache_read &gt; 0)
					· ${String(a.days)}d window
					${l.length>0?e`· <span class="uwarn"
								>${String(l.length)}/${String(a.hubs.length)} sources
								degraded: ${l.map((n)=>n.label).join(", ")}</span
							>`:t}
				</p>
			</div>
			${this.filterRow(a)}
			${a.overall.requests>a.overall.known?e`<p class="uwarn">Cache verdicts are available for
					${String(a.overall.known)} of ${String(a.overall.requests)}
					requests. Warm rates exclude the rest.</p>`:t}
			${a.probes.requests>0?e`<p class="ufoot">Readiness probes: ${String(a.probes.requests)}
					requests in this window (last ${T(a.probes.last_ts)}), warm
					${a.probes.known>0?x(a.probes.warm_ratio):"—"} — synthetic
					healthcheck traffic, excluded from the lane and model ratios
					above.</p>`:t}
			${a.local_transcripts&&a.local_transcripts.cache_read_tokens>0?e`<p class="ufoot">Local Claude transcripts report
					${g(a.local_transcripts.cache_read_tokens)} cache-read tokens
					across ${g(a.local_transcripts.requests)} requests in this
					window. This total has no Buckle lane attribution${a.local_transcripts.source==="legacy-aggregate"?" and uses the legacy rollup":""}.</p>`:t}
			${l.length>0?e`<p class="uwarn">Missing request data: ${l.map((n)=>`${n.label} (${n.reason??"unavailable"})`).join(", ")}. Rates cover responding sources only.</p>`:t}
			${a.hubs.some((n)=>n.ok&&(n.rawRows??n.rows)>=500)?e`<p class="uwarn">A source reached the 500-request read limit. Rates cover its newest requests only.</p>`:t}
			${i.length>0?e`<p class="uwarn">Excluded non-model audit rows from ${i.map((n)=>n.label).join(", ")}. Those hubs may still use the older request filter, so their 500-row cap can hide model traffic until updated.</p>`:t}
			${this.reasonsTable(a.overall.reasons,"ALL LANES",a.overall.known)}
			${this.modelTable(a.models)}
			${this.laneTable(a.lanes,l.length>0)}
		</div>`}modelTable(a){if(a.length===0)return t;return e`<h3>CACHE BY MODEL</h3>
			<p class="ufoot">partial = some requests have no cache verdict;
				unsupported = declared in machine config; not reported = no provider
				cache field was observed</p>
			<table class="uacts">
				<thead><tr><th>model</th><th class="unum">req</th><th class="unum">verdicts</th><th>warm</th><th class="unum">cache read</th><th>status</th></tr></thead>
				<tbody>${a.map((l)=>e`<tr>
						<td>${l.model}</td><td class="unum">${g(l.requests)}</td>
						<td class="unum">${g(l.known)}</td>
						<td>${l.known>0?x(l.warm_ratio):"—"}</td>
						<td class="unum">${g(l.cache_r_tok)}</td><td>${l.status}</td>
					</tr>`)}</tbody>
			</table>`}filterRow(a){let l=[...new Set(a.lanes.flatMap((n)=>n.models))].sort(),i=[...new Set(a.lanes.flatMap((n)=>n.day_series.map((o)=>o.d)))].sort().reverse();return e`<div class="ufrow">
			<label>
				<span>days</span>
				<select
					@change=${(n)=>{this.days=Number(n.target.value),this.lane="",this.refresh()}}
				>
					${[7,14,28,90].map((n)=>e`<option value=${String(n)} ?selected=${n===this.days}
								>${String(n)}</option
							>`)}
				</select>
			</label>
			<label>
				<span>model</span>
				<select
					@change=${(n)=>{this.model=n.target.value,this.refresh()}}
				>
					${["",...l].map((n)=>e`<option value=${n} ?selected=${n===this.model}
								>${n===""?"any":n}</option
							>`)}
				</select>
			</label>
			<label>
				<span>day</span>
				<select
					@change=${(n)=>{this.day=n.target.value,this.refresh()}}
				>
					${["",...i].map((n)=>e`<option value=${n} ?selected=${n===this.day}
								>${n===""?"all":n}</option
							>`)}
				</select>
			</label>
			<label class="ucheck">
				<input
					type="checkbox"
					?checked=${this.missOnly}
					@change=${(n)=>{this.missOnly=n.target.checked,this.refresh()}}
				/>
				<span>misses only</span>
			</label>
			<span class="uoverall">
				${String(a.overall.requests)} req ·
				${String(a.overall.known)} known · warm
						<b>${a.overall.known>0?x(a.overall.warm_ratio):"—"}</b>
				${this.loading?e`<span class="uempty">· refreshing…</span>`:t}
			</span>
		</div>`}reasonsTable(a,l,i){return e`<h3>MISS REASONS · ${l}</h3>
			${a.length===0?e`<p class="uempty">${i>0?"no cache misses among the requests with reported usage":"no cache verdicts in scope"}</p>`:e`<table class="uacts">
							<thead>
								<tr>
									<th>reason</th>
									<th class="unum">misses</th>
									<th>example rid</th>
									<th>what to do</th>
								</tr>
							</thead>
							<tbody>
								${a.map((n)=>e`<tr>
										<td><b>${n.label}</b></td>
										<td class="unum">${String(n.count)}</td>
										<td class="urid" title=${n.example_rid}>
											${n.example_rid}
										</td>
										<td class="uwhy">${n.detail}</td>
									</tr>`)}
							</tbody>
						</table>`}`}laneTable(a,l){if(a.length===0)return e`<p class="uempty">
				${l?"lane data unavailable from the failed sources":"no requests recorded for this scope"}
			</p>`;let i=Math.max(1,...a.map((n)=>n.requests));return e`<table class="uacts">
			<thead>
				<tr>
					<th>lane</th>
					<th class="unum">req</th>
					<th>warm ratio</th>
					<th class="unum">cache read</th>
					<th class="unum">cache write</th>
					<th>last</th>
				</tr>
			</thead>
			<tbody>
				${a.map((n)=>{let o=n.known>0?n.warm/n.known*100:0;return e`<tr class="ulane">
						<td title=${n.lane}>
							<button class="ulaneButton" type="button" @click=${()=>{this.lane=n.lane,this.refresh()}}>
								<b>${n.models[0]??n.lane}</b>
								${n.models.length>0?e`<span class="ulane-id">${n.lane}</span>`:t}
							</button>
							${n.hubs.map((c)=>e`<span class="uchip">${c}</span>`)}
							${n.models.length>1?e`<span class="uwarn">${String(n.models.length)} models</span>`:t}
						</td>
						<td class="unum">
							${g(n.requests)}
							<span class="ubarslot"
								><i
									class="ureq"
									style=${`width:${String(Math.max(4,n.requests/i*100))}%`}
								></i
							></span>
						</td>
						<td>
							<span class="uwr"
								><i
									class=${o>=50?"uwarm":"ucold"}
									style=${`width:${String(Math.max(2,o))}%`}
									title=${`${x(o/100)} of ${String(n.known)} known`}
								></i
							></span>
							<span class="unum">${n.known>0?x(o/100):"—"}</span>
						</td>
						<td class="unum">${g(n.cache_r_tok)}</td>
						<td class="unum" title=${n.cache_c_known?`${String(n.cache_c_known)} requests reported cache writes`:"Provider did not report cache writes"}>${n.cache_c_known?g(n.cache_c_tok):"—"}</td>
						<td class="unum"><time title=${n.last_ts??"Unknown time"} datetime=${n.last_ts??""}>${T(n.last_ts)}</time></td>
					</tr>`})}
			</tbody>
		</table>`}scopePanel(a){let l=a.lane_scope;if(l===null)return t;let i=l.requests,n=a.hubs;return e`<div class="upanel">
			<div class="uhead">
				<h2>${l.lane==="(bare ingress)"?"UNATTRIBUTED REQUESTS":`LANE ${l.lane} · REQUESTS`}</h2>
				<button
					class="ubtn"
					@click=${()=>{this.lane="",this.refresh()}}
				>
					← all lanes
				</button>
			</div>
			${this.reasonsTable(l.reasons,l.lane,i.filter((o)=>o.cache_reported===!0||(o.cache_r??0)>0).length)}
			<table class="uacts">
				<thead>
					<tr>
						<th>ts</th>
						<th>model</th>
						<th class="unum">status</th>
						<th class="unum">cache r</th>
						<th class="unum">cache w</th>
						<th class="unum">ms</th>
						<th>hub</th>
					</tr>
				</thead>
				<tbody>
					${i.length===0?e`<tr>
								<td colspan="7" class="uempty">no requests in scope</td>
							</tr>`:i.map((o)=>{let c=n.find((u)=>u.label===o.hub)?.label??o.hub??"";return e`<tr class=${o.ok===!1?"ubad":""}>
					<td class="unum"><time datetime=${o.ts} title=${o.ts}>${T(o.ts,!0)}</time></td>
									<td>${o.target_model??"—"}</td>
									<td class="unum">${o.status===null?"—":String(o.status)}</td>
									<td class="unum ${o.cache_r===0?"ucoldtext":""}">
										${o.cache_r===null?"—":g(o.cache_r)}
									</td>
									<td class="unum">
										${o.cache_c_reported?g(o.cache_c??0):"—"}
									</td>
									<td class="unum">
										${o.duration_ms===null?"—":g(o.duration_ms)}
									</td>
									<td><span class="uchip">${c}</span></td>
								</tr>`})}
				</tbody>
			</table>
		</div>`}}E.styles=[r`
		:host {
			display: block;
		}
		.upanel {
			display: block;
			background: var(--klh-surface, #1c1b19);
			border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
			border-radius: 3px;
			padding: 12px 14px 10px;
			margin-bottom: 14px;
		}
		.upanel h2 {
			margin: 0 0 6px;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
		}
		.uhead {
			display: flex;
			align-items: baseline;
			gap: 12px;
		}
		.uhead .ufoot {
			margin: 0;
		}
		.ufoot {
			font-size: 10.5px;
			color: var(--klh-dim, #98958e);
			margin: 2px 0 8px;
		}
		h3 {
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
			margin: 12px 0 4px;
		}
		table.uacts {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		table.uacts td,
		table.uacts th {
			padding: 6px 8px;
			border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
			text-align: left;
		}
		.unum {
			text-align: right;
			font-variant-numeric: tabular-nums;
			color: var(--klh-ink-2, #c9c6bf);
			white-space: nowrap;
		}
		.uchip {
			font-size: 10px;
			color: var(--klh-dim, #98958e);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			padding: 1px 6px;
			margin-left: 6px;
		}
		.uempty {
			color: var(--klh-dim, #98958e);
			font-size: 12px;
		}
		.uwarn {
			color: var(--klh-danger, #e5484d);
			font-size: 10.5px;
		}
		.ucoldtext {
			color: var(--klh-danger, #e5484d);
		}
		tr.ubad td {
			color: var(--klh-dim, #98958e);
		}
		.ufrow {
			display: flex;
			gap: 14px;
			align-items: center;
			flex-wrap: wrap;
			margin: 6px 0 10px;
			font-size: 11px;
		}
		.ufrow label {
			display: flex;
			gap: 6px;
			align-items: center;
			color: var(--klh-dim, #98958e);
		}
		.ufrow select {
			background: var(--klh-surface, #1c1b19);
			color: var(--klh-ink, #e8e6e1);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			font: inherit;
			font-size: 11px;
			padding: 2px 4px;
		}
		.uoverall {
			margin-left: auto;
			color: var(--klh-dim, #98958e);
			font-variant-numeric: tabular-nums;
		}
		.uoverall b {
			color: var(--klh-ink, #e8e6e1);
		}
		.ubarslot {
			display: inline-block;
			vertical-align: middle;
			width: 60px;
			margin-left: 6px;
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.05));
			border-radius: 2px;
			overflow: hidden;
		}
		.ubarslot i.ureq {
			display: block;
			height: 4px;
			background: var(--klh-accent-dim, rgba(216, 144, 15, 0.45));
		}
		.uwr {
			display: inline-block;
			vertical-align: middle;
			width: 80px;
			margin-right: 6px;
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.05));
			border-radius: 2px;
			overflow: hidden;
		}
		.uwr i {
			display: block;
			height: 8px;
		}
		.uwr i.uwarm {
			background: var(--klh-ok-ink, #3dd68c);
		}
		.uwr i.ucold {
			background: var(--klh-danger, #e5484d);
		}
		tr.ulane {
			cursor: default;
		}
		.ulaneButton {
			background: transparent;
			border: 0;
			padding: 0;
			text-align: left;
			color: inherit;
			font: inherit;
			cursor: pointer;
		}
		.ulaneButton:focus-visible {
			outline: 2px solid var(--klh-accent, #d8900f);
			outline-offset: 2px;
		}
		tr.ulane:hover td {
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.04));
		}
		.ulane-id {
			display: block;
			color: var(--klh-dim, #98958e);
			font-size: 10px;
			max-width: 34ch;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.urid {
			font-size: 10px;
			color: var(--klh-dim, #98958e);
			max-width: 16ch;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.uwhy {
			font-size: 10.5px;
			color: var(--klh-dim, #98958e);
			max-width: 46ch;
		}
		.ubtn {
			background: transparent;
			color: var(--klh-accent, #d8900f);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			font: inherit;
			font-size: 11px;
			padding: 2px 8px;
			cursor: pointer;
		}
	`];customElements.define("klh-usage-cache-drill",E);var w=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"")}catch{return null}},m=()=>w()?.panels??null,U=()=>w()?.slot??{},d=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),D=(a)=>a==null||!Number.isFinite(a)?"—":d(a),v=(a)=>`${(a*100).toFixed(1)}%`,y=r`
	.upanel {
		display: block;
		background: var(--klh-surface, #1c1b19);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 3px;
		padding: 12px 14px 10px;
		margin-bottom: 14px;
	}
	.upanel h2 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--klh-dim, #98958e);
	}
	.uhead {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}
	.uhead .ufoot {
		margin: 0;
	}
	.uempty {
		color: var(--klh-dim, #98958e);
		font-size: 12px;
	}
	.ufoot {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
		margin: 2px 0 8px;
	}
	table.uacts {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.uacts td,
	table.uacts th {
		padding: 6px 8px;
		border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
		text-align: left;
	}
	.unum {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--klh-ink-2, #c9c6bf);
		white-space: nowrap;
	}
	.uchip {
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 1px 6px;
		margin-left: 6px;
	}
	.ubar {
		display: flex;
		height: 12px;
		border-radius: 3px;
		overflow: hidden;
		min-width: 2px;
	}
	.ubar i {
		display: block;
		height: 100%;
	}
	.udot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		margin-right: 6px;
	}
`;class H extends s{static properties={header:{type:Object,state:!0}};constructor(){super();this.header=null}connectedCallback(){super.connectedCallback(),this.header=m()?.header??null}chips(a,l,i){return e`<span class="ufgroup" data-label=${a}
			>${l.map((n)=>e`<a class="${i}${n.on?" on":""}" href=${n.href}
						>${n.label}</a
					>`)}</span
		>`}body(a){return e`<div class="uback">
				<a href="/">&larr; fleet board</a><span class="uwin">${a.back}</span>
			</div>
			<h1 class="utitle">USAGE</h1>
			<div class="ufilters">
				${this.chips("window",a.windows,"ufilter")}
				${this.chips("team",a.teams,"ufchip")}
				${this.chips("dept",a.depts,"ufchip")}
				${a.filtered?e`<span class="uon">${a.filtered}</span>`:t}
				<span class="uon">${a.status}</span>
			</div>`}render(){return e`${this.header?this.body(this.header):t}`}}H.styles=r`
	:host {
		display: block;
	}
	a {
		color: var(--klh-accent, #d8900f);
	}
	.uback {
		display: flex;
		gap: 16px;
		align-items: baseline;
		margin: 12px 0 0;
	}
	.uwin {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
	}
	.utitle {
		font-size: 14px;
		letter-spacing: 0.08em;
		margin: 14px 0 10px;
		color: var(--klh-ink, #e8e6e1);
	}
	.ufilters {
		display: flex;
		gap: 18px;
		align-items: center;
		margin: 0 0 14px;
		flex-wrap: wrap;
	}
	.ufgroup {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.ufgroup::before {
		content: attr(data-label);
		font-size: 9.5px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.ufilter,
	.ufchip {
		font-size: 11px;
		color: var(--klh-dim, #98958e);
		text-decoration: none;
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 2px 9px;
	}
	.ufilter.on,
	.ufchip.on {
		color: var(--klh-accent, #d8900f);
		border-color: var(--klh-accent, #d8900f);
	}
	.uon {
		font-size: 10.5px;
		color: var(--klh-accent, #d8900f);
	}
`;class P extends s{static properties={tiles:{type:Array,state:!0}};constructor(){super();this.tiles=[]}connectedCallback(){super.connectedCallback(),this.tiles=m()?.tiles??[]}render(){if(!this.tiles.length)return e``;return e`<div class="utiles">
			${this.tiles.map((a)=>e`<div class="utile">
					<div class="uv">${a.v}</div>
					<div class="uk">${a.k}</div>
				</div>`)}
		</div>`}}P.styles=r`
	:host {
		display: block;
	}
	.utile {
		flex: 1 1 150px;
		background: var(--klh-surface, #1c1b19);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 3px;
		padding: 10px 14px;
	}
	.uv {
		font-size: 22px;
		font-weight: 600;
		color: var(--klh-ink, #e8e6e1);
		font-variant-numeric: tabular-nums;
		word-break: break-all;
	}
	.uk {
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-top: 2px;
	}
	.utiles {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		margin: 14px 0;
	}
`;var k=(a,l)=>a[l]??"#888",_=(a,l,i)=>{let n=a.tok?`${(a.tok/Math.max(1,l)*100).toFixed(2)}%`:"0";return e`<i
		style=${`width:${n};background:${k(i,a.g)}`}
		title=${`${a.g}: ${d(a.tok)} tok`}
	></i>`};class q extends s{static properties={rows:{type:Array,state:!0}};slot={};constructor(){super();this.rows=[]}connectedCallback(){super.connectedCallback(),this.rows=m()?.actors?.rows??[],this.slot=U()}render(){let a=m()?.actors;if(!a?.rows.length)return e``;return this.body(a.rows)}body(a){return e`<div class="upanel">
			<h2>ACTORS</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>actor</th>
						<th style="width:38%">tokens by model group</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${a.map((l)=>this.row(l))}
				</tbody>
			</table>
		</div>`}row(a){let l=[...a.demo?["synthetic demo"]:[],...a.chips].map((i)=>e`<span class="uchip">${i}</span>`);return e`<tr class="uact">
				<td>
					<b>${a.actor}</b>
					${l}
				</td>
				<td>
					<div class="ubar" style=${`width:${a.barW}%`}>
						${a.segs.map((i)=>_(i,a.total,this.slot))}
					</div>
				</td>
				<td class="unum">${d(a.total)}</td>
				<td class="unum">${d(a.rq)}</td>
			</tr>
			${this.detail(a.models)}`}detail(a){return e`<tr class="udetail">
			<td colspan="4">
				<details>
					<summary>per-model</summary>
					<table class="umtab">
						<thead>
							<tr>
								<th>model</th>
								<th class="unum">tokens</th>
								<th class="unum">req</th>
							</tr>
						</thead>
						<tbody>${a.map((l)=>this.mrow(l))}</tbody>
					</table>
				</details>
			</td>
		</tr>`}mrow(a){return e`<tr>
			<td>
				<i
					class="udot"
					style=${`background:${k(this.slot,a.g)}`}
				></i
				>${a.m}
			</td>
			<td class="unum">${d(a.tok)}</td>
			<td class="unum">${d(a.rq)}</td>
		</tr>`}}q.styles=[y,r`
		tr.udetail td {
			padding-top: 0;
			border-bottom: none;
		}
		tr.udetail details {
			font-size: 11px;
			color: var(--klh-dim, #98958e);
		}
		tr.udetail summary {
			cursor: pointer;
		}
		table.umtab {
			margin: 6px 0 10px;
			border-collapse: collapse;
		}
		table.umtab td,
		table.umtab th {
			padding: 2px 10px 2px 0;
			font-size: 11px;
			text-align: left;
			color: var(--klh-ink-2, #c9c6bf);
		}
		:host {
			display: block;
		}
	`];class z extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=m()?.aids??null}render(){let a=this.panel;if(!a)return e``;if(a.empty)return e`<div class="upanel">
				<h2>${a.title}</h2>
				<p class="uempty">${a.empty}</p>
			</div>`;return this.body(a)}body(a){return e`<div class="upanel">
			${a.foot?e`<div class="uhead">
							<h2>${a.title}</h2>
							<p class="ufoot">${a.foot}</p>
						</div>`:e`<h2>${a.title}</h2>`}
			<table class="uacts">
				<thead>
					<tr>
						<th>aid</th>
						<th>domain</th>
						<th class="unum">injected</th>
						<th class="unum">skipped</th>
						<th class="unum">tok injected</th>
					</tr>
				</thead>
				<tbody>${a.rows.map((l)=>this.arow(l))}</tbody>
			</table>
		</div>`}arow(a){return e`<tr>
			<td><b>${a.aid}</b></td>
			<td>${a.domain}</td>
			<td class="unum">${d(a.inj)}</td>
			<td class="unum">${d(a.skip)}</td>
			<td class="unum">${d(a.tok)}</td>
		</tr>`}}z.styles=[y,r`
		:host {
			display: block;
		}
	`];var C={context:"#3987e5",planning:"#199e70",code:"#d95926",communicating:"#c98500"};class L extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=m()?.activity??null}render(){let a=this.panel;if(!a)return e``;if("empty"in a)return e`<div class="upanel">
				<h2>WORK MIX</h2>
				<p class="uempty">${a.empty}</p>
			</div>`;return this.body(a)}body(a){let l=[...a.weekly].sort((i,n)=>n.d.localeCompare(i.d))[0];return e`<div class="upanel">
			<div class="uhead">
				<h2>WORK MIX</h2>
				<p class="ufoot">${l?`Week of ${l.d}`:"No weekly data"} · ${a.lanes.length} ${a.lanes.length===1?"lane":"lanes"}</p>
			</div>
			${l?this.mix(l):e`<p class="uempty">No classified activity yet.</p>`}
			<details class="mixdetails">
				<summary>Weekly history and lane breakdown</summary>
				<p class="ufoot">${a.foot}</p>
				${this.weekly(a.weekly)}
				${this.lanes(a.lanes)}
			</details>
		</div>`}mix(a){return e`<div class="mixoverview">
			<div class="mixbar" role="img" aria-label=${a.cells.map((l)=>`${l.key} ${v(l.share)}`).join(", ")}>
				${a.cells.map((l)=>e`<span style=${`width:${v(l.share)};background:${C[l.key]??"#888"}`}></span>`)}
			</div>
			<div class="mixlegend">
				${a.cells.map((l)=>e`<span><i style=${`background:${C[l.key]??"#888"}`}></i>${l.key} <b>${v(l.share)}</b></span>`)}
			</div>
		</div>`}weekly(a){return e`<table class="uacts">
			<thead>
				<tr>
					<th>week</th>
					<th class="unum">cost</th>
					<th>context · planning · code · communicating</th>
					<th class="unum">orient</th>
				</tr>
			</thead>
			<tbody>
				${a.map((l)=>e`<tr>
					<td>${l.d}</td>
					<td class="unum">${d(l.cost)}</td>
					<td style="width:44%">${l.cells.map((i,n)=>this.cell(i,n))}</td>
					<td class="unum">${v(l.orient)}</td>
				</tr>`)}
			</tbody>
		</table>`}cell(a,l){let i=l>0?e`<span class="usep">·</span>`:t;if(!a.share)return e`${i}<span class="uempty">—</span>`;let n=v(a.share);return e`${i}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${n};background:${C[a.key]??"#888"}`}
					title=${`${a.key}: ${n}`}
				></i></span
			><span class="unum">${n}</span></span
		>`}lanes(a){let l=a.length?a.map((i)=>this.laneRow(i)):[e`<tr>
						<td colspan="6" class="uempty">
							no classified activity yet — first harvest fills this table
						</td>
					</tr>`];return e`<table class="uacts" style="margin-top:10px">
			<thead>
				<tr>
					<th>lane</th>
					<th>context share</th>
					<th class="unum">orient</th>
					<th class="unum">searches/req</th>
					<th class="unum">cost</th>
					<th class="unum">req</th>
				</tr>
			</thead>
			<tbody>
				${l}
			</tbody>
		</table>`}laneRow(a){return e`<tr>
			<td><b>${a.actor}</b></td>
			<td>${this.cell(a.cells[0],0)}</td>
			<td class="unum">${v(a.orient)}</td>
			<td class="unum">${a.spr}</td>
			<td class="unum">${d(a.cost)}</td>
			<td class="unum">${d(a.req)}</td>
		</tr>`}}L.styles=[y,r`
		.mixbar { display:flex; height:12px; overflow:hidden; border-radius:3px; background:var(--klh-edge, #555); }
		.mixbar span { display:block; height:100%; }
		.mixlegend { display:flex; flex-wrap:wrap; gap:8px 18px; margin-top:9px; font-size:11px; color:var(--klh-dim, #98958e); }
		.mixlegend span { display:inline-flex; align-items:center; gap:5px; }
		.mixlegend i { display:inline-block; width:7px; height:7px; border-radius:1px; }
		.mixlegend b { color:var(--klh-ink, #eee); font-weight:600; }
		.mixdetails { margin-top:12px; border-top:1px solid var(--klh-edge, #555); padding-top:9px; }
		.mixdetails summary { cursor:pointer; color:var(--klh-ink-2, #ccc); font-size:12px; }
		.mixdetails[open] summary { margin-bottom:10px; }
		.ucwrap {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.usep {
			color: var(--klh-dim, #98958e);
			margin: 0 4px;
		}
		:host {
			display: block;
		}
	`];var B="no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";class O extends s{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=m()?.spokes??null,this.slot=U()}render(){let a=m()?.spokes;if(!a)return e``;if(!a.rows.length)return this.empty();return this.body(a.rows)}empty(){return e`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${B}</p>
		</div>`}body(a){return e`<div class="upanel">
			<h2>SPOKES</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>spoke</th>
						<th style="width:38%">tokens by model class</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${a.map((l)=>this.row(l))}
				</tbody>
			</table>
		</div>`}row(a){return e`<tr>
			<td>
				<b>${a.spoke}</b>
				<span class="uchip">${a.team}</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${a.barW}%`}>
					${a.segs.map((l)=>_(l,a.total,this.slot))}
				</div>
			</td>
			<td class="unum">${d(a.total)}</td>
			<td class="unum">${d(a.rq)}</td>
		</tr>`}}O.styles=[y,r`
		:host {
			display: block;
		}
	`];var j="no hub rollups — enumerate hubs in stack.yaml (hubs:) or the hubs.json registry; the board fetches each hub's /federation/usage server-side (TTL-cached, per-hub degrade)";class M extends s{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=m()?.crosshub??null,this.slot=U()}render(){let a=m()?.crosshub;if(!a)return e``;if("empty"in a)return e`<div class="upanel">
				<h2>CROSS-HUB</h2>
				<p class="uempty">${a.empty}</p>
			</div>`;if(!a.rows.length)return this.empty();return this.body(a.rows)}empty(){return e`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<p class="uempty">${j}</p>
		</div>`}row(a){if(a.degraded){let i=a.reason??"No response from this hub",n=/timed out|timeout/i.test(i)?"No response before the hub timeout":/typeerror|host is down|connection refused|unable to connect/i.test(i)?"Cannot reach this hub":/hub answered (401|403)/.test(i)?"Usage access denied":/hub answered 404/.test(i)?"Usage endpoint unavailable":/no url/i.test(i)?"No usage endpoint configured":"Could not read usage from this hub";return e`<tr>
				<td>
					<b>${a.hub}</b>
					<span class="uchip">degraded</span>
				</td>
				<td colspan="3">
					${n}
					<details><summary>Diagnostic</summary><code>${i}</code></details>
				</td>
			</tr>`}let l=Math.max(2,a.total/Math.max(1,...this.rowTotals)*100);return e`<tr>
			<td>
				<b>${a.hub}</b>
				<span class="uchip">${a.via}</span>
				<span class="uchip">${String(a.spokes)} spokes</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${String(l)}%`}>
					${a.segs.map((i)=>_(i,a.total,this.slot))}
				</div>
			</td>
			<td class="unum">${d(a.total)}</td>
			<td class="unum">${d(a.rq)}</td>
		</tr>`}get rowTotals(){return(m()?.crosshub?.rows??[]).map((a)=>a.total)}body(a){return e`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>hub</th>
						<th style="width:38%">tokens by model class</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${a.map((l)=>this.row(l))}
				</tbody>
			</table>
			<p class="ufoot">${m()?.crosshub?.foot??""}</p>
		</div>`}}M.styles=[y,r`
		:host {
			display: block;
		}
		details {
			margin-top: 4px;
			font-size: 11px;
			color: var(--klh-dim);
		}
		details code {
			overflow-wrap: anywhere;
		}
	`];class A extends s{static properties={bucket:{type:Number,state:!0},hours:{type:Array,state:!0},report:{type:Object,state:!0},error:{type:String,state:!0},loading:{type:Boolean,state:!0}};dayKey(a){let l=new Date(a),i=(n)=>String(n).padStart(2,"0");return`${String(l.getFullYear())}-${i(l.getMonth()+1)}-${i(l.getDate())}`}dayLabel(a){let[l,i,n]=a.split("-");return`${n}.${i}.${l?.slice(-2)}`}hourLabel(a){return`${String(new Date(a).getHours()).padStart(2,"0")}:00`}requestId=0;constructor(){super();this.bucket=0,this.hours=[],this.report=null,this.error="",this.loading=!1}connectedCallback(){super.connectedCallback();let a=w()?.timeline??[],l=a[0]??[];this.hours=l.map((n,o)=>({bucket:n*1000,tokens:a.slice(1).reduce((c,u)=>c+(u[o]??0),0)})).filter((n)=>n.tokens>0).map((n)=>n.bucket).reverse();let i=Number(new URLSearchParams(location.search).get("hour"));if(this.bucket=this.hours.includes(i)?i:this.hours[0]??0,this.bucket)this.refresh()}refresh(){let a=++this.requestId,l=new URLSearchParams(location.search);l.set("bucket",String(this.bucket)),l.delete("hour"),this.loading=!0,this.error="",fetch(`/api/usage/hour?${l.toString()}`,{signal:AbortSignal.timeout(15000)}).then((i)=>{if(!i.ok)throw Error(`HTTP ${String(i.status)}`);return i.json()}).then((i)=>{if(a!==this.requestId)return;this.report=i.report,this.loading=!1}).catch((i)=>{if(a!==this.requestId)return;this.error=String(i.message??i),this.loading=!1})}selectHour(a){this.bucket=a;let l=new URL(location.href);l.searchParams.set("hour",String(a)),history.replaceState(null,"",l),this.refresh()}render(){if(!this.hours.length)return e``;let a=[...new Set(this.hours.map((o)=>this.dayKey(o)))],l=this.dayKey(this.bucket),i=this.hours.filter((o)=>this.dayKey(o)===l),n=this.report?.actors.flatMap((o)=>o.byModel.map((c)=>({actor:o.actor,...c})))??[];return e`<div class="upanel" id="usage-hour">
			<div class="uhead">
				<h2>HOUR DETAIL</h2>
				<p class="ufoot">Select a day and hour to inspect its actors and models.</p>
			</div>
			<label class="hour-picker">day
				<select
					@change=${(o)=>{let c=o.target.value,u=this.hours.find((h)=>this.dayKey(h)===c);if(u!==void 0)this.selectHour(u)}}
				>
					${a.map((o)=>e`<option value=${o} ?selected=${o===l}>${this.dayLabel(o)}</option>`)}
				</select>
			</label>
			<label class="hour-picker">hour
				<select
					@change=${(o)=>this.selectHour(Number(o.target.value))}
					title=${new Date(this.bucket).toISOString()}
				>
					${i.map((o)=>e`<option value=${String(o)} ?selected=${o===this.bucket} title=${new Date(o).toISOString()}>${this.hourLabel(o)}</option>`)}
				</select>
			</label>
			${this.loading?e`<p class="uempty">Loading hour…</p>`:t}
			${this.error?e`<p class="uempty" role="alert">Hour detail unavailable: ${this.error}</p>`:t}
			${!this.loading&&!this.error&&n.length===0?e`<p class="uempty">No attributed usage in this hour.</p>`:t}
			${!this.loading&&!this.error&&n.length>0?e`<div class="hour-scroll"><table class="uacts">
				<thead><tr><th>actor</th><th>model</th><th>group</th><th>input</th><th>cache read</th><th>cache write</th><th>output</th><th>requests</th></tr></thead>
				<tbody>${n.map((o)=>e`<tr><td>${o.actor}</td><td>${o.model}</td><td>${o.group}</td><td>${d(o.i)}</td><td>${d(o.cr)}</td><td>${d(o.cc)}</td><td>${d(o.o)}</td><td>${String(o.rq)}</td></tr>`)}</tbody>
			</table></div>`:t}
		</div>`}}A.styles=[y,r`
	.hour-picker { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: var(--klh-dim); font-size: 11px; }
	.hour-picker select { background: var(--klh-surface); color: var(--klh-ink); border: 1px solid var(--klh-edge); padding: 5px; }
	.hour-scroll { overflow-x: auto; }
`];class N extends s{static properties={tl:{type:String},hours:{type:String}};slot={};groups=[];timeline=[];byHour=[];charts=[];ros=[];resizes=[];onTheme=null;constructor(){super();this.tl="TOKENS · STACKED BY MODEL GROUP",this.hours="WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)"}connectedCallback(){super.connectedCallback(),this.tl=this.getAttribute("tl")??this.tl,this.hours=this.getAttribute("hours")??this.hours;let a=w();if(this.slot=a?.slot??{},this.groups=a?.groups??[],this.timeline=a?.timeline??[],this.byHour=a?.byHour??[],this.onTheme===null)this.onTheme=()=>{for(let l of this.charts)l.redraw(!1,!0)},document.addEventListener("klh-themechange",this.onTheme)}disconnectedCallback(){super.disconnectedCallback();for(let a of this.ros)a.disconnect();this.ros=[];for(let a of this.resizes)window.removeEventListener("resize",a);if(this.resizes=[],this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme),this.onTheme=null}createRenderRoot(){return this}render(){if(!this.timeline.length&&!this.byHour.length)return e``;return e`<div class="upanel">
				<div class="uhead">
					<h2>${this.tl}</h2>
					<p class="ufoot">hover = values · drag = zoom · double-click = reset</p>
				</div>
				<div class="ulegend">
					${this.groups.map((a)=>e`<span><i style=${`background:${k(this.slot,a)}`}></i
								>${a}</span>`)}
				</div>
				<div id="u-timeline" class="uchart"></div>
			</div>
			<div class="upanel">
				<h2>${this.hours}</h2>
				<div id="u-hours" class="uchart"></div>
			</div>`}firstUpdated(){let a=globalThis.uPlot;if(!a)return;let l=(b,p)=>getComputedStyle(document.documentElement).getPropertyValue(b).trim()||p,i=()=>l("--klh-chart-grid","#2c2c2a"),n=()=>l("--klh-chart-hair","#383835"),o=()=>l("--klh-chart-axis","#898781"),c=(b,p)=>p.map((f)=>d(f)),u=(b,p)=>{let f={side:b,...b===3?{size:72}:{},stroke:o,grid:{show:!0,stroke:i,width:1},ticks:{show:!0,stroke:n,width:1}};if(p)f.values=p;return f},h=this.querySelector("#u-timeline");if(h&&this.groups.length){let b=[{}];for(let p of this.groups){let f=k(this.slot,p);b.push({label:p,stacked:!0,stroke:f,fill:f,width:1,points:{show:!1},value:(W,I)=>D(I)})}this.chart(h,a,{width:h.clientWidth,height:300,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:b,axes:[u(2),u(3,c)]},this.timeline,300)}let R=this.querySelector("#u-hours");if(R)this.chart(R,a,{width:R.clientWidth,height:190,legend:{show:!1},scales:{x:{time:!1}},series:[{},{label:"tokens",stroke:k(this.slot,"flash"),fill:k(this.slot,"flash"),paths:a.paths?.bars({size:[0.72,100]}),points:{show:!1},value:(b,p)=>D(p)}],axes:[u(2,(b,p)=>p.map((f)=>String(Math.round(f)).padStart(2,"0"))),u(3,c)]},this.byHour,190)}chart(a,l,i,n,o){let c=new l(i,n,a);this.charts.push(c);let u=()=>{let h=a.clientWidth;if(h>0&&h!==c.width)c.setSize({width:h,height:o})};if(typeof ResizeObserver==="function"){let h=new ResizeObserver(u);h.observe(a),this.ros.push(h)}else this.resizes.push(u),window.addEventListener("resize",u)}}N.styles=r`
	:host {
		display: block;
	}
`;customElements.define("klh-usage-header",H);customElements.define("klh-usage-tiles",P);customElements.define("klh-usage-actors",q);customElements.define("klh-usage-aids",z);customElements.define("klh-usage-activity",L);customElements.define("klh-usage-spokes",O);customElements.define("klh-usage-crosshub",M);customElements.define("klh-usage-drilldown",A);customElements.define("klh-usage-charts",N);export{L as KlhUsageActivity,q as KlhUsageActors,z as KlhUsageAids,N as KlhUsageCharts,M as KlhUsageCrossHub,A as KlhUsageDrilldown,H as KlhUsageHeader,O as KlhUsageSpokes,P as KlhUsageTiles,d as fmtTok,v as pct1};
