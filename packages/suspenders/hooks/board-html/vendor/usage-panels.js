import{r,e,t,s}from"./lit-vw87e78c.js";var d=()=>{let a=document.getElementById("usage-data");if(!a)return null;try{return JSON.parse(a.textContent??"").panels??null}catch{return null}},y=()=>{let a=document.getElementById("usage-data");if(!a)return{};try{return JSON.parse(a.textContent??"").slot??{}}catch{return{}}},n=(a)=>a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1000?`${(a/1000).toFixed(1)}K`:String(Math.round(a)),p=(a)=>`${(a*100).toFixed(1)}%`,c=r`
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
`;class u extends s{static properties={tiles:{type:Array,state:!0}};constructor(){super();this.tiles=[]}connectedCallback(){super.connectedCallback(),this.tiles=d()?.tiles??[]}render(){if(!this.tiles.length)return e``;return e`<div class="utiles">
			${this.tiles.map((a)=>e`<div class="utile">
					<div class="uv">${a.v}</div>
					<div class="uk">${a.k}</div>
				</div>`)}
		</div>`}}u.styles=r`
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
`;var k=(a,l)=>a[l]??"#888",v=(a,l,o)=>{let i=a.tok?`${(a.tok/Math.max(1,l)*100).toFixed(2)}%`:"0";return e`<i
		style=${`width:${i};background:${k(o,a.g)}`}
		title=${`${a.g}: ${n(a.tok)} tok`}
	></i>`};class h extends s{static properties={rows:{type:Array,state:!0}};slot={};constructor(){super();this.rows=[]}connectedCallback(){super.connectedCallback(),this.rows=d()?.actors?.rows??[],this.slot=y()}render(){let a=d()?.actors;if(!a?.rows.length)return e``;return this.body(a.rows)}body(a){return e`<div class="upanel">
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
		</div>`}row(a){let l=[...a.demo?["synthetic demo"]:[],...a.chips].map((o)=>e`<span class="uchip">${o}</span>`);return e`<tr class="uact">
				<td>
					<b>${a.actor}</b>
					${l}
				</td>
				<td>
					<div class="ubar" style=${`width:${a.barW}%`}>
						${a.segs.map((o)=>v(o,a.total,this.slot))}
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
					style=${`background:${k(this.slot,a.g)}`}
				></i
				>${a.m}
			</td>
			<td class="unum">${n(a.tok)}</td>
			<td class="unum">${n(a.rq)}</td>
		</tr>`}}h.styles=[c,r`
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
	`];class m extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=d()?.aids??null}render(){let a=this.panel;if(!a)return e``;if(a.empty)return e`<div class="upanel">
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
		</tr>`}}m.styles=[c,r`
		:host {
			display: block;
		}
	`];var x={context:"#3987e5",planning:"#199e70",code:"#d95926",communicating:"#c98500"};class g extends s{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=d()?.activity??null}render(){let a=this.panel;if(!a)return e``;if("empty"in a)return e`<div class="upanel">
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
					<td style="width:44%">${l.cells.map((o,i)=>this.cell(o,i))}</td>
					<td class="unum">${p(l.orient)}</td>
				</tr>`)}
			</tbody>
		</table>`}cell(a,l){let o=l>0?e`<span class="usep">·</span>`:t;if(!a.share)return e`${o}<span class="uempty">—</span>`;let i=p(a.share);return e`${o}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${i};background:${x[a.key]??"#888"}`}
					title=${`${a.key}: ${i}`}
				></i></span
			><span class="unum">${i}</span></span
		>`}lanes(a){let l=a.length?a.map((o)=>this.laneRow(o)):[e`<tr>
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
			<td class="unum">${p(a.orient)}</td>
			<td class="unum">${a.spr}</td>
			<td class="unum">${n(a.cost)}</td>
			<td class="unum">${n(a.req)}</td>
		</tr>`}}g.styles=[c,r`
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
	`];var f="no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";class b extends s{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=d()?.spokes??null,this.slot=y()}render(){let a=d()?.spokes;if(!a)return e``;if(!a.rows.length)return this.empty();return this.body(a.rows)}empty(){return e`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${f}</p>
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
					${a.segs.map((l)=>v(l,a.total,this.slot))}
				</div>
			</td>
			<td class="unum">${n(a.total)}</td>
			<td class="unum">${n(a.rq)}</td>
		</tr>`}}b.styles=[c,r`
		:host {
			display: block;
		}
	`];customElements.define("klh-usage-tiles",u);customElements.define("klh-usage-actors",h);customElements.define("klh-usage-aids",m);customElements.define("klh-usage-activity",g);customElements.define("klh-usage-spokes",b);export{g as KlhUsageActivity,h as KlhUsageActors,m as KlhUsageAids,b as KlhUsageSpokes,u as KlhUsageTiles};
