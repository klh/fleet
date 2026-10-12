import{r,e,t,s}from"./lit-9bpcreb0.js";var x=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"")}catch{return null}},m=()=>x()?.panels??null,A=()=>x()?.slot??{},n=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),y=(a)=>`${(a*100).toFixed(1)}%`,v=r`
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
`;class w extends s{static properties={header:{type:Object,state:!0}};constructor(){super();this.header=null}connectedCallback(){super.connectedCallback(),this.header=m()?.header??null}chips(a,l,i){return e`<span class="ufgroup" data-label=${a}
			>${l.map((o)=>e`<a class="${i}${o.on?" on":""}" href=${o.href}
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
			</div>`}render(){return e`${this.header?this.body(this.header):t}`}}w.styles=r`
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
`;class R extends s{static properties={tiles:{type:Array,state:!0}};constructor(){super();this.tiles=[]}connectedCallback(){super.connectedCallback(),this.tiles=m()?.tiles??[]}render(){if(!this.tiles.length)return e``;return e`<div class="utiles">
			${this.tiles.map((a)=>e`<div class="utile">
					<div class="uv">${a.v}</div>
					<div class="uk">${a.k}</div>
				</div>`)}
		</div>`}}R.styles=r`
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
`;var b=(a,l)=>a[l]??"#888",S=(a,l,i)=>{let o=a.tok?`${(a.tok/Math.max(1,l)*100).toFixed(2)}%`:"0";return e`<i
		style=${`width:${o};background:${b(i,a.g)}`}
		title=${`${a.g}: ${n(a.tok)} tok`}
	></i>`};class T extends s{static properties={rows:{type:Array,state:!0}};slot={};constructor(){super();this.rows=[]}connectedCallback(){super.connectedCallback(),this.rows=m()?.actors?.rows??[],this.slot=A()}render(){let a=m()?.actors;if(!a?.rows.length)return e``;return this.body(a.rows)}body(a){return e`<div class="upanel">
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
						${a.segs.map((i)=>S(i,a.total,this.slot))}
					</div>
				</td>
				<td class="unum">${n(a.total)}</td>
				<td class="unum">${n(a.rq)}</td>
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
					style=${`background:${b(this.slot,a.g)}`}
				></i
				>${a.m}
			</td>
			<td class="unum">${n(a.tok)}</td>
			<td class="unum">${n(a.rq)}</td>
		</tr>`}}T.styles=[v,r`
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
	`];class U extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=m()?.aids??null}render(){let a=this.panel;if(!a)return e``;if(a.empty)return e`<div class="upanel">
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
			<td class="unum">${n(a.inj)}</td>
			<td class="unum">${n(a.skip)}</td>
			<td class="unum">${n(a.tok)}</td>
		</tr>`}}U.styles=[v,r`
		:host {
			display: block;
		}
	`];var O={context:"#3987e5",planning:"#199e70",code:"#d95926",communicating:"#c98500"};class C extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=m()?.activity??null}render(){let a=this.panel;if(!a)return e``;if("empty"in a)return e`<div class="upanel">
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
					<td class="unum">${n(l.cost)}</td>
					<td style="width:44%">${l.cells.map((i,o)=>this.cell(i,o))}</td>
					<td class="unum">${y(l.orient)}</td>
				</tr>`)}
			</tbody>
		</table>`}cell(a,l){let i=l>0?e`<span class="usep">·</span>`:t;if(!a.share)return e`${i}<span class="uempty">—</span>`;let o=y(a.share);return e`${i}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${o};background:${O[a.key]??"#888"}`}
					title=${`${a.key}: ${o}`}
				></i></span
			><span class="unum">${o}</span></span
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
			<td class="unum">${y(a.orient)}</td>
			<td class="unum">${a.spr}</td>
			<td class="unum">${n(a.cost)}</td>
			<td class="unum">${n(a.req)}</td>
		</tr>`}}C.styles=[v,r`
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
	`];var H="no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";class E extends s{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=m()?.spokes??null,this.slot=A()}render(){let a=m()?.spokes;if(!a)return e``;if(!a.rows.length)return this.empty();return this.body(a.rows)}empty(){return e`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${H}</p>
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
			<td class="unum">${n(a.total)}</td>
			<td class="unum">${n(a.rq)}</td>
		</tr>`}}E.styles=[v,r`
		:host {
			display: block;
		}
	`];class P extends s{static properties={tl:{type:String},hours:{type:String}};slot={};groups=[];timeline=[];byHour=[];charts=[];ros=[];resizes=[];onTheme=null;constructor(){super();this.tl="TOKENS · STACKED BY MODEL GROUP",this.hours="WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)"}connectedCallback(){super.connectedCallback(),this.tl=this.getAttribute("tl")??this.tl,this.hours=this.getAttribute("hours")??this.hours;let a=x();if(this.slot=a?.slot??{},this.groups=a?.groups??[],this.timeline=a?.timeline??[],this.byHour=a?.byHour??[],this.onTheme===null)this.onTheme=()=>{for(let l of this.charts)l.redraw(!1,!0)},document.addEventListener("klh-themechange",this.onTheme)}disconnectedCallback(){super.disconnectedCallback();for(let a of this.ros)a.disconnect();this.ros=[];for(let a of this.resizes)window.removeEventListener("resize",a);if(this.resizes=[],this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme),this.onTheme=null}createRenderRoot(){return this}render(){if(!this.timeline.length&&!this.byHour.length)return e``;return e`<div class="upanel">
				<div class="uhead">
					<h2>${this.tl}</h2>
					<p class="ufoot">hover = values · drag = zoom · double-click = reset</p>
				</div>
				<div class="ulegend">
					${this.groups.map((a)=>e`<span><i style=${`background:${b(this.slot,a)}`}></i
								>${a}</span>`)}
				</div>
				<div id="u-timeline" class="uchart"></div>
			</div>
			<div class="upanel">
				<h2>${this.hours}</h2>
				<div id="u-hours" class="uchart"></div>
			</div>`}firstUpdated(){let a=globalThis.uPlot;if(!a)return;let l=(u,d)=>getComputedStyle(document.documentElement).getPropertyValue(u).trim()||d,i=()=>l("--klh-chart-grid","#2c2c2a"),o=()=>l("--klh-chart-hair","#383835"),k=()=>l("--klh-chart-axis","#898781"),g=(u,d)=>d.map((p)=>n(p)),h=(u,d)=>{let p={side:u,stroke:k,grid:{show:!0,stroke:i,width:1},ticks:{show:!0,stroke:o,width:1}};if(d)p.values=d;return p},c=this.querySelector("#u-timeline");if(c&&this.groups.length){let u=[{}];for(let d of this.groups){let p=b(this.slot,d);u.push({label:d,stacked:!0,stroke:p,fill:p,width:1,points:{show:!1},value:(z)=>n(z??0)})}this.chart(c,a,{width:c.clientWidth,height:300,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:u,axes:[h(2),h(3,g)]},this.timeline,300)}let f=this.querySelector("#u-hours");if(f)this.chart(f,a,{width:f.clientWidth,height:190,legend:{show:!1},scales:{x:{time:!1}},series:[{},{label:"tokens",stroke:b(this.slot,"flash"),fill:b(this.slot,"flash"),paths:a.paths?.bars({size:[0.72,100]}),points:{show:!1},value:(u)=>n(u??0)}],axes:[h(2,(u,d)=>d.map((p)=>String(Math.round(p)).padStart(2,"0"))),h(3,g)]},this.byHour,190)}chart(a,l,i,o,k){let g=new l(i,o,a);this.charts.push(g);let h=()=>{let c=a.clientWidth;if(c>0&&c!==g.width)g.setSize({width:c,height:k})};if(typeof ResizeObserver==="function"){let c=new ResizeObserver(h);c.observe(a),this.ros.push(c)}else this.resizes.push(h),window.addEventListener("resize",h)}}P.styles=r`
	:host {
		display: block;
	}
`;customElements.define("klh-usage-header",w);customElements.define("klh-usage-tiles",R);customElements.define("klh-usage-actors",T);customElements.define("klh-usage-aids",U);customElements.define("klh-usage-activity",C);customElements.define("klh-usage-spokes",E);customElements.define("klh-usage-charts",P);export{C as KlhUsageActivity,T as KlhUsageActors,U as KlhUsageAids,P as KlhUsageCharts,w as KlhUsageHeader,E as KlhUsageSpokes,R as KlhUsageTiles};
