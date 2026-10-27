import{r,e,t,s}from"./lit-17452e2304aadd9e.js";var T=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"")}catch{return null}},u=()=>T()?.panels??null,C=()=>T()?.slot??{},c=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),K=(a)=>a==null||!Number.isFinite(a)?"—":c(a),w=(a)=>`${(a*100).toFixed(1)}%`,v=r`
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
`,y=(a,o)=>a[o]??"#888",E=(a,o,i)=>{let l=a.tok?`${(a.tok/Math.max(1,o)*100).toFixed(2)}%`:"0";return e`<i
		style=${`width:${l};background:${y(i,a.g)}`}
		title=${`${a.g}: ${c(a.tok)} tok`}
	></i>`};class M extends s{static properties={header:{type:Object,state:!0}};constructor(){super();this.header=null}connectedCallback(){super.connectedCallback(),this.header=u()?.header??null}chips(a,o,i){return e`<span class="ufgroup" data-label=${a}
			>${o.map((l)=>e`<a class="${i}${l.on?" on":""}" href=${l.href}
						>${l.label}</a
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
			</div>`}render(){return e`${this.header?this.body(this.header):t}`}}M.styles=r`
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
`;class P extends s{static properties={tiles:{type:Array,state:!0}};constructor(){super();this.tiles=[]}connectedCallback(){super.connectedCallback(),this.tiles=u()?.tiles??[]}render(){if(!this.tiles.length)return e``;return e`<div class="utiles">
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
`;class _ extends s{static properties={rows:{type:Array,state:!0},query:{type:String,state:!0}};slot={};constructor(){super();this.rows=[],this.query=""}connectedCallback(){super.connectedCallback(),this.rows=u()?.actors?.rows??[],this.slot=C()}render(){let a=u()?.actors;if(!a?.rows.length)return e`<div class="upanel"><h2>ACTORS</h2><p class="uempty">No actor usage in this window.</p></div>`;return this.body(a.rows)}body(a){let o=this.query.trim().toLocaleLowerCase(),i=o?a.filter((l)=>[l.actor,...l.chips,...l.models.map((n)=>n.m)].some((n)=>n.toLocaleLowerCase().includes(o))):a;return e`<div class="upanel">
			<div class="actor-head">
				<h2>ACTORS · ${String(i.length)} OF ${String(a.length)}</h2>
				<label>Search actor or model
					<input type="search" .value=${this.query}
						@input=${(l)=>{this.query=l.target.value}}
						placeholder="Name, team, or model" />
				</label>
			</div>
			${!i.length?e`<p class="uempty" role="status">No actors match this search.</p>`:t}
			<div class="table-scroll"><table class="uacts">
				<thead>
					<tr>
						<th>actor</th>
						<th style="width:38%">tokens by model group</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${i.map((l)=>this.row(l))}
				</tbody>
			</table></div>
		</div>`}row(a){let o=[...a.demo?["synthetic demo"]:[],...a.chips].map((i)=>e`<span class="uchip">${i}</span>`);return e`<tr class="uact">
				<td>
					<b>${a.actor}</b>
					${o}
				</td>
				<td>
					<div class="ubar" style=${`width:${a.barW}%`}>
						${a.segs.map((i)=>E(i,a.total,this.slot))}
					</div>
				</td>
				<td class="unum">${c(a.total)}</td>
				<td class="unum">${c(a.rq)}</td>
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
						<tbody>${a.map((o)=>this.mrow(o))}</tbody>
					</table>
				</details>
			</td>
		</tr>`}mrow(a){return e`<tr>
			<td>
				<i
					class="udot"
					style=${`background:${y(this.slot,a.g)}`}
				></i
				>${a.m}
			</td>
			<td class="unum">${c(a.tok)}</td>
			<td class="unum">${c(a.rq)}</td>
		</tr>`}}_.styles=[v,r`
		.actor-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
		.actor-head h2 { margin:0; }
		.actor-head label { display:flex; align-items:center; gap:8px; color:var(--klh-dim); font-size:11px; }
		.actor-head input { min-width:210px; padding:6px 8px; border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-bg); color:var(--klh-ink); font:inherit; }
		.actor-head input:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		.table-scroll { overflow-x:auto; }
		.table-scroll > table { min-width:560px; }
		@media (max-width:620px) { .actor-head label, .actor-head input { width:100%; } }
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
	`];class q extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.aids??null}render(){let a=this.panel;if(!a)return e``;if(a.empty)return e`<div class="upanel">
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
				<tbody>${a.rows.map((o)=>this.arow(o))}</tbody>
			</table>
		</div>`}arow(a){return e`<tr>
			<td><b>${a.aid}</b></td>
			<td>${a.domain}</td>
			<td class="unum">${c(a.inj)}</td>
			<td class="unum">${c(a.skip)}</td>
			<td class="unum">${c(a.tok)}</td>
		</tr>`}}q.styles=[v,r`
		:host {
			display: block;
		}
	`];var F={context:"#3987e5",planning:"#199e70",code:"#d95926",communicating:"#c98500"};class L extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.activity??null}render(){let a=this.panel;if(!a)return e``;if("empty"in a)return e`<div class="upanel">
				<h2>WORK MIX</h2>
				<p class="uempty">${a.empty}</p>
			</div>`;return this.body(a)}body(a){let o=[...a.weekly].sort((i,l)=>l.d.localeCompare(i.d))[0];return e`<div class="upanel">
			<div class="uhead">
				<h2>WORK MIX</h2>
				<p class="ufoot">${o?`Week of ${o.d}`:"No weekly data"} · ${a.lanes.length} ${a.lanes.length===1?"lane":"lanes"}</p>
			</div>
			${o?this.mix(o):e`<p class="uempty">No classified activity yet.</p>`}
			<details class="mixdetails">
				<summary>Weekly history and lane breakdown</summary>
				<p class="ufoot">${a.foot}</p>
				${this.weekly(a.weekly)}
				${this.lanes(a.lanes)}
			</details>
		</div>`}mix(a){return e`<div class="mixoverview">
			<div class="mixbar" role="img" aria-label=${a.cells.map((o)=>`${o.key} ${w(o.share)}`).join(", ")}>
				${a.cells.map((o)=>e`<span style=${`width:${w(o.share)};background:${F[o.key]??"#888"}`}></span>`)}
			</div>
			<div class="mixlegend">
				${a.cells.map((o)=>e`<span><i style=${`background:${F[o.key]??"#888"}`}></i>${o.key} <b>${w(o.share)}</b></span>`)}
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
				${a.map((o)=>e`<tr>
					<td>${o.d}</td>
					<td class="unum">${c(o.cost)}</td>
					<td style="width:44%">${o.cells.map((i,l)=>this.cell(i,l))}</td>
					<td class="unum">${w(o.orient)}</td>
				</tr>`)}
			</tbody>
		</table>`}cell(a,o){let i=o>0?e`<span class="usep">·</span>`:t;if(!a.share)return e`${i}<span class="uempty">—</span>`;let l=w(a.share);return e`${i}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${l};background:${F[a.key]??"#888"}`}
					title=${`${a.key}: ${l}`}
				></i></span
			><span class="unum">${l}</span></span
		>`}lanes(a){let o=a.length?a.map((i)=>this.laneRow(i)):[e`<tr>
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
				${o}
			</tbody>
		</table>`}laneRow(a){return e`<tr>
			<td><b>${a.actor}</b></td>
			<td>${this.cell(a.cells[0],0)}</td>
			<td class="unum">${w(a.orient)}</td>
			<td class="unum">${a.spr}</td>
			<td class="unum">${c(a.cost)}</td>
			<td class="unum">${c(a.req)}</td>
		</tr>`}}L.styles=[v,r`
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
	`];var X="no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";class H extends s{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.spokes??null,this.slot=C()}render(){let a=u()?.spokes;if(!a)return e``;if(!a.rows.length)return this.empty();return this.body(a.rows)}empty(){return e`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${X}</p>
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
					${a.map((o)=>this.row(o))}
				</tbody>
			</table>
		</div>`}row(a){return e`<tr>
			<td>
				<b>${a.spoke}</b>
				<span class="uchip">${a.team}</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${a.barW}%`}>
					${a.segs.map((o)=>E(o,a.total,this.slot))}
				</div>
			</td>
			<td class="unum">${c(a.total)}</td>
			<td class="unum">${c(a.rq)}</td>
		</tr>`}}H.styles=[v,r`
		:host {
			display: block;
		}
	`];var Z="no hub rollups — enumerate hubs in stack.json (hubs:) or the hubs.json registry; the board fetches each hub's /federation/usage server-side (TTL-cached, per-hub degrade)";class z extends s{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.crosshub??null,this.slot=C()}render(){let a=u()?.crosshub;if(!a)return e``;if("empty"in a)return e`<div class="upanel">
				<h2>CROSS-HUB</h2>
				<p class="uempty">${a.empty}</p>
			</div>`;if(!a.rows.length)return this.empty();return this.body(a.rows)}empty(){return e`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<p class="uempty">${Z}</p>
		</div>`}row(a){if(a.degraded){let i=a.reason??"No response from this hub",l=/timed out|timeout/i.test(i)?"No response before the hub timeout":/typeerror|host is down|connection refused|unable to connect/i.test(i)?"Cannot reach this hub":/hub answered (401|403)/.test(i)?"Usage access denied":/hub answered 404/.test(i)?"Usage endpoint unavailable":/no url/i.test(i)?"No usage endpoint configured":"Could not read usage from this hub";return e`<tr>
				<td>
					<b>${a.hub}</b>
					<span class="uchip">degraded</span>
				</td>
				<td colspan="3">
					${l}
					<details><summary>Diagnostic</summary><code>${i}</code></details>
				</td>
			</tr>`}let o=Math.max(2,a.total/Math.max(1,...this.rowTotals)*100);return e`<tr>
			<td>
				<b>${a.hub}</b>
				<span class="uchip">${a.via}</span>
				<span class="uchip">${String(a.spokes)} spokes</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${String(o)}%`}>
					${a.segs.map((i)=>E(i,a.total,this.slot))}
				</div>
			</td>
			<td class="unum">${c(a.total)}</td>
			<td class="unum">${c(a.rq)}</td>
		</tr>`}get rowTotals(){return(u()?.crosshub?.rows??[]).map((a)=>a.total)}body(a){return e`<div class="upanel">
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
					${a.map((o)=>this.row(o))}
				</tbody>
			</table>
			<p class="ufoot">${u()?.crosshub?.foot??""}</p>
		</div>`}}z.styles=[v,r`
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
	`];class O extends s{static properties={bucket:{type:Number,state:!0},hours:{type:Array,state:!0},report:{type:Object,state:!0},error:{type:String,state:!0},loading:{type:Boolean,state:!0}};dayKey(a){let o=new Date(a),i=(l)=>String(l).padStart(2,"0");return`${String(o.getFullYear())}-${i(o.getMonth()+1)}-${i(o.getDate())}`}dayLabel(a){let[o,i,l]=a.split("-");return`${l}.${i}.${o?.slice(-2)}`}hourLabel(a){return`${String(new Date(a).getHours()).padStart(2,"0")}:00`}requestId=0;constructor(){super();this.bucket=0,this.hours=[],this.report=null,this.error="",this.loading=!1}connectedCallback(){super.connectedCallback();let a=T()?.timeline??[],o=a[0]??[];this.hours=o.map((l,n)=>({bucket:l*1000,tokens:a.slice(1).reduce((d,h)=>d+(h[n]??0),0)})).filter((l)=>l.tokens>0).map((l)=>l.bucket).reverse();let i=Number(new URLSearchParams(location.search).get("hour"));if(this.bucket=this.hours.includes(i)?i:this.hours[0]??0,this.bucket)this.refresh()}refresh(){let a=++this.requestId,o=new URLSearchParams(location.search);o.set("bucket",String(this.bucket)),o.delete("hour"),this.loading=!0,this.error="",fetch(`/api/usage/hour?${o.toString()}`,{signal:AbortSignal.timeout(15000)}).then((i)=>{if(!i.ok)throw Error(`HTTP ${String(i.status)}`);return i.json()}).then((i)=>{if(a!==this.requestId)return;this.report=i.report,this.loading=!1}).catch((i)=>{if(a!==this.requestId)return;this.error=String(i.message??i),this.loading=!1})}selectHour(a){this.bucket=a;let o=new URL(location.href);o.searchParams.set("hour",String(a)),history.replaceState(null,"",o),this.refresh()}render(){if(!this.hours.length)return e``;let a=[...new Set(this.hours.map((n)=>this.dayKey(n)))],o=this.dayKey(this.bucket),i=this.hours.filter((n)=>this.dayKey(n)===o),l=this.report?.actors.flatMap((n)=>n.byModel.map((d)=>({actor:n.actor,...d})))??[];return e`<div class="upanel" id="usage-hour">
			<div class="uhead">
				<h2>HOUR DETAIL</h2>
				<p class="ufoot">Select a day and hour to inspect its actors and models.</p>
			</div>
			<label class="hour-picker">day
				<select
					@change=${(n)=>{let d=n.target.value,h=this.hours.find((p)=>this.dayKey(p)===d);if(h!==void 0)this.selectHour(h)}}
				>
					${a.map((n)=>e`<option value=${n} ?selected=${n===o}>${this.dayLabel(n)}</option>`)}
				</select>
			</label>
			<label class="hour-picker">hour
				<select
					@change=${(n)=>this.selectHour(Number(n.target.value))}
					title=${new Date(this.bucket).toISOString()}
				>
					${i.map((n)=>e`<option value=${String(n)} ?selected=${n===this.bucket} title=${new Date(n).toISOString()}>${this.hourLabel(n)}</option>`)}
				</select>
			</label>
			${this.loading?e`<p class="uempty">Loading hour…</p>`:t}
			${this.error?e`<p class="uempty" role="alert">Hour detail unavailable: ${this.error}</p>`:t}
			${!this.loading&&!this.error&&l.length===0?e`<p class="uempty">No attributed usage in this hour.</p>`:t}
			${!this.loading&&!this.error&&l.length>0?e`<div class="hour-scroll"><table class="uacts">
				<thead><tr><th>actor</th><th>model</th><th>group</th><th>input</th><th>cache read</th><th>cache write</th><th>output</th><th>requests</th></tr></thead>
				<tbody>${l.map((n)=>e`<tr><td>${n.actor}</td><td>${n.model}</td><td>${n.group}</td><td>${c(n.i)}</td><td>${c(n.cr)}</td><td>${c(n.cc)}</td><td>${c(n.o)}</td><td>${String(n.rq)}</td></tr>`)}</tbody>
			</table></div>`:t}
		</div>`}}O.styles=[v,r`
	.hour-picker { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: var(--klh-dim); font-size: 11px; }
	.hour-picker select { background: var(--klh-surface); color: var(--klh-ink); border: 1px solid var(--klh-edge); padding: 5px; }
	.hour-scroll { overflow-x: auto; }
`];class A extends s{static properties={tl:{type:String},hours:{type:String}};slot={};groups=[];timeline=[];byHour=[];charts=[];ros=[];resizes=[];onTheme=null;constructor(){super();this.tl="TOKENS · STACKED BY MODEL GROUP",this.hours="WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)"}connectedCallback(){super.connectedCallback(),this.tl=this.getAttribute("tl")??this.tl,this.hours=this.getAttribute("hours")??this.hours;let a=T();if(this.slot=a?.slot??{},this.groups=a?.groups??[],this.timeline=a?.timeline??[],this.byHour=a?.byHour??[],this.onTheme===null)this.onTheme=()=>{for(let o of this.charts)o.redraw(!1,!0)},document.addEventListener("klh-themechange",this.onTheme)}disconnectedCallback(){super.disconnectedCallback();for(let a of this.ros)a.disconnect();this.ros=[];for(let a of this.resizes)window.removeEventListener("resize",a);if(this.resizes=[],this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme),this.onTheme=null}createRenderRoot(){return this}render(){if(!this.timeline.length&&!this.byHour.length)return e``;return e`<div class="usage-chart-grid"><div class="upanel">
				<div class="uhead">
					<h2>${this.tl}</h2>
					<p class="ufoot">hover = values · drag = zoom · double-click = reset</p>
				</div>
				<div class="ulegend">
					${this.groups.map((a)=>e`<span><i style=${`background:${y(this.slot,a)}`}></i
								>${a}</span>`)}
				</div>
				<div id="u-timeline" class="uchart"></div>
			</div>
			<div class="upanel">
				<h2>${this.hours}</h2>
				<div id="u-hours" class="uchart"></div>
			</div></div>`}firstUpdated(){let a=globalThis.uPlot;if(!a)return;let o=(b,m)=>getComputedStyle(document.documentElement).getPropertyValue(b).trim()||m,i=()=>o("--klh-chart-grid","#2c2c2a"),l=()=>o("--klh-chart-hair","#383835"),n=()=>o("--klh-chart-axis","#898781"),d=(b,m)=>m.map((f)=>c(f)),h=(b,m)=>{let f={side:b,...b===3?{size:72}:{},stroke:n,grid:{show:!0,stroke:i,width:1},ticks:{show:!0,stroke:l,width:1}};if(m)f.values=m;return f},p=this.querySelector("#u-timeline");if(p&&this.groups.length){let b=[{}];for(let m of this.groups){let f=y(this.slot,m);b.push({label:m,stacked:!0,stroke:f,fill:f,width:1,points:{show:!1},value:(g,R)=>K(R)})}this.chart(p,a,{width:p.clientWidth,height:300,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:b,axes:[h(2),h(3,d)]},this.timeline,300)}let x=this.querySelector("#u-hours");if(x)this.chart(x,a,{width:x.clientWidth,height:190,legend:{show:!1},scales:{x:{time:!1}},series:[{},{label:"tokens",stroke:y(this.slot,"flash"),fill:y(this.slot,"flash"),paths:a.paths?.bars({size:[0.72,100]}),points:{show:!1},value:(b,m)=>K(m)}],axes:[h(2,(b,m)=>m.map((f)=>String(Math.round(f)).padStart(2,"0"))),h(3,d)]},this.byHour,190)}chart(a,o,i,l,n){let d=new o(i,l,a);this.charts.push(d);let h=()=>{let p=a.clientWidth;if(p>0&&p!==d.width)d.setSize({width:p,height:n})};if(typeof ResizeObserver==="function"){let p=new ResizeObserver(h);p.observe(a),this.ros.push(p)}else this.resizes.push(h),window.addEventListener("resize",h)}}A.styles=r`
	:host {
		display: block;
	}
`;var ee=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"").head??null}catch{return null}};class I extends s{static properties={head:{type:Object,state:!0}};constructor(){super();this.head=null}connectedCallback(){super.connectedCallback(),this.head=ee()}render(){let a=this.head;if(a===null)return t;return e`<h1 class="utitle">${a.title}</h1>
			<div class="uback">
				<a href=${a.backHref}>&larr; ${a.backLabel}</a>
				<span class=${a.note.kind==="on"?"uon":"uwin"}
					>${a.note.text}</span
				>
			</div>
			<div class="ufilters">
				${a.filters.map((o)=>e`<span class="ufgroup" data-label=${o.label}>
						${o.options.map((i)=>e`<a class=${i.on?"ufilter on":"ufilter"} href=${i.href}
									>${i.label}</a
								>`)}
					</span>`)}
			</div>`}}I.styles=r`
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
`;customElements.define("klh-usage-head",I);var k=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),S=(a)=>`${(a*100).toFixed(1)}%`,j=(a,o=!1)=>{if(a===null)return"—";let i=new Date(a);if(Number.isNaN(i.getTime()))return"—";let l=(d)=>String(d).padStart(2,"0"),n=`${l(i.getHours())}:${l(i.getMinutes())}`;return o?`${n}:${l(i.getSeconds())}`:n};class B extends s{static properties={report:{type:Object,state:!0},err:{type:String,state:!0},loading:{type:Boolean,state:!0},lane:{type:String,state:!0},days:{type:Number,state:!0},model:{type:String,state:!0},day:{type:String,state:!0},missOnly:{type:Boolean,state:!0},sla:{type:Object,state:!0}};constructor(){super();this.report=null,this.err="",this.loading=!0,this.lane="",this.days=7,this.model="",this.day="",this.missOnly=!1,this.sla=null}connectedCallback(){super.connectedCallback(),this.refresh()}refresh(){let a=new URLSearchParams;if(a.set("days",String(this.days)),this.lane)a.set("lane",this.lane);if(this.model)a.set("model",this.model);if(this.day)a.set("day",this.day);if(this.missOnly)a.set("miss_only","1");this.loading=!0,this.err="",fetch(`/api/usage/cache-drill?${a.toString()}`,{signal:AbortSignal.timeout(15000)}).then((o)=>{if(!o.ok)throw Error(`HTTP ${String(o.status)}`);return o.json()}).then((o)=>{this.report=o,this.loading=!1}).catch((o)=>{this.err=String(o.message??o),this.loading=!1}),this.fetchSla()}fetchSla(){fetch("/api/usage/cache-sla?window_min=60",{signal:AbortSignal.timeout(15000)}).then((a)=>a.ok?a.json():null).then((a)=>{this.sla=a}).catch(()=>{this.sla=null})}slaLine(){let a=this.sla;if(a===null||a.lanes.length===0)return t;let o=a.lanes.map((l)=>e`<span class=${l.breaching?"uwarn":""}>${l.lane}
					${S(l.hitShare)}</span>`),i=a.breaches.length>0?`${String(a.breaches.length)} breach(es)`:"ok";return e`<p class="ufoot">
			cache-SLA (${String(a.windowMinutes)}m rolling, threshold
			${S(a.threshold)}, ≥${String(a.minRequests)} req):
			${o.map((l,n)=>n===0?l:e`, ${l}`)} — ${i}
		</p>`}render(){if(this.err)return e`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">drilldown unavailable — ${this.err}</p>
			</div>`;let a=this.report;if(a===null)return e`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">loading…</p>
			</div>`;return e`${this.lanePanel(a)} ${this.scopePanel(a)}`}lanePanel(a){let o=a.hubs.filter((l)=>!l.ok),i=a.hubs.filter((l)=>(l.excluded??0)>0);return e`<div class="upanel">
			<div class="uhead">
				<h2>CACHE EFFICIENCY · WARM RATIO PER LANE</h2>
				<p class="ufoot">
					warm = share of requests that HIT provider cache (cache_read &gt; 0)
					· ${String(a.days)}d window
					${o.length>0?e`· <span class="uwarn"
								>${String(o.length)}/${String(a.hubs.length)} sources
								degraded: ${o.map((l)=>l.label).join(", ")}</span
							>`:t}
				</p>
			</div>
			${this.slaLine()}
			${this.filterRow(a)}
			${a.overall.requests>a.overall.known?e`<p class="uwarn">Cache verdicts are available for
					${String(a.overall.known)} of ${String(a.overall.requests)}
					requests. Warm rates exclude the rest.</p>`:t}
			${a.probes.requests>0?e`<p class="ufoot">Readiness probes: ${String(a.probes.requests)}
					requests in this window (last ${j(a.probes.last_ts)}), warm
					${a.probes.known>0?S(a.probes.warm_ratio):"—"} — synthetic
					healthcheck traffic, excluded from the lane and model ratios
					above.</p>`:t}
			${a.local_transcripts&&a.local_transcripts.cache_read_tokens>0?e`<p class="ufoot">Local Claude transcripts report
					${k(a.local_transcripts.cache_read_tokens)} cache-read tokens
					across ${k(a.local_transcripts.requests)} requests in this
					window. This total has no Buckle lane attribution${a.local_transcripts.source==="legacy-aggregate"?" and uses the legacy rollup":""}.</p>`:t}
			${o.length>0?e`<p class="uwarn">Missing request data: ${o.map((l)=>`${l.label} (${l.reason??"unavailable"})`).join(", ")}. Rates cover responding sources only.</p>`:t}
			${a.hubs.some((l)=>l.ok&&(l.rawRows??l.rows)>=500)?e`<p class="uwarn">A source reached the 500-request read limit. Rates cover its newest requests only.</p>`:t}
			${i.length>0?e`<p class="uwarn">Excluded non-model audit rows from ${i.map((l)=>l.label).join(", ")}. Those hubs may still use the older request filter, so their 500-row cap can hide model traffic until updated.</p>`:t}
			${this.reasonsTable(a.overall.reasons,"ALL LANES",a.overall.known)}
			${this.modelTable(a.models)}
			${this.laneTable(a.lanes,o.length>0)}
		</div>`}modelTable(a){if(a.length===0)return t;return e`<h3>CACHE BY MODEL</h3>
			<p class="ufoot">partial = some requests have no cache verdict;
				unsupported = declared in machine config; not reported = no provider
				cache field was observed</p>
			<table class="uacts">
				<thead><tr><th>model</th><th class="unum">req</th><th class="unum">verdicts</th><th>warm</th><th class="unum">cache read</th><th>status</th></tr></thead>
				<tbody>${a.map((o)=>e`<tr>
						<td>${o.model}</td><td class="unum">${k(o.requests)}</td>
						<td class="unum">${k(o.known)}</td>
						<td>${o.known>0?S(o.warm_ratio):"—"}</td>
						<td class="unum">${k(o.cache_r_tok)}</td><td>${o.status}</td>
					</tr>`)}</tbody>
			</table>`}filterRow(a){let o=[...new Set(a.lanes.flatMap((l)=>l.models))].sort(),i=[...new Set(a.lanes.flatMap((l)=>l.day_series.map((n)=>n.d)))].sort().reverse();return e`<div class="ufrow">
			<label>
				<span>days</span>
				<select
					@change=${(l)=>{this.days=Number(l.target.value),this.lane="",this.refresh()}}
				>
					${[7,14,28,90].map((l)=>e`<option value=${String(l)} ?selected=${l===this.days}
								>${String(l)}</option
							>`)}
				</select>
			</label>
			<label>
				<span>model</span>
				<select
					@change=${(l)=>{this.model=l.target.value,this.refresh()}}
				>
					${["",...o].map((l)=>e`<option value=${l} ?selected=${l===this.model}
								>${l===""?"any":l}</option
							>`)}
				</select>
			</label>
			<label>
				<span>day</span>
				<select
					@change=${(l)=>{this.day=l.target.value,this.refresh()}}
				>
					${["",...i].map((l)=>e`<option value=${l} ?selected=${l===this.day}
								>${l===""?"all":l}</option
							>`)}
				</select>
			</label>
			<label class="ucheck">
				<input
					type="checkbox"
					?checked=${this.missOnly}
					@change=${(l)=>{this.missOnly=l.target.checked,this.refresh()}}
				/>
				<span>misses only</span>
			</label>
			<span class="uoverall">
				${String(a.overall.requests)} req ·
				${String(a.overall.known)} known · warm
						<b>${a.overall.known>0?S(a.overall.warm_ratio):"—"}</b>
				${this.loading?e`<span class="uempty">· refreshing…</span>`:t}
			</span>
		</div>`}reasonsTable(a,o,i){return e`<h3>MISS REASONS · ${o}</h3>
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
								${a.map((l)=>e`<tr>
										<td><b>${l.label}</b></td>
										<td class="unum">${String(l.count)}</td>
										<td class="urid" title=${l.example_rid}>
											${l.example_rid}
										</td>
										<td class="uwhy">${l.detail}</td>
									</tr>`)}
							</tbody>
						</table>`}`}laneTable(a,o){if(a.length===0)return e`<p class="uempty">
				${o?"lane data unavailable from the failed sources":"no requests recorded for this scope"}
			</p>`;let i=Math.max(1,...a.map((l)=>l.requests));return e`<table class="uacts">
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
				${a.map((l)=>{let n=l.known>0?l.warm/l.known*100:0;return e`<tr class="ulane">
						<td title=${l.lane}>
							<button class="ulaneButton" type="button" @click=${()=>{this.lane=l.lane,this.refresh()}}>
								<b>${l.models[0]??l.lane}</b>
								${l.models.length>0?e`<span class="ulane-id">${l.lane}</span>`:t}
							</button>
							${l.hubs.map((d)=>e`<span class="uchip">${d}</span>`)}
							${l.models.length>1?e`<span class="uwarn">${String(l.models.length)} models</span>`:t}
						</td>
						<td class="unum">
							${k(l.requests)}
							<span class="ubarslot"
								><i
									class="ureq"
									style=${`width:${String(Math.max(4,l.requests/i*100))}%`}
								></i
							></span>
						</td>
						<td>
							<span class="uwr"
								><i
									class=${n>=50?"uwarm":"ucold"}
									style=${`width:${String(Math.max(2,n))}%`}
									title=${`${S(n/100)} of ${String(l.known)} known`}
								></i
							></span>
							<span class="unum">${l.known>0?S(n/100):"—"}</span>
						</td>
						<td class="unum">${k(l.cache_r_tok)}</td>
						<td class="unum" title=${l.cache_c_known?`${String(l.cache_c_known)} requests reported cache writes`:"Provider did not report cache writes"}>${l.cache_c_known?k(l.cache_c_tok):"—"}</td>
						<td class="unum"><time title=${l.last_ts??"Unknown time"} datetime=${l.last_ts??""}>${j(l.last_ts)}</time></td>
					</tr>`})}
			</tbody>
		</table>`}scopePanel(a){let o=a.lane_scope;if(o===null)return t;let i=o.requests,l=a.hubs;return e`<div class="upanel">
			<div class="uhead">
				<h2>${o.lane==="(bare ingress)"?"UNATTRIBUTED REQUESTS":`LANE ${o.lane} · REQUESTS`}</h2>
				<button
					class="ubtn"
					@click=${()=>{this.lane="",this.refresh()}}
				>
					← all lanes
				</button>
			</div>
			${this.reasonsTable(o.reasons,o.lane,i.filter((n)=>n.cache_reported===!0||(n.cache_r??0)>0).length)}
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
							</tr>`:i.map((n)=>{let d=l.find((h)=>h.label===n.hub)?.label??n.hub??"";return e`<tr class=${n.ok===!1?"ubad":""}>
					<td class="unum"><time datetime=${n.ts} title=${n.ts}>${j(n.ts,!0)}</time></td>
									<td>${n.target_model??"—"}</td>
									<td class="unum">${n.status===null?"—":String(n.status)}</td>
									<td class="unum ${n.cache_r===0?"ucoldtext":""}">
										${n.cache_r===null?"—":k(n.cache_r)}
									</td>
									<td class="unum">
										${n.cache_c_reported?k(n.cache_c??0):"—"}
									</td>
									<td class="unum">
										${n.duration_ms===null?"—":k(n.duration_ms)}
									</td>
									<td><span class="uchip">${d}</span></td>
								</tr>`})}
				</tbody>
			</table>
		</div>`}}B.styles=[r`
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
	`];customElements.define("klh-usage-cache-drill",B);var te=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),se=(a)=>`${(a*100).toFixed(1)}%`,ae=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"").panels?.coverage??null}catch{return null}};class W extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=ae()}render(){let a=this.panel;if(!a)return e``;if(a.hoursData===0)return e`<div class="upanel">
				<h2>EVIDENCE · COVERAGE & FRESHNESS</h2>
				<p class="uempty">
					no usage data in this window (${a.from} → ${a.to}) — the charts
					above show honest zeros
				</p>
			</div>`;return this.body(a)}body(a){return e`<div class="upanel">
			<div class="uhead">
				<h2>EVIDENCE · COVERAGE & FRESHNESS</h2>
				<p class="ufoot">${a.source}${a.demoNote?` · ${a.demoNote}`:""}</p>
			</div>
			<p class="ufoot">
				window ${a.from} → ${a.to} ·
				<b
					>${String(a.hoursData)} of ${String(a.hoursTotal)}</b
				> hours with data (<b
					>${se(a.hoursData/Math.max(1,a.hoursTotal))}</b
				>)
				${a.newest?e`· newest data ${a.newest} (${String(a.newestAgeH)}h before
					window end)`:t}
			</p>
			${a.longestGapH>0?e`<p class="ufoot">
						longest zero-run <b>${String(a.longestGapH)}h</b> ending
						${a.gapEnd}
					</p>`:t}
			<details class="covdetails">
				<summary>Coverage by day — jump into an hour</summary>
				<table class="uacts">
					<thead>
						<tr>
							<th>day</th>
							<th class="unum">live hours</th>
							<th class="unum">tokens</th>
							<th>drilldown</th>
						</tr>
					</thead>
					<tbody>
						${a.byDay.map((o)=>e`<tr>
									<td><b>${o.d}</b></td>
									<td class="unum">${String(o.hoursData)}</td>
									<td class="unum">${te(o.tok)}</td>
									<td>
										${o.href?e`<a href=${o.href}>hour detail →</a>`:"—"}
									</td>
								</tr>`)}
					</tbody>
				</table>
			</details>
		</div>`}}W.styles=r`
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
	.ufoot b {
		color: var(--klh-ink, #e8e6e1);
		font-variant-numeric: tabular-nums;
	}
	.uempty {
		color: var(--klh-dim, #98958e);
		font-size: 12px;
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
	.covdetails {
		margin-top: 8px;
		border-top: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		padding-top: 8px;
		font-size: 11px;
	}
	.covdetails summary {
		cursor: pointer;
		color: var(--klh-ink-2, #c9c6bf);
	}
	.covdetails a {
		color: var(--klh-accent, #d8900f);
	}
`;customElements.define("klh-usage-coverage",W);var Y=[{key:"lane",label:"lane"},{key:"model",label:"model"},{key:"provider",label:"provider"},{key:"hub",label:"hub"}],V=[{key:"requests",label:"requests/h",title:"inference requests per hour"},{key:"throughput",label:"throughput",title:"provider-reported output tokens per hour"},{key:"failures",label:"failures",title:"requests answered not-ok or status >= 400 per hour"},{key:"cache",label:"cache hits",title:"requests with a warm cache read per hour"},{key:"latency",label:"latency",title:"average provider duration (ms) per hour"}],N=["#3987e5","#d95926","#199e70","#c98500","#d55181","#7e6bd1","#3f9f9f","#a08a4f"],G=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),D=(a)=>a===null?"—":`${(a*100).toFixed(0)}%`,J=(a)=>a===null?"—":`${String(a)}ms`,re=`
.kmon-chips { display:flex; gap:4px; flex-wrap:wrap; margin:8px 0 12px; }
.kmon-chips button { font:inherit; font-size:11px; color:var(--klh-dim); background:none; border:1px solid var(--klh-edge); border-radius:2px; padding:3px 10px; cursor:pointer; }
.kmon-chips button.on, .kmon-chips button:hover { color:var(--klh-accent); border-color:var(--klh-accent); }
.kmon-scroll { overflow-x:auto; }
.kmon table { border-collapse:collapse; width:100%; font-size:11px; }
.kmon th, .kmon td { text-align:left; padding:4px 10px 4px 0; border-bottom:1px solid var(--klh-edge-soft); white-space:nowrap; font-variant-numeric:tabular-nums; }
.kmon th { color:var(--klh-dim); font-weight:600; text-transform:uppercase; letter-spacing:.06em; font-size:10px; }
.kmon td.k { color:var(--klh-ink); font-family:var(--klh-font-mono); }
.kmon .dim2 { color:var(--klh-dim); }
`;class Q extends s{static properties={dim:{type:String,state:!0},metric:{type:String,state:!0},report:{type:Object,state:!0},err:{type:String,state:!0},loading:{type:Boolean,state:!0}};days=7;chart=null;ro=null;onTheme=null;gen=0;constructor(){super();this.dim="lane",this.metric="requests",this.report=null,this.err="",this.loading=!0}connectedCallback(){super.connectedCallback(),this.days=Math.min(90,Math.max(1,Number(new URLSearchParams(location.search).get("days")??7)||7));let a=location.hash.replace(/^#monitor\/?/,"").split("/"),o=Y.find((l)=>l.key===a[0]);if(o!==void 0)this.dim=o.key;let i=V.find((l)=>l.key===a[1]);if(i!==void 0)this.metric=i.key;this.onTheme=()=>this.mountChart(!0),document.addEventListener("klh-themechange",this.onTheme),this.load()}disconnectedCallback(){if(super.disconnectedCallback(),this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme);this.onTheme=null,this.ro?.disconnect(),this.ro=null,this.chart?.destroy(),this.chart=null}async load(){let a=++this.gen;this.loading=!0,this.err="";try{let o=await fetch(`/api/usage/monitor?days=${String(this.days)}&dim=${this.dim}`),i=await o.json();if(a!==this.gen)return;if(!o.ok||i.ok!==!0)throw Error(i.error??`status ${String(o.status)}`);this.report=i,this.loading=!1,await this.updateComplete,this.mountChart(!1)}catch(o){if(a!==this.gen)return;this.err=String(o),this.loading=!1}}setDim(a){this.dim=a,history.replaceState(null,"",`#monitor/${a}/${this.metric}`),this.load()}setMetric(a){this.metric=a,history.replaceState(null,"",`#monitor/${this.dim}/${a}`),this.mountChart(!1)}createRenderRoot(){return this}mountChart(a){let o=globalThis.uPlot,i=this.querySelector("#kmon-chart"),l=this.report?.series;if(!o||!i||!l)return;let n=this.metric,d=l[n];if(d===void 0)return;if(a&&this.chart!==null)this.chart.destroy(),this.chart=null;if(this.chart!==null){let g=i.clientWidth;if(g>0&&g!==this.chart.width)this.chart.setSize({width:g,height:240});return}let h=l.labels.length,p=[{}];for(let g=0;g<h;g++){let R=N[g%N.length];p.push({label:l.labels[g],stroke:R,fill:n==="requests"||n==="throughput"?R:void 0,width:1.4,points:{show:h<=2},value:(le,U)=>U===null||!Number.isFinite(U)?"—":n==="throughput"?G(U):n==="latency"?`${String(Math.round(U))}ms`:String(Math.round(U))})}let x=(g,R)=>getComputedStyle(document.documentElement).getPropertyValue(g).trim()||R,b=()=>x("--klh-chart-axis","#898781"),m=()=>x("--klh-chart-grid","#2c2c2a"),f=()=>x("--klh-chart-hair","#383835");if(this.chart=new o({width:i.clientWidth,height:240,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:p,axes:[{side:2,stroke:b,grid:{show:!0,stroke:m,width:1},ticks:{show:!0,stroke:f,width:1}},{side:3,size:72,stroke:b,grid:{show:!1},ticks:{show:!0,stroke:f,width:1}}]},d,i),typeof ResizeObserver==="function")this.ro?.disconnect(),this.ro=new ResizeObserver(()=>{let g=i.clientWidth;if(this.chart!==null&&g>0&&g!==this.chart.width)this.chart.setSize({width:g,height:240})}),this.ro.observe(i)}render(){let a=this.report,o=a?.coverage,i=(a?.hubs??[]).filter((l)=>!l.ok);return e`<style>
				${re}
			</style><div class="upanel kmon">
			<div class="uhead">
				<h2>MONITOR · DRILLDOWN BY ${this.dim.toUpperCase()}</h2>
				<p class="ufoot">${String(this.days)}d shared window · buckle request ledger · hover = values · drag = zoom · double-click = reset</p>
			</div>
			<div class="kmon-chips" role="group" aria-label="Monitor dimension">
				${Y.map((l)=>e`<button
						class=${l.key===this.dim?"on":""}
						@click=${()=>this.setDim(l.key)}
					>${l.label}</button>`)}
			</div>
			<div class="kmon-chips" role="group" aria-label="Monitor metric">
				${V.map((l)=>e`<button
						class=${l.key===this.metric?"on":""}
						title=${l.title}
						@click=${()=>this.setMetric(l.key)}
					>${l.label}</button>`)}
			</div>
			<div class="ulegend">
				${(a?.series?.labels??[]).map((l,n)=>e`<span><i style=${`background:${N[n%N.length]}`}></i
							>${l}</span>`)}
			</div>
			<div id="kmon-chart" class="uchart"></div>
			${this.loading?e`<p class="uempty">Loading monitor…</p>`:t}
			${this.err!==""?e`<p class="uempty" role="alert">Monitor unavailable: ${this.err}</p>`:t}
			${o!==void 0?e`<p class="ufoot">
						${String(o.requests)} inference requests
						(${String(o.probe_requests)} probes excluded) · tokens reported
						${String(o.rows_with_tokens)} · duration ${String(o.rows_with_duration)} · cache
						verdicts ${String(o.rows_with_cache_verdict)} · failure verdicts
						${String(o.rows_with_failure_verdict)} · hub ceiling
						${String(o.per_hub_row_limit)} rows/hub${a?.transcripts?` · transcript meter ${a.transcripts.source} (${String(a.transcripts.requests)} req, ${G(a.transcripts.cache_read_tokens)} cache-read tok)`:""}
					</p>`:t}
			${i.length>0?e`<p class="uempty">hubs degraded: ${i.map((l)=>`${l.label} (${l.reason??"unreachable"})`).join(" · ")}</p>`:t}
		</div>
		<div class="upanel kmon">
			<h2>GROUPS · ${this.dim.toUpperCase()}</h2>
			${a===null||a.rows.length===0?e`<p class="uempty">${this.loading?"":"No request-ledger rows in this window."}</p>`:e`<div class="kmon-scroll"><table>
						<thead><tr>
							<th>${this.dim}</th><th>req</th><th>out tok</th><th>fail</th>
							<th>cache warm</th><th>p50</th><th>p95</th>
							${this.dim==="lane"?e`<th title="W243 meter: orientation share · context share · searches/request">work type</th>`:t}
						</tr></thead>
						<tbody>${a.rows.map((l)=>e`<tr>
								<td class="k">${l.key}</td>
								<td>${String(l.requests)}</td>
								<td>${l.tok_reported>0?G(l.out_tok):"—"}</td>
								<td>${l.failure_observed>0?D(l.failures/l.failure_observed):"—"}</td>
								<td>${l.known>0?D(l.warm_ratio):"—"}</td>
								<td>${J(l.lat_p50_ms)}</td>
								<td>${J(l.lat_p95_ms)}</td>
								${this.dim==="lane"?e`<td class="dim2">${l.work===null?"—":`orient ${D(l.work.orient)} · ctx ${D(l.work.context)} · ${l.work.spr.toFixed(2)} srq`}</td>`:t}
							</tr>`)}</tbody>
					</table></div>`}
		</div>`}}customElements.define("klh-usage-monitor",Q);customElements.define("klh-usage-header",M);customElements.define("klh-usage-tiles",P);customElements.define("klh-usage-actors",_);customElements.define("klh-usage-aids",q);customElements.define("klh-usage-activity",L);customElements.define("klh-usage-spokes",H);customElements.define("klh-usage-crosshub",z);customElements.define("klh-usage-drilldown",O);customElements.define("klh-usage-charts",A);
