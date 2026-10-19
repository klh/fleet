import{r,e,t,s}from"./lit-9bpcreb0.js";var N=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"").head??null}catch{return null}};class x extends s{static properties={head:{type:Object,state:!0}};constructor(){super();this.head=null}connectedCallback(){super.connectedCallback(),this.head=N()}render(){let a=this.head;if(a===null)return t;return e`<h1 class="utitle">${a.title}</h1>
			<div class="uback">
				<a href=${a.backHref}>&larr; ${a.backLabel}</a>
				<span class=${a.note.kind==="on"?"uon":"uwin"}
					>${a.note.text}</span
				>
			</div>
			<div class="ufilters">
				${a.filters.map((l)=>e`<span class="ufgroup" data-label=${l.label}>
						${l.options.map((n)=>e`<a class=${n.on?"ufilter on":"ufilter"} href=${n.href}
									>${n.label}</a
								>`)}
					</span>`)}
			</div>`}}x.styles=r`
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
`;customElements.define("klh-usage-head",x);var d=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),M=(a)=>`${(a*100).toFixed(1)}%`,F=[{v:"warm-rate",label:"warm rate (worst first)"},{v:"cache-miss",label:"cache-miss ratio"},{v:"tokens",label:"tokens"},{v:"cost",label:"cost index"},{v:"requests",label:"requests"}];class w extends s{static properties={rep:{type:Object,state:!0},page:{type:Object,state:!0},drill:{type:String,state:!0},days:{type:Number,state:!0},model:{type:String,state:!0},sort:{type:String,state:!0},missOnly:{type:Boolean,state:!0},err:{type:String,state:!0}};constructor(){super();this.rep=null,this.page=null,this.drill="",this.days=7,this.model="",this.sort="warm-rate",this.missOnly=!1,this.err=""}connectedCallback(){super.connectedCallback(),this.load()}async load(){let a=new URLSearchParams({days:String(this.days),sort:this.sort});if(this.model!=="")a.set("model",this.model);try{let n=await(await fetch(`/api/usage/drilldown?${a}`)).json();this.rep=n.report??null,this.err=this.rep?.available===!1?"no readable buckle ledger — drilldown unavailable":""}catch{this.err="drilldown fetch failed",this.rep=null}}async open(a){if(this.drill===a){this.drill="",this.page=null;return}this.drill=a,this.page=null;let l=new URLSearchParams({drill:a,days:String(this.days)});if(this.model!=="")l.set("model",this.model);if(this.missOnly)l.set("missOnly","1");try{let o=await(await fetch(`/api/usage/drilldown?${l}`)).json();this.page=o.page??null}catch{this.page={available:!1,lane:a,rows:[],total:0,truncated:!1,reasons:[]}}}setFilter(a){if(Object.assign(this,a),this.load(),this.drill!==""){let l=this.drill;this.drill="",this.open(l)}}render(){if(this.rep===null)return e`<div class="upanel"><p class="uempty">${this.err===""?"loading…":this.err}</p></div>`;return e`<div class="upanel">
			<h2>CACHE EFFICIENCY · ${this.rep.window.days}D</h2>
			${this.controls()}
			${this.fleetLine()}
			<table class="udrill">
				<thead>
					<tr>
						<th>lane</th>
						<th class="unum">reqs</th>
						<th class="unum">warm</th>
						<th class="unum">warm%</th>
						<th class="unum">cache rd</th>
						<th class="unum">cache wr</th>
						<th class="unum">tokens</th>
						<th class="unum">cost idx</th>
						<th>why cold</th>
					</tr>
				</thead>
				<tbody>
					${this.rep.lanes.map((a)=>this.laneRow(a))}
				</tbody>
			</table>
		</div>`}controls(){return e`<div class="uctl">
			<label>window
				<select @change=${(a)=>this.setFilter({days:Number(a.target.value)})}>
					${[1,7,30,90].map((a)=>e`<option value=${a} ?selected=${this.days===a}>${a}d</option>`)}
				</select>
			</label>
			<label>model
				<select @change=${(a)=>this.setFilter({model:a.target.value})}>
					<option value="" ?selected=${this.model===""}>all</option>
					${(this.rep?.models??[]).map((a)=>e`<option value=${a} ?selected=${this.model===a}>${a}</option>`)}
				</select>
			</label>
			<label>sort
				<select @change=${(a)=>this.setFilter({sort:a.target.value})}>
					${F.map((a)=>e`<option value=${a.v} ?selected=${this.sort===a.v}>${a.label}</option>`)}
				</select>
			</label>
			<label class="uchk">
				<input type="checkbox" ?checked=${this.missOnly} @change=${(a)=>this.setFilter({missOnly:a.target.checked})} />
				requests: cache-miss only
			</label>
		</div>`}fleetLine(){let a=this.rep?.fleet;if(!a)return t;return e`<p class="ufleet">
			fleet warm-rate <b>${M(a.warmRate)}</b> · ${d(a.requests)} requests warmed ${d(a.warm)} ·
			${d(a.tokens)} tokens · cost idx ${d(Math.round(a.costIndex))}
		</p>`}laneRow(a){let l=this.drill===a.lane;return e`<tr class=${l?"open":""} @click=${()=>void this.open(a.lane)}>
			<td class="ulane">${l?"▾":"▸"} ${a.lane===""?"(unlaned)":a.lane}</td>
			<td class="unum">${d(a.requests)}</td>
			<td class="unum">${d(a.warm)}</td>
			<td class="unum ${a.warmRate<0.25?"bad":a.warmRate>=0.6?"good":""}">${M(a.warmRate)}</td>
			<td class="unum">${d(a.cacheR)}</td>
			<td class="unum">${d(a.cacheC)}</td>
			<td class="unum">${d(a.tokens)}</td>
			<td class="unum">${d(Math.round(a.costIndex))}</td>
			<td class="uwhy">${a.reasons.slice(0,3).map((n)=>e`<span class="uwhy-r">${n.reason}×${n.count}</span>`)}</td>
		</tr>
		${l&&this.page!==null?this.drillRow():t}`}drillRow(){return e`<tr class="usub">
			<td colspan="9">
				${this.page===null?e`<p class="uempty">loading ${this.drill}…</p>`:e`<p class="ufoot">
							${d(this.page.total)} requests${this.page.truncated?" (capped — raise ?limit)":""} ·
							${this.page.reasons.slice(0,3).map((a)=>e`<span class="uwhy-r">${a.reason}×${a.count}</span>`)}
						</p>
						<table class="ureq">
							<thead>
								<tr><th>ts</th><th>model</th><th class="unum">status</th><th class="unum">ms</th><th class="unum">cache rd</th><th class="unum">cache wr</th><th>decision</th></tr>
							</thead>
							<tbody>
								${this.page.rows.map((a)=>e`<tr>
										<td class="uts">${a.ts.replace("T"," ").slice(0,19)}</td>
										<td>${a.model}</td>
										<td class="unum ${a.ok?"":"bad"}">${a.status}</td>
										<td class="unum">${d(a.durationMs)}</td>
										<td class="unum">${d(a.cacheR)}</td>
										<td class="unum">${d(a.cacheC)}</td>
										<td class="udec" title=${a.err??""}>${a.decision}</td>
									</tr>`)}
							</tbody>
						</table>`}
			</td>
		</tr>`}}w.styles=r`
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
	.uempty,
	.ufoot {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
		margin: 2px 0 8px;
	}
	.uctl {
		display: flex;
		gap: 16px;
		align-items: center;
		flex-wrap: wrap;
		margin: 8px 0 10px;
		font-size: 11px;
		color: var(--klh-dim, #98958e);
	}
	.uctl select {
		background: var(--klh-bg, #141311);
		color: var(--klh-ink, #e8e6e1);
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		font: inherit;
		padding: 1px 4px;
	}
	.ufleet {
		font-size: 11.5px;
		color: var(--klh-ink, #e8e6e1);
		margin: 0 0 8px;
	}
	.ufleet b {
		color: var(--klh-accent, #e0a458);
	}
	table.udrill,
	table.ureq {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.udrill th,
	table.udrill td,
	table.ureq th,
	table.ureq td {
		padding: 5px 8px;
		border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
		text-align: left;
	}
	th {
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--klh-dim, #98958e);
	}
	.unum {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.bad {
		color: var(--klh-bad, #c25b4e);
	}
	.good {
		color: var(--klh-good, #7ba05b);
	}
	tr[data-open] td,
	tbody tr {
		cursor: pointer;
	}
	tbody tr.usub,
	tbody tr.usub td {
		cursor: default;
	}
	.usub > td {
		background: var(--klh-bg, #141311);
	}
	.ulane {
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.uwhy-r {
		display: inline-block;
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 2px;
		padding: 0 4px;
		margin: 0 3px 2px 0;
		white-space: nowrap;
	}
	.uts,
	.udec {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.udec {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
`;customElements.define("klh-usage-drilldown",w);var T=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"")}catch{return null}},u=()=>T()?.panels??null,C=()=>T()?.slot??{},i=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),R=(a)=>`${(a*100).toFixed(1)}%`,f=r`
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
`;class U extends s{static properties={header:{type:Object,state:!0}};constructor(){super();this.header=null}connectedCallback(){super.connectedCallback(),this.header=u()?.header??null}chips(a,l,n){return e`<span class="ufgroup" data-label=${a}
			>${l.map((o)=>e`<a class="${n}${o.on?" on":""}" href=${o.href}
						>${o.label}</a
					>`)}</span
		>`}body(a){let l=a.demoToggle;return e`<div class="uback">
				<a href="/">&larr; fleet board</a><span class="uwin">${a.back}</span>
			</div>
			<h1 class="utitle">USAGE</h1>
			<div class="ufilters">
				${this.chips("window",a.windows,"ufilter")}
				${this.chips("team",a.teams,"ufchip")}
				${this.chips("dept",a.depts,"ufchip")}
				${a.filtered?e`<span class="uon">${a.filtered}</span>`:t}
				${l?e`<a class="ufilter${l.on?" on":""}" href=${l.href}
							>${l.label}</a
						>`:t}
				<span class="uon">${a.status}</span>
			</div>`}render(){return e`${this.header?this.body(this.header):t}`}}U.styles=r`
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
`;class E extends s{static properties={tiles:{type:Array,state:!0}};constructor(){super();this.tiles=[]}connectedCallback(){super.connectedCallback(),this.tiles=u()?.tiles??[]}render(){if(!this.tiles.length)return e``;return e`<div class="utiles">
			${this.tiles.map((a)=>e`<div class="utile">
					<div class="uv">${a.v}</div>
					<div class="uk">${a.k}</div>
				</div>`)}
		</div>`}}E.styles=r`
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
`;var v=(a,l)=>a[l]??"#888",S=(a,l,n)=>{let o=a.tok?`${(a.tok/Math.max(1,l)*100).toFixed(2)}%`:"0";return e`<i
		style=${`width:${o};background:${v(n,a.g)}`}
		title=${`${a.g}: ${i(a.tok)} tok`}
	></i>`};class P extends s{static properties={rows:{type:Array,state:!0}};slot={};constructor(){super();this.rows=[]}connectedCallback(){super.connectedCallback(),this.rows=u()?.actors?.rows??[],this.slot=C()}render(){let a=u()?.actors;if(!a?.rows.length)return e``;return this.body(a.rows)}body(a){return e`<div class="upanel">
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
		</div>`}row(a){let l=[...a.demo?["synthetic demo"]:[],...a.chips].map((n)=>e`<span class="uchip">${n}</span>`);return e`<tr class="uact">
				<td>
					<b>${a.actor}</b>
					${l}
				</td>
				<td>
					<div class="ubar" style=${`width:${a.barW}%`}>
						${a.segs.map((n)=>S(n,a.total,this.slot))}
					</div>
				</td>
				<td class="unum">${i(a.total)}</td>
				<td class="unum">${i(a.rq)}</td>
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
					style=${`background:${v(this.slot,a.g)}`}
				></i
				>${a.m}
			</td>
			<td class="unum">${i(a.tok)}</td>
			<td class="unum">${i(a.rq)}</td>
		</tr>`}}P.styles=[f,r`
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
	`];class O extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.aids??null}render(){let a=this.panel;if(!a)return e``;if(a.empty)return e`<div class="upanel">
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
			<td class="unum">${i(a.inj)}</td>
			<td class="unum">${i(a.skip)}</td>
			<td class="unum">${i(a.tok)}</td>
		</tr>`}}O.styles=[f,r`
		:host {
			display: block;
		}
	`];var j={context:"#3987e5",planning:"#199e70",code:"#d95926",communicating:"#c98500"};class H extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.activity??null}render(){let a=this.panel;if(!a)return e``;if("empty"in a)return e`<div class="upanel">
				<h2>ACTIVITY · DECANT SHAPE (W243)</h2>
				<p class="uempty">${a.empty}</p>
			</div>`;return this.body(a)}body(a){return e`<div class="upanel">
			<div class="uhead">
				<h2>ACTIVITY · DECANT SHAPE (W243)</h2>
				<p class="ufoot">${a.foot}</p>
			</div>
			${this.weekly(a.weekly)}
			${this.lanes(a.lanes)}
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
					<td class="unum">${i(l.cost)}</td>
					<td style="width:44%">${l.cells.map((n,o)=>this.cell(n,o))}</td>
					<td class="unum">${R(l.orient)}</td>
				</tr>`)}
			</tbody>
		</table>`}cell(a,l){let n=l>0?e`<span class="usep">·</span>`:t;if(!a.share)return e`${n}<span class="uempty">—</span>`;let o=R(a.share);return e`${n}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${o};background:${j[a.key]??"#888"}`}
					title=${`${a.key}: ${o}`}
				></i></span
			><span class="unum">${o}</span></span
		>`}lanes(a){let l=a.length?a.map((n)=>this.laneRow(n)):[e`<tr>
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
			<td class="unum">${R(a.orient)}</td>
			<td class="unum">${a.spr}</td>
			<td class="unum">${i(a.cost)}</td>
			<td class="unum">${i(a.req)}</td>
		</tr>`}}H.styles=[f,r`
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
	`];var D="no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";class z extends s{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.spokes??null,this.slot=C()}render(){let a=u()?.spokes;if(!a)return e``;if(!a.rows.length)return this.empty();return this.body(a.rows)}empty(){return e`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${D}</p>
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
					${a.segs.map((l)=>S(l,a.total,this.slot))}
				</div>
			</td>
			<td class="unum">${i(a.total)}</td>
			<td class="unum">${i(a.rq)}</td>
		</tr>`}}z.styles=[f,r`
		:host {
			display: block;
		}
	`];var B="no hub rollups — enumerate hubs in stack.yaml (hubs:) or the hubs.json registry; the board fetches each hub's /federation/usage server-side (TTL-cached, per-hub degrade)";class L extends s{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=u()?.crosshub??null,this.slot=C()}render(){let a=u()?.crosshub;if(!a)return e``;if("empty"in a)return e`<div class="upanel">
				<h2>CROSS-HUB</h2>
				<p class="uempty">${a.empty}</p>
			</div>`;if(!a.rows.length)return this.empty();return this.body(a.rows)}empty(){return e`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<p class="uempty">${B}</p>
		</div>`}row(a){if(a.degraded)return e`<tr>
				<td>
					<b>${a.hub}</b>
					<span class="uchip">degraded</span>
				</td>
				<td colspan="3">${a.reason??"hub down"}</td>
			</tr>`;let l=Math.max(2,a.total/Math.max(1,...this.rowTotals)*100);return e`<tr>
			<td>
				<b>${a.hub}</b>
				<span class="uchip">${a.via}</span>
				<span class="uchip">${String(a.spokes)} spokes</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${String(l)}%`}>
					${a.segs.map((n)=>S(n,a.total,this.slot))}
				</div>
			</td>
			<td class="unum">${i(a.total)}</td>
			<td class="unum">${i(a.rq)}</td>
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
					${a.map((l)=>this.row(l))}
				</tbody>
			</table>
		</div>`}}L.styles=[f,r`
		:host {
			display: block;
		}
	`];class A extends s{static properties={tl:{type:String},hours:{type:String}};slot={};groups=[];timeline=[];byHour=[];charts=[];ros=[];resizes=[];onTheme=null;constructor(){super();this.tl="TOKENS · STACKED BY MODEL GROUP",this.hours="WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)"}connectedCallback(){super.connectedCallback(),this.tl=this.getAttribute("tl")??this.tl,this.hours=this.getAttribute("hours")??this.hours;let a=T();if(this.slot=a?.slot??{},this.groups=a?.groups??[],this.timeline=a?.timeline??[],this.byHour=a?.byHour??[],this.onTheme===null)this.onTheme=()=>{for(let l of this.charts)l.redraw(!1,!0)},document.addEventListener("klh-themechange",this.onTheme)}disconnectedCallback(){super.disconnectedCallback();for(let a of this.ros)a.disconnect();this.ros=[];for(let a of this.resizes)window.removeEventListener("resize",a);if(this.resizes=[],this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme),this.onTheme=null}createRenderRoot(){return this}render(){if(!this.timeline.length&&!this.byHour.length)return e``;return e`<div class="upanel">
				<div class="uhead">
					<h2>${this.tl}</h2>
					<p class="ufoot">hover = values · drag = zoom · double-click = reset</p>
				</div>
				<div class="ulegend">
					${this.groups.map((a)=>e`<span><i style=${`background:${v(this.slot,a)}`}></i
								>${a}</span>`)}
				</div>
				<div id="u-timeline" class="uchart"></div>
			</div>
			<div class="upanel">
				<h2>${this.hours}</h2>
				<div id="u-hours" class="uchart"></div>
			</div>`}firstUpdated(){let a=globalThis.uPlot;if(!a)return;let l=(h,c)=>getComputedStyle(document.documentElement).getPropertyValue(h).trim()||c,n=()=>l("--klh-chart-grid","#2c2c2a"),o=()=>l("--klh-chart-hair","#383835"),k=()=>l("--klh-chart-axis","#898781"),g=(h,c)=>c.map((m)=>i(m)),b=(h,c)=>{let m={side:h,stroke:k,grid:{show:!0,stroke:n,width:1},ticks:{show:!0,stroke:o,width:1}};if(c)m.values=c;return m},p=this.querySelector("#u-timeline");if(p&&this.groups.length){let h=[{}];for(let c of this.groups){let m=v(this.slot,c);h.push({label:c,stacked:!0,stroke:m,fill:m,width:1,points:{show:!1},value:(q)=>i(q??0)})}this.chart(p,a,{width:p.clientWidth,height:300,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:h,axes:[b(2),b(3,g)]},this.timeline,300)}let y=this.querySelector("#u-hours");if(y)this.chart(y,a,{width:y.clientWidth,height:190,legend:{show:!1},scales:{x:{time:!1}},series:[{},{label:"tokens",stroke:v(this.slot,"flash"),fill:v(this.slot,"flash"),paths:a.paths?.bars({size:[0.72,100]}),points:{show:!1},value:(h)=>i(h??0)}],axes:[b(2,(h,c)=>c.map((m)=>String(Math.round(m)).padStart(2,"0"))),b(3,g)]},this.byHour,190)}chart(a,l,n,o,k){let g=new l(n,o,a);this.charts.push(g);let b=()=>{let p=a.clientWidth;if(p>0&&p!==g.width)g.setSize({width:p,height:k})};if(typeof ResizeObserver==="function"){let p=new ResizeObserver(b);p.observe(a),this.ros.push(p)}else this.resizes.push(b),window.addEventListener("resize",b)}}A.styles=r`
	:host {
		display: block;
	}
`;customElements.define("klh-usage-header",U);customElements.define("klh-usage-tiles",E);customElements.define("klh-usage-actors",P);customElements.define("klh-usage-aids",O);customElements.define("klh-usage-activity",H);customElements.define("klh-usage-spokes",z);customElements.define("klh-usage-crosshub",L);customElements.define("klh-usage-charts",A);export{H as KlhUsageActivity,P as KlhUsageActors,O as KlhUsageAids,A as KlhUsageCharts,L as KlhUsageCrossHub,U as KlhUsageHeader,z as KlhUsageSpokes,E as KlhUsageTiles};
