import{n,e,t,r}from"./lit-801c06b16c5fa88d.js";var T=()=>{let s=document.getElementById("usage-data");if(!s)return null;try{return JSON.parse(s.textContent??"")}catch{return null}},u=()=>T()?.panels??null,C=()=>T()?.slot??{},c=(s)=>s>=1e9?`${(s/1e9).toFixed(1)}B`:s>=1e6?`${(s/1e6).toFixed(1)}M`:s>=1000?`${(s/1000).toFixed(1)}K`:String(Math.round(s)),K=(s)=>s==null||!Number.isFinite(s)?"—":c(s),w=(s)=>`${(s*100).toFixed(1)}%`,v=n`
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
`,y=(s,l)=>s[l]??"#888",E=(s,l,i)=>{let a=s.tok?`${(s.tok/Math.max(1,l)*100).toFixed(2)}%`:"0";return e`<i
		style=${`width:${a};background:${y(i,s.g)}`}
		title=${`${s.g}: ${c(s.tok)} tok`}
	></i>`};class M extends r{static properties={header:{type:Object,state:!0}};constructor(){super();this.header=null}connectedCallback(){super.connectedCallback(),this.header=u()?.header??null}chips(s,l,i){return e`<span class="ufgroup" data-label=${s}
			>${l.map((a)=>e`<a class="${i}${a.on?" on":""}" href=${a.href}
						>${a.label}</a
					>`)}</span
		>`}body(s){return e`<div class="uback">
				<a href="/">&larr; fleet board</a><span class="uwin">${s.back}</span>
			</div>
			<h1 class="utitle">USAGE</h1>
			<div class="ufilters">
				${this.chips("window",s.windows,"ufilter")}
				${this.chips("team",s.teams,"ufchip")}
				${this.chips("dept",s.depts,"ufchip")}
				${s.filtered?e`<span class="uon">${s.filtered}</span>`:t}
				<span class="uon">${s.status}</span>
			</div>`}render(){return e`${this.header?this.body(this.header):t}`}}M.styles=n`
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
`;class P extends r{static properties={tiles:{type:Array,state:!0}};constructor(){super();this.tiles=[]}connectedCallback(){super.connectedCallback(),this.tiles=u()?.tiles??[]}render(){if(!this.tiles.length)return e``;return e`<div class="utiles">
			${this.tiles.map((s)=>e`<div class="utile">
					<div class="uv">${s.v}</div>
					<div class="uk">${s.k}</div>
				</div>`)}
		</div>`}}P.styles=n`
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
`;class _ extends r{static properties={rows:{type:Array,state:!0},query:{type:String,state:!0}};slot={};constructor(){super();this.rows=[],this.query=""}connectedCallback(){super.connectedCallback(),this.rows=u()?.actors?.rows??[],this.slot=C()}render(){let s=u()?.actors;if(!s?.rows.length)return e`<div class="upanel"><h2>ACTORS</h2><p class="uempty">No actor usage in this window.</p></div>`;return this.body(s.rows)}body(s){let l=this.query.trim().toLocaleLowerCase(),i=l?s.filter((a)=>[a.actor,...a.chips,...a.models.map((o)=>o.m)].some((o)=>o.toLocaleLowerCase().includes(l))):s;return e`<div class="upanel">
			<div class="actor-head">
				<h2>ACTORS · ${String(i.length)} OF ${String(s.length)}</h2>
				<label>Search actor or model
					<input type="search" .value=${this.query}
						@input=${(a)=>{this.query=a.target.value}}
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
					${i.map((a)=>this.row(a))}
				</tbody>
			</table></div>
		</div>`}row(s){let l=[...s.demo?["synthetic demo"]:[],...s.chips].map((i)=>e`<span class="uchip">${i}</span>`);return e`<tr class="uact">
				<td>
					<b>${s.actor}</b>
					${l}
				</td>
				<td>
					<div class="ubar" style=${`width:${s.barW}%`}>
						${s.segs.map((i)=>E(i,s.total,this.slot))}
					</div>
				</td>
				<td class="unum">${c(s.total)}</td>
				<td class="unum">${c(s.rq)}</td>
			</tr>
			${this.detail(s.models)}`}detail(s){return e`<tr class="udetail">
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
						<tbody>${s.map((l)=>this.mrow(l))}</tbody>
					</table>
				</details>
			</td>
		</tr>`}mrow(s){return e`<tr>
			<td>
				<i
					class="udot"
					style=${`background:${y(this.slot,s.g)}`}
				></i
				>${s.m}
			</td>
			<td class="unum">${c(s.tok)}</td>
			<td class="unum">${c(s.rq)}</td>
		</tr>`}}_.styles=[v,n`
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
	`];class L extends r{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.aids??null}render(){let s=this.panel;if(!s)return e``;if(s.empty)return e`<div class="upanel">
				<h2>${s.title}</h2>
				<p class="uempty">${s.empty}</p>
			</div>`;return this.body(s)}body(s){return e`<div class="upanel">
			${s.foot?e`<div class="uhead">
							<h2>${s.title}</h2>
							<p class="ufoot">${s.foot}</p>
						</div>`:e`<h2>${s.title}</h2>`}
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
				<tbody>${s.rows.map((l)=>this.arow(l))}</tbody>
			</table>
		</div>`}arow(s){return e`<tr>
			<td><b>${s.aid}</b></td>
			<td>${s.domain}</td>
			<td class="unum">${c(s.inj)}</td>
			<td class="unum">${c(s.skip)}</td>
			<td class="unum">${c(s.tok)}</td>
		</tr>`}}L.styles=[v,n`
		:host {
			display: block;
		}
	`];var F={context:"#3987e5",planning:"#199e70",code:"#d95926",communicating:"#c98500"};class q extends r{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.activity??null}render(){let s=this.panel;if(!s)return e``;if("empty"in s)return e`<div class="upanel">
				<h2>WORK MIX</h2>
				<p class="uempty">${s.empty}</p>
			</div>`;return this.body(s)}body(s){let l=[...s.weekly].sort((i,a)=>a.d.localeCompare(i.d))[0];return e`<div class="upanel">
			<div class="uhead">
				<h2>WORK MIX</h2>
				<p class="ufoot">${l?`Week of ${l.d}`:"No weekly data"} · ${s.lanes.length} ${s.lanes.length===1?"lane":"lanes"}</p>
			</div>
			${l?this.mix(l):e`<p class="uempty">No classified activity yet.</p>`}
			<details class="mixdetails">
				<summary>Weekly history and lane breakdown</summary>
				<p class="ufoot">${s.foot}</p>
				${this.weekly(s.weekly)}
				${this.lanes(s.lanes)}
			</details>
		</div>`}mix(s){return e`<div class="mixoverview">
			<div class="mixbar" role="img" aria-label=${s.cells.map((l)=>`${l.key} ${w(l.share)}`).join(", ")}>
				${s.cells.map((l)=>e`<span style=${`width:${w(l.share)};background:${F[l.key]??"#888"}`}></span>`)}
			</div>
			<div class="mixlegend">
				${s.cells.map((l)=>e`<span><i style=${`background:${F[l.key]??"#888"}`}></i>${l.key} <b>${w(l.share)}</b></span>`)}
			</div>
		</div>`}weekly(s){return e`<table class="uacts">
			<thead>
				<tr>
					<th>week</th>
					<th class="unum">cost</th>
					<th>context · planning · code · communicating</th>
					<th class="unum">orient</th>
				</tr>
			</thead>
			<tbody>
				${s.map((l)=>e`<tr>
					<td>${l.d}</td>
					<td class="unum">${c(l.cost)}</td>
					<td style="width:44%">${l.cells.map((i,a)=>this.cell(i,a))}</td>
					<td class="unum">${w(l.orient)}</td>
				</tr>`)}
			</tbody>
		</table>`}cell(s,l){let i=l>0?e`<span class="usep">·</span>`:t;if(!s.share)return e`${i}<span class="uempty">—</span>`;let a=w(s.share);return e`${i}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${a};background:${F[s.key]??"#888"}`}
					title=${`${s.key}: ${a}`}
				></i></span
			><span class="unum">${a}</span></span
		>`}lanes(s){let l=s.length?s.map((i)=>this.laneRow(i)):[e`<tr>
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
		</table>`}laneRow(s){return e`<tr>
			<td><b>${s.actor}</b></td>
			<td>${this.cell(s.cells[0],0)}</td>
			<td class="unum">${w(s.orient)}</td>
			<td class="unum">${s.spr}</td>
			<td class="unum">${c(s.cost)}</td>
			<td class="unum">${c(s.req)}</td>
		</tr>`}}q.styles=[v,n`
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
	`];var Z="no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";class H extends r{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.spokes??null,this.slot=C()}render(){let s=u()?.spokes;if(!s)return e``;if(!s.rows.length)return this.empty();return this.body(s.rows)}empty(){return e`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${Z}</p>
		</div>`}body(s){return e`<div class="upanel">
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
					${s.map((l)=>this.row(l))}
				</tbody>
			</table>
		</div>`}row(s){return e`<tr>
			<td>
				<b>${s.spoke}</b>
				<span class="uchip">${s.team}</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${s.barW}%`}>
					${s.segs.map((l)=>E(l,s.total,this.slot))}
				</div>
			</td>
			<td class="unum">${c(s.total)}</td>
			<td class="unum">${c(s.rq)}</td>
		</tr>`}}H.styles=[v,n`
		:host {
			display: block;
		}
	`];var ee="no hub rollups — enumerate hubs in stack.json (hubs:) or the hubs.json registry; the board fetches each hub's /federation/usage server-side (TTL-cached, per-hub degrade)";class z extends r{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.crosshub??null,this.slot=C()}render(){let s=u()?.crosshub;if(!s)return e``;if("empty"in s)return e`<div class="upanel">
				<h2>CROSS-HUB</h2>
				<p class="uempty">${s.empty}</p>
			</div>`;if(!s.rows.length)return this.empty();return this.body(s.rows)}empty(){return e`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<p class="uempty">${ee}</p>
		</div>`}row(s){if(s.degraded){let i=s.reason??"No response from this hub",a=/timed out|timeout/i.test(i)?"No response before the hub timeout":/typeerror|host is down|connection refused|unable to connect/i.test(i)?"Cannot reach this hub":/hub answered (401|403)/.test(i)?"Usage access denied":/hub answered 404/.test(i)?"Usage endpoint unavailable":/no url/i.test(i)?"No usage endpoint configured":"Could not read usage from this hub";return e`<tr>
				<td>
					<b>${s.hub}</b>
					<span class="uchip">degraded</span>
				</td>
				<td colspan="3">
					${a}
					<details><summary>Diagnostic</summary><code>${i}</code></details>
				</td>
			</tr>`}let l=Math.max(2,s.total/Math.max(1,...this.rowTotals)*100);return e`<tr>
			<td>
				<b>${s.hub}</b>
				<span class="uchip">${s.via}</span>
				<span class="uchip">${String(s.spokes)} spokes</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${String(l)}%`}>
					${s.segs.map((i)=>E(i,s.total,this.slot))}
				</div>
			</td>
			<td class="unum">${c(s.total)}</td>
			<td class="unum">${c(s.rq)}</td>
		</tr>`}get rowTotals(){return(u()?.crosshub?.rows??[]).map((s)=>s.total)}body(s){return e`<div class="upanel">
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
					${s.map((l)=>this.row(l))}
				</tbody>
			</table>
			<p class="ufoot">${u()?.crosshub?.foot??""}</p>
		</div>`}}z.styles=[v,n`
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
	`];class O extends r{static properties={bucket:{type:Number,state:!0},hours:{type:Array,state:!0},report:{type:Object,state:!0},error:{type:String,state:!0},loading:{type:Boolean,state:!0}};dayKey(s){let l=new Date(s),i=(a)=>String(a).padStart(2,"0");return`${String(l.getFullYear())}-${i(l.getMonth()+1)}-${i(l.getDate())}`}dayLabel(s){let[l,i,a]=s.split("-");return`${a}.${i}.${l?.slice(-2)}`}hourLabel(s){return`${String(new Date(s).getHours()).padStart(2,"0")}:00`}requestId=0;constructor(){super();this.bucket=0,this.hours=[],this.report=null,this.error="",this.loading=!1}connectedCallback(){super.connectedCallback();let s=T()?.timeline??[],l=s[0]??[];this.hours=l.map((a,o)=>({bucket:a*1000,tokens:s.slice(1).reduce((d,h)=>d+(h[o]??0),0)})).filter((a)=>a.tokens>0).map((a)=>a.bucket).reverse();let i=Number(new URLSearchParams(location.search).get("hour"));if(this.bucket=this.hours.includes(i)?i:this.hours[0]??0,this.bucket)this.refresh()}refresh(){let s=++this.requestId,l=new URLSearchParams(location.search);l.set("bucket",String(this.bucket)),l.delete("hour"),this.loading=!0,this.error="",fetch(`/api/usage/hour?${l.toString()}`,{signal:AbortSignal.timeout(15000)}).then((i)=>{if(!i.ok)throw Error(`HTTP ${String(i.status)}`);return i.json()}).then((i)=>{if(s!==this.requestId)return;this.report=i.report,this.loading=!1}).catch((i)=>{if(s!==this.requestId)return;this.error=String(i.message??i),this.loading=!1})}selectHour(s){this.bucket=s;let l=new URL(location.href);l.searchParams.set("hour",String(s)),history.replaceState(null,"",l),this.refresh()}render(){if(!this.hours.length)return e``;let s=[...new Set(this.hours.map((o)=>this.dayKey(o)))],l=this.dayKey(this.bucket),i=this.hours.filter((o)=>this.dayKey(o)===l),a=this.report?.actors.flatMap((o)=>o.byModel.map((d)=>({actor:o.actor,...d})))??[];return e`<div class="upanel" id="usage-hour">
			<div class="uhead">
				<h2>HOUR DETAIL</h2>
				<p class="ufoot">Select a day and hour to inspect its actors and models.</p>
			</div>
			<label class="hour-picker">day
				<select
					@change=${(o)=>{let d=o.target.value,h=this.hours.find((p)=>this.dayKey(p)===d);if(h!==void 0)this.selectHour(h)}}
				>
					${s.map((o)=>e`<option value=${o} ?selected=${o===l}>${this.dayLabel(o)}</option>`)}
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
			${!this.loading&&!this.error&&a.length===0?e`<p class="uempty">No attributed usage in this hour.</p>`:t}
			${!this.loading&&!this.error&&a.length>0?e`<div class="hour-scroll"><table class="uacts">
				<thead><tr><th>actor</th><th>model</th><th>group</th><th>input</th><th>cache read</th><th>cache write</th><th>output</th><th>requests</th></tr></thead>
				<tbody>${a.map((o)=>e`<tr><td>${o.actor}</td><td>${o.model}</td><td>${o.group}</td><td>${c(o.i)}</td><td>${c(o.cr)}</td><td>${c(o.cc)}</td><td>${c(o.o)}</td><td>${String(o.rq)}</td></tr>`)}</tbody>
			</table></div>`:t}
		</div>`}}O.styles=[v,n`
	.hour-picker { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: var(--klh-dim); font-size: 11px; }
	.hour-picker select { background: var(--klh-surface); color: var(--klh-ink); border: 1px solid var(--klh-edge); padding: 5px; }
	.hour-scroll { overflow-x: auto; }
`];class A extends r{static properties={tl:{type:String},hours:{type:String}};slot={};groups=[];timeline=[];byHour=[];charts=[];ros=[];resizes=[];onTheme=null;constructor(){super();this.tl="TOKENS · STACKED BY MODEL GROUP",this.hours="WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)"}connectedCallback(){super.connectedCallback(),this.tl=this.getAttribute("tl")??this.tl,this.hours=this.getAttribute("hours")??this.hours;let s=T();if(this.slot=s?.slot??{},this.groups=s?.groups??[],this.timeline=s?.timeline??[],this.byHour=s?.byHour??[],this.onTheme===null)this.onTheme=()=>{for(let l of this.charts)l.redraw(!1,!0)},document.addEventListener("klh-themechange",this.onTheme)}disconnectedCallback(){super.disconnectedCallback();for(let s of this.ros)s.disconnect();this.ros=[];for(let s of this.resizes)window.removeEventListener("resize",s);if(this.resizes=[],this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme),this.onTheme=null}createRenderRoot(){return this}render(){if(!this.timeline.length&&!this.byHour.length)return e``;return e`<div class="usage-chart-grid"><div class="upanel">
				<div class="uhead">
					<h2>${this.tl}</h2>
					<p class="ufoot">hover = values · drag = zoom · double-click = reset</p>
				</div>
				<div class="ulegend">
					${this.groups.map((s)=>e`<span><i style=${`background:${y(this.slot,s)}`}></i
								>${s}</span>`)}
				</div>
				<div id="u-timeline" class="uchart"></div>
			</div>
			<div class="upanel">
				<h2>${this.hours}</h2>
				<div id="u-hours" class="uchart"></div>
			</div></div>`}firstUpdated(){let s=globalThis.uPlot;if(!s)return;let l=(b,m)=>getComputedStyle(document.documentElement).getPropertyValue(b).trim()||m,i=()=>l("--klh-chart-grid","#2c2c2a"),a=()=>l("--klh-chart-hair","#383835"),o=()=>l("--klh-chart-axis","#898781"),d=(b,m)=>m.map((f)=>c(f)),h=(b,m)=>{let f={side:b,...b===3?{size:72}:{},stroke:o,grid:{show:!0,stroke:i,width:1},ticks:{show:!0,stroke:a,width:1}};if(m)f.values=m;return f},p=this.querySelector("#u-timeline");if(p&&this.groups.length){let b=[{}];for(let m of this.groups){let f=y(this.slot,m);b.push({label:m,stacked:!0,stroke:f,fill:f,width:1,points:{show:!1},value:(g,R)=>K(R)})}this.chart(p,s,{width:p.clientWidth,height:300,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:b,axes:[h(2),h(3,d)]},this.timeline,300)}let x=this.querySelector("#u-hours");if(x)this.chart(x,s,{width:x.clientWidth,height:190,legend:{show:!1},scales:{x:{time:!1}},series:[{},{label:"tokens",stroke:y(this.slot,"flash"),fill:y(this.slot,"flash"),paths:s.paths?.bars({size:[0.72,100]}),points:{show:!1},value:(b,m)=>K(m)}],axes:[h(2,(b,m)=>m.map((f)=>String(Math.round(f)).padStart(2,"0"))),h(3,d)]},this.byHour,190)}chart(s,l,i,a,o){let d=new l(i,a,s);this.charts.push(d);let h=()=>{let p=s.clientWidth;if(p>0&&p!==d.width)d.setSize({width:p,height:o})};if(typeof ResizeObserver==="function"){let p=new ResizeObserver(h);p.observe(s),this.ros.push(p)}else this.resizes.push(h),window.addEventListener("resize",h)}}A.styles=n`
	:host {
		display: block;
	}
`;var te=()=>{let s=document.getElementById("usage-data");if(!s)return null;try{return JSON.parse(s.textContent??"").head??null}catch{return null}};class I extends r{static properties={head:{type:Object,state:!0}};constructor(){super();this.head=null}connectedCallback(){super.connectedCallback(),this.head=te()}render(){let s=this.head;if(s===null)return t;return e`<h1 class="utitle">${s.title}</h1>
			<div class="uback">
				<a href=${s.backHref}>&larr; ${s.backLabel}</a>
				<span class=${s.note.kind==="on"?"uon":"uwin"}
					>${s.note.text}</span
				>
			</div>
			<div class="ufilters">
				${s.filters.map((l)=>e`<span class="ufgroup" data-label=${l.label}>
						${l.options.map((i)=>e`<a class=${i.on?"ufilter on":"ufilter"} href=${i.href}
									>${i.label}</a
								>`)}
					</span>`)}
			</div>`}}I.styles=n`
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
`;customElements.define("klh-usage-head",I);var k=(s)=>s>=1e9?`${(s/1e9).toFixed(1)}B`:s>=1e6?`${(s/1e6).toFixed(1)}M`:s>=1000?`${(s/1000).toFixed(1)}K`:String(Math.round(s)),S=(s)=>`${(s*100).toFixed(1)}%`,j=(s,l=!1)=>{if(s===null)return"—";let i=new Date(s);if(Number.isNaN(i.getTime()))return"—";let a=(d)=>String(d).padStart(2,"0"),o=`${a(i.getHours())}:${a(i.getMinutes())}`;return l?`${o}:${a(i.getSeconds())}`:o},se=(s)=>s===null||s===void 0||s.length<16?"—":s.slice(0,16).replace("T"," "),Y=(s)=>s.filter((l)=>l.ok&&l.truncated===!0);class B extends r{static properties={report:{type:Object,state:!0},err:{type:String,state:!0},loading:{type:Boolean,state:!0},lane:{type:String,state:!0},days:{type:Number,state:!0},model:{type:String,state:!0},day:{type:String,state:!0},missOnly:{type:Boolean,state:!0},sla:{type:Object,state:!0}};constructor(){super();this.report=null,this.err="",this.loading=!0,this.lane="",this.days=7,this.model="",this.day="",this.missOnly=!1,this.sla=null}connectedCallback(){super.connectedCallback(),this.refresh()}refresh(){let s=new URLSearchParams;if(s.set("days",String(this.days)),this.lane)s.set("lane",this.lane);if(this.model)s.set("model",this.model);if(this.day)s.set("day",this.day);if(this.missOnly)s.set("miss_only","1");this.loading=!0,this.err="",fetch(`/api/usage/cache-drill?${s.toString()}`,{signal:AbortSignal.timeout(15000)}).then((l)=>{if(!l.ok)throw Error(`HTTP ${String(l.status)}`);return l.json()}).then((l)=>{this.report=l,this.loading=!1}).catch((l)=>{this.err=String(l.message??l),this.loading=!1}),this.fetchSla()}fetchSla(){fetch("/api/usage/cache-sla?window_min=60",{signal:AbortSignal.timeout(15000)}).then((s)=>s.ok?s.json():null).then((s)=>{this.sla=s}).catch(()=>{this.sla=null})}slaLine(){let s=this.sla;if(s===null||s.lanes.length===0)return t;let l=s.lanes.map((a)=>e`<span class=${a.breaching?"uwarn":""}>${a.lane}
					${S(a.hitShare)}</span>`),i=s.breaches.length>0?`${String(s.breaches.length)} breach(es)`:"ok";return e`<p class="ufoot">
			cache-SLA (${String(s.windowMinutes)}m rolling, threshold
			${S(s.threshold)}, ≥${String(s.minRequests)} req):
			${l.map((a,o)=>o===0?a:e`, ${a}`)} — ${i}
		</p>`}render(){if(this.err)return e`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">drilldown unavailable — ${this.err}</p>
			</div>`;let s=this.report;if(s===null)return e`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">loading…</p>
			</div>`;return e`${this.lanePanel(s)} ${this.scopePanel(s)}`}lanePanel(s){let l=s.hubs.filter((a)=>!a.ok),i=s.hubs.filter((a)=>(a.excluded??0)>0);return e`<div class="upanel">
			<div class="uhead">
				<h2>CACHE EFFICIENCY · WARM RATIO PER LANE</h2>
				<p class="ufoot">
					warm = share of requests that HIT provider cache (cache_read &gt; 0)
					· ${String(s.days)}d window
					${l.length>0?e`· <span class="uwarn"
								>${String(l.length)}/${String(s.hubs.length)} sources
								degraded: ${l.map((a)=>a.label).join(", ")}</span
							>`:t}
				</p>
			</div>
			${this.slaLine()}
			${this.filterRow(s)}
			${s.overall.requests>s.overall.known?e`<p class="uwarn">Cache verdicts are available for
					${String(s.overall.known)} of ${String(s.overall.requests)}
					requests. Warm rates exclude the rest.</p>`:t}
			${s.probes.requests>0?e`<p class="ufoot">Readiness probes: ${String(s.probes.requests)}
					requests in this window (last ${j(s.probes.last_ts)}), warm
					${s.probes.known>0?S(s.probes.warm_ratio):"—"} — synthetic
					healthcheck traffic, excluded from the lane and model ratios
					above.</p>`:t}
			${s.local_transcripts&&s.local_transcripts.cache_read_tokens>0?e`<p class="ufoot">Local Claude transcripts report
					${k(s.local_transcripts.cache_read_tokens)} cache-read tokens
					across ${k(s.local_transcripts.requests)} requests in this
					window. This total has no Buckle lane attribution${s.local_transcripts.source==="legacy-aggregate"?" and uses the legacy rollup":""}.</p>`:t}
			${l.length>0?e`<p class="uwarn">Missing request data: ${l.map((a)=>`${a.label} (${a.reason??"unavailable"})`).join(", ")}. Rates cover responding sources only.</p>`:t}
			${Y(s.hubs).length>0?e`<p class="uwarn">Warm ratios cover the fetched span only: ${Y(s.hubs).map((a)=>`${a.label} back to ${se(a.coverageFrom)} of the ${String(s.days)}d window`).join("; ")}.</p>`:t}
			${i.length>0?e`<p class="uwarn">Excluded non-model audit rows from ${i.map((a)=>a.label).join(", ")}. Those hubs may still use the older request filter, so their 500-row cap can hide model traffic until updated.</p>`:t}
			${this.reasonsTable(s.overall.reasons,"ALL LANES",s.overall.known)}
			${this.modelTable(s.models)}
			${this.laneTable(s.lanes,l.length>0)}
		</div>`}modelTable(s){if(s.length===0)return t;return e`<h3>CACHE BY MODEL</h3>
			<p class="ufoot">partial = some requests have no cache verdict;
				unsupported = declared in machine config; not reported = no provider
				cache field was observed</p>
			<table class="uacts">
				<thead><tr><th>model</th><th class="unum">req</th><th class="unum">verdicts</th><th>warm</th><th class="unum">cache read</th><th>status</th></tr></thead>
				<tbody>${s.map((l)=>e`<tr>
						<td>${l.model}</td><td class="unum">${k(l.requests)}</td>
						<td class="unum">${k(l.known)}</td>
						<td>${l.known>0?S(l.warm_ratio):"—"}</td>
						<td class="unum">${k(l.cache_r_tok)}</td><td>${l.status}</td>
					</tr>`)}</tbody>
			</table>`}filterRow(s){let l=[...new Set(s.lanes.flatMap((a)=>a.models))].sort(),i=[...new Set(s.lanes.flatMap((a)=>a.day_series.map((o)=>o.d)))].sort().reverse();return e`<div class="ufrow">
			<label>
				<span>days</span>
				<select
					@change=${(a)=>{this.days=Number(a.target.value),this.lane="",this.refresh()}}
				>
					${[7,14,28,90].map((a)=>e`<option value=${String(a)} ?selected=${a===this.days}
								>${String(a)}</option
							>`)}
				</select>
			</label>
			<label>
				<span>model</span>
				<select
					@change=${(a)=>{this.model=a.target.value,this.refresh()}}
				>
					${["",...l].map((a)=>e`<option value=${a} ?selected=${a===this.model}
								>${a===""?"any":a}</option
							>`)}
				</select>
			</label>
			<label>
				<span>day</span>
				<select
					@change=${(a)=>{this.day=a.target.value,this.refresh()}}
				>
					${["",...i].map((a)=>e`<option value=${a} ?selected=${a===this.day}
								>${a===""?"all":a}</option
							>`)}
				</select>
			</label>
			<label class="ucheck">
				<input
					type="checkbox"
					?checked=${this.missOnly}
					@change=${(a)=>{this.missOnly=a.target.checked,this.refresh()}}
				/>
				<span>misses only</span>
			</label>
			<span class="uoverall">
				${String(s.overall.requests)} req ·
				${String(s.overall.known)} known · warm
						<b>${s.overall.known>0?S(s.overall.warm_ratio):"—"}</b>
				${this.loading?e`<span class="uempty">· refreshing…</span>`:t}
			</span>
		</div>`}reasonsTable(s,l,i){return e`<h3>MISS REASONS · ${l}</h3>
			${s.length===0?e`<p class="uempty">${i>0?"no cache misses among the requests with reported usage":"no cache verdicts in scope"}</p>`:e`<table class="uacts">
							<thead>
								<tr>
									<th>reason</th>
									<th class="unum">misses</th>
									<th>example rid</th>
									<th>what to do</th>
								</tr>
							</thead>
							<tbody>
								${s.map((a)=>e`<tr>
										<td><b>${a.label}</b></td>
										<td class="unum">${String(a.count)}</td>
										<td class="urid" title=${a.example_rid}>
											${a.example_rid}
										</td>
										<td class="uwhy">${a.detail}</td>
									</tr>`)}
							</tbody>
						</table>`}`}laneTable(s,l){if(s.length===0)return e`<p class="uempty">
				${l?"lane data unavailable from the failed sources":"no requests recorded for this scope"}
			</p>`;let i=Math.max(1,...s.map((a)=>a.requests));return e`<table class="uacts">
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
				${s.map((a)=>{let o=a.known>0?a.warm/a.known*100:0;return e`<tr class="ulane">
						<td title=${a.lane}>
							<button class="ulaneButton" type="button" @click=${()=>{this.lane=a.lane,this.refresh()}}>
								<b>${a.models[0]??a.lane}</b>
								${a.models.length>0?e`<span class="ulane-id">${a.lane}</span>`:t}
							</button>
							${a.hubs.map((d)=>e`<span class="uchip">${d}</span>`)}
							${a.models.length>1?e`<span class="uwarn">${String(a.models.length)} models</span>`:t}
						</td>
						<td class="unum">
							${k(a.requests)}
							<span class="ubarslot"
								><i
									class="ureq"
									style=${`width:${String(Math.max(4,a.requests/i*100))}%`}
								></i
							></span>
						</td>
						<td>
							<span class="uwr"
								><i
									class=${o>=50?"uwarm":"ucold"}
									style=${`width:${String(Math.max(2,o))}%`}
									title=${`${S(o/100)} of ${String(a.known)} known`}
								></i
							></span>
							<span class="unum">${a.known>0?S(o/100):"—"}</span>
						</td>
						<td class="unum">${k(a.cache_r_tok)}</td>
						<td class="unum" title=${a.cache_c_known?`${String(a.cache_c_known)} requests reported cache writes`:"Provider did not report cache writes"}>${a.cache_c_known?k(a.cache_c_tok):"—"}</td>
						<td class="unum"><time title=${a.last_ts??"Unknown time"} datetime=${a.last_ts??""}>${j(a.last_ts)}</time></td>
					</tr>`})}
			</tbody>
		</table>`}scopePanel(s){let l=s.lane_scope;if(l===null)return t;let i=l.requests,a=s.hubs;return e`<div class="upanel">
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
							</tr>`:i.map((o)=>{let d=a.find((h)=>h.label===o.hub)?.label??o.hub??"";return e`<tr class=${o.ok===!1?"ubad":""}>
					<td class="unum"><time datetime=${o.ts} title=${o.ts}>${j(o.ts,!0)}</time></td>
									<td>${o.target_model??"—"}</td>
									<td class="unum">${o.status===null?"—":String(o.status)}</td>
									<td class="unum ${o.cache_r===0?"ucoldtext":""}">
										${o.cache_r===null?"—":k(o.cache_r)}
									</td>
									<td class="unum">
										${o.cache_c_reported?k(o.cache_c??0):"—"}
									</td>
									<td class="unum">
										${o.duration_ms===null?"—":k(o.duration_ms)}
									</td>
									<td><span class="uchip">${d}</span></td>
								</tr>`})}
				</tbody>
			</table>
		</div>`}}B.styles=[n`
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
	`];customElements.define("klh-usage-cache-drill",B);var ae=(s)=>s>=1e9?`${(s/1e9).toFixed(1)}B`:s>=1e6?`${(s/1e6).toFixed(1)}M`:s>=1000?`${(s/1000).toFixed(1)}K`:String(Math.round(s)),re=(s)=>`${(s*100).toFixed(1)}%`,le=()=>{let s=document.getElementById("usage-data");if(!s)return null;try{return JSON.parse(s.textContent??"").panels?.coverage??null}catch{return null}};class W extends r{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=le()}render(){let s=this.panel;if(!s)return e``;if(s.hoursData===0)return e`<div class="upanel">
				<h2>EVIDENCE · COVERAGE & FRESHNESS</h2>
				<p class="uempty">
					no usage data in this window (${s.from} → ${s.to}) — the charts
					above show honest zeros
				</p>
			</div>`;return this.body(s)}body(s){return e`<div class="upanel">
			<div class="uhead">
				<h2>EVIDENCE · COVERAGE & FRESHNESS</h2>
				<p class="ufoot">${s.source}${s.demoNote?` · ${s.demoNote}`:""}</p>
			</div>
			<p class="ufoot">
				window ${s.from} → ${s.to} ·
				<b
					>${String(s.hoursData)} of ${String(s.hoursTotal)}</b
				> hours with data (<b
					>${re(s.hoursData/Math.max(1,s.hoursTotal))}</b
				>)
				${s.newest?e`· newest data ${s.newest} (${String(s.newestAgeH)}h before
					window end)`:t}
			</p>
			${s.longestGapH>0?e`<p class="ufoot">
						longest zero-run <b>${String(s.longestGapH)}h</b> ending
						${s.gapEnd}
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
						${s.byDay.map((l)=>e`<tr>
									<td><b>${l.d}</b></td>
									<td class="unum">${String(l.hoursData)}</td>
									<td class="unum">${ae(l.tok)}</td>
									<td>
										${l.href?e`<a href=${l.href}>hour detail →</a>`:"—"}
									</td>
								</tr>`)}
					</tbody>
				</table>
			</details>
		</div>`}}W.styles=n`
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
`;customElements.define("klh-usage-coverage",W);var V=[{key:"lane",label:"lane"},{key:"model",label:"model"},{key:"provider",label:"provider"},{key:"hub",label:"hub"}],J=[{key:"requests",label:"requests/h",title:"inference requests per hour"},{key:"throughput",label:"throughput",title:"provider-reported output tokens per hour"},{key:"failures",label:"failures",title:"requests answered not-ok or status >= 400 per hour"},{key:"cache",label:"cache hits",title:"requests with a warm cache read per hour"},{key:"latency",label:"latency",title:"average provider duration (ms) per hour"}],N=["#3987e5","#d95926","#199e70","#c98500","#d55181","#7e6bd1","#3f9f9f","#a08a4f"],G=(s)=>s>=1e9?`${(s/1e9).toFixed(1)}B`:s>=1e6?`${(s/1e6).toFixed(1)}M`:s>=1000?`${(s/1000).toFixed(1)}K`:String(Math.round(s)),D=(s)=>s===null?"—":`${(s*100).toFixed(0)}%`,Q=(s)=>s===null?"—":`${String(s)}ms`,ie=`
.kmon-chips { display:flex; gap:4px; flex-wrap:wrap; margin:8px 0 12px; }
.kmon-chips button { font:inherit; font-size:11px; color:var(--klh-dim); background:none; border:1px solid var(--klh-edge); border-radius:2px; padding:3px 10px; cursor:pointer; }
.kmon-chips button.on, .kmon-chips button:hover { color:var(--klh-accent); border-color:var(--klh-accent); }
.kmon-scroll { overflow-x:auto; }
.kmon table { border-collapse:collapse; width:100%; font-size:11px; }
.kmon th, .kmon td { text-align:left; padding:4px 10px 4px 0; border-bottom:1px solid var(--klh-edge-soft); white-space:nowrap; font-variant-numeric:tabular-nums; }
.kmon th { color:var(--klh-dim); font-weight:600; text-transform:uppercase; letter-spacing:.06em; font-size:10px; }
.kmon td.k { color:var(--klh-ink); font-family:var(--klh-font-mono); }
.kmon .dim2 { color:var(--klh-dim); }
`;class X extends r{static properties={dim:{type:String,state:!0},metric:{type:String,state:!0},report:{type:Object,state:!0},err:{type:String,state:!0},loading:{type:Boolean,state:!0}};days=7;chart=null;ro=null;onTheme=null;gen=0;constructor(){super();this.dim="lane",this.metric="requests",this.report=null,this.err="",this.loading=!0}connectedCallback(){super.connectedCallback(),this.days=Math.min(90,Math.max(1,Number(new URLSearchParams(location.search).get("days")??7)||7));let s=location.hash.replace(/^#monitor\/?/,"").split("/"),l=V.find((a)=>a.key===s[0]);if(l!==void 0)this.dim=l.key;let i=J.find((a)=>a.key===s[1]);if(i!==void 0)this.metric=i.key;this.onTheme=()=>this.mountChart(!0),document.addEventListener("klh-themechange",this.onTheme),this.load()}disconnectedCallback(){if(super.disconnectedCallback(),this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme);this.onTheme=null,this.ro?.disconnect(),this.ro=null,this.chart?.destroy(),this.chart=null}async load(){let s=++this.gen;this.loading=!0,this.err="";try{let l=await fetch(`/api/usage/monitor?days=${String(this.days)}&dim=${this.dim}`),i=await l.json();if(s!==this.gen)return;if(!l.ok||i.ok!==!0)throw Error(i.error??`status ${String(l.status)}`);this.report=i,this.loading=!1,await this.updateComplete,this.mountChart(!1)}catch(l){if(s!==this.gen)return;this.err=String(l),this.loading=!1}}setDim(s){this.dim=s,history.replaceState(null,"",`#monitor/${s}/${this.metric}`),this.load()}setMetric(s){this.metric=s,history.replaceState(null,"",`#monitor/${this.dim}/${s}`),this.mountChart(!1)}createRenderRoot(){return this}mountChart(s){let l=globalThis.uPlot,i=this.querySelector("#kmon-chart"),a=this.report?.series;if(!l||!i||!a)return;let o=this.metric,d=a[o];if(d===void 0)return;if(s&&this.chart!==null)this.chart.destroy(),this.chart=null;if(this.chart!==null){let g=i.clientWidth;if(g>0&&g!==this.chart.width)this.chart.setSize({width:g,height:240});return}let h=a.labels.length,p=[{}];for(let g=0;g<h;g++){let R=N[g%N.length];p.push({label:a.labels[g],stroke:R,fill:o==="requests"||o==="throughput"?R:void 0,width:1.4,points:{show:h<=2},value:(oe,U)=>U===null||!Number.isFinite(U)?"—":o==="throughput"?G(U):o==="latency"?`${String(Math.round(U))}ms`:String(Math.round(U))})}let x=(g,R)=>getComputedStyle(document.documentElement).getPropertyValue(g).trim()||R,b=()=>x("--klh-chart-axis","#898781"),m=()=>x("--klh-chart-grid","#2c2c2a"),f=()=>x("--klh-chart-hair","#383835");if(this.chart=new l({width:i.clientWidth,height:240,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:p,axes:[{side:2,stroke:b,grid:{show:!0,stroke:m,width:1},ticks:{show:!0,stroke:f,width:1}},{side:3,size:72,stroke:b,grid:{show:!1},ticks:{show:!0,stroke:f,width:1}}]},d,i),typeof ResizeObserver==="function")this.ro?.disconnect(),this.ro=new ResizeObserver(()=>{let g=i.clientWidth;if(this.chart!==null&&g>0&&g!==this.chart.width)this.chart.setSize({width:g,height:240})}),this.ro.observe(i)}render(){let s=this.report,l=s?.coverage,i=(s?.hubs??[]).filter((a)=>!a.ok);return e`<style>
				${ie}
			</style><div class="upanel kmon">
			<div class="uhead">
				<h2>MONITOR · DRILLDOWN BY ${this.dim.toUpperCase()}</h2>
				<p class="ufoot">${String(this.days)}d shared window · buckle request ledger · hover = values · drag = zoom · double-click = reset</p>
			</div>
			<div class="kmon-chips" role="group" aria-label="Monitor dimension">
				${V.map((a)=>e`<button
						class=${a.key===this.dim?"on":""}
						@click=${()=>this.setDim(a.key)}
					>${a.label}</button>`)}
			</div>
			<div class="kmon-chips" role="group" aria-label="Monitor metric">
				${J.map((a)=>e`<button
						class=${a.key===this.metric?"on":""}
						title=${a.title}
						@click=${()=>this.setMetric(a.key)}
					>${a.label}</button>`)}
			</div>
			<div class="ulegend">
				${(s?.series?.labels??[]).map((a,o)=>e`<span><i style=${`background:${N[o%N.length]}`}></i
							>${a}</span>`)}
			</div>
			<div id="kmon-chart" class="uchart"></div>
			${this.loading?e`<p class="uempty">Loading monitor…</p>`:t}
			${this.err!==""?e`<p class="uempty" role="alert">Monitor unavailable: ${this.err}</p>`:t}
			${l!==void 0?e`<p class="ufoot">
						${String(l.requests)} inference requests
						(${String(l.probe_requests)} probes excluded) · tokens reported
						${String(l.rows_with_tokens)} · duration ${String(l.rows_with_duration)} · cache
						verdicts ${String(l.rows_with_cache_verdict)} · failure verdicts
						${String(l.rows_with_failure_verdict)} · hub ceiling
						${String(l.per_hub_row_limit)} rows/hub${s?.transcripts?` · transcript meter ${s.transcripts.source} (${String(s.transcripts.requests)} req, ${G(s.transcripts.cache_read_tokens)} cache-read tok)`:""}
					</p>`:t}
			${i.length>0?e`<p class="uempty">hubs degraded: ${i.map((a)=>`${a.label} (${a.reason??"unreachable"})`).join(" · ")}</p>`:t}
		</div>
		<div class="upanel kmon">
			<h2>GROUPS · ${this.dim.toUpperCase()}</h2>
			${s===null||s.rows.length===0?e`<p class="uempty">${this.loading?"":"No request-ledger rows in this window."}</p>`:e`<div class="kmon-scroll"><table>
						<thead><tr>
							<th>${this.dim}</th><th>req</th><th>out tok</th><th>fail</th>
							<th>cache warm</th><th>p50</th><th>p95</th>
							${this.dim==="lane"?e`<th title="W243 meter: orientation share · context share · searches/request">work type</th>`:t}
						</tr></thead>
						<tbody>${s.rows.map((a)=>e`<tr>
								<td class="k">${a.key}</td>
								<td>${String(a.requests)}</td>
								<td>${a.tok_reported>0?G(a.out_tok):"—"}</td>
								<td>${a.failure_observed>0?D(a.failures/a.failure_observed):"—"}</td>
								<td>${a.known>0?D(a.warm_ratio):"—"}</td>
								<td>${Q(a.lat_p50_ms)}</td>
								<td>${Q(a.lat_p95_ms)}</td>
								${this.dim==="lane"?e`<td class="dim2">${a.work===null?"—":`orient ${D(a.work.orient)} · ctx ${D(a.work.context)} · ${a.work.spr.toFixed(2)} srq`}</td>`:t}
							</tr>`)}</tbody>
					</table></div>`}
		</div>`}}customElements.define("klh-usage-monitor",X);customElements.define("klh-usage-header",M);customElements.define("klh-usage-tiles",P);customElements.define("klh-usage-actors",_);customElements.define("klh-usage-aids",L);customElements.define("klh-usage-activity",q);customElements.define("klh-usage-spokes",H);customElements.define("klh-usage-crosshub",z);customElements.define("klh-usage-drilldown",O);customElements.define("klh-usage-charts",A);
