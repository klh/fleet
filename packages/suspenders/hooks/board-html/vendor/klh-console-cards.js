import{r,e,t,s}from"./lit-sq0mv1by.js";var o=r`
	:host {
		display: block;
		background: var(--klh-surface);
		border: 1px solid var(--klh-edge-soft);
		border-radius: 3px;
		padding: 12px 14px;
		margin: 0 0 14px;
		color: var(--klh-ink);
		font: var(--klh-text-lg) / 1.6 var(--klh-font-sans);
	}
	h2 {
		margin: 0 0 8px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--klh-dim);
		word-break: break-all;
	}
	.dimpl {
		color: var(--klh-dim);
		font-size: 12px;
	}
	.cfoot {
		font-size: 10.5px;
		color: var(--klh-dim);
		margin-top: 4px;
	}
	.errbox {
		border: 1px solid var(--klh-danger);
		color: var(--klh-danger-ink);
		background: var(--klh-danger-bg);
		border-radius: 2px;
		padding: 7px 10px;
		font-size: 12px;
		margin: 0 0 14px;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.knobs {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 0 0 10px;
	}
	.kchip {
		border: 1px solid var(--klh-edge);
		border-radius: 2px;
		padding: 2px 8px;
		font-size: 11.5px;
		color: var(--klh-ink-2);
	}
	.kchip b {
		color: var(--klh-ink);
	}
	.kchip.block {
		display: block;
		margin: 3px 0;
	}
	table.ct {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.ct td,
	table.ct th {
		padding: 5px 8px;
		border-bottom: 1px solid var(--klh-rule);
		text-align: left;
	}
	table.ct th {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--klh-dim);
	}
	.num {
		font-variant-numeric: tabular-nums;
	}
	.pill {
		display: inline-block;
		border: 1px solid var(--klh-edge);
		border-radius: 2px;
		padding: 1px 7px;
		font-size: 11px;
		color: var(--klh-ink-2);
		margin: 1px 3px 1px 0;
	}
	.mono {
		font-family: var(--klh-font-mono);
	}
`;var l=(a,i)=>a.flatMap((n,m)=>m?[e`${i}`,n]:[n]);class d extends s{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;if(a.kind==="missing")return e`<h2>${this.heading}</h2>
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
					`:t}${this.foot?e`<p class="cfoot">${this.foot}</p>`:t}`}head(a,i){let n=this.heading;if(a)n+=` · ${a}`;if(i)n+=` · source: ${i}`;return n}ladder(a){let i=Object.entries(a);if(this.compact&&i.length)return e`<span class="kchip">
				ladder: <b>${l(this.chips(i)," · ")}</b>
			</span>`;if(this.compact)return e`${t}`;return e`<table class="ct ladder">
			<thead>
				<tr>
					<th>model</th>
					<th>fallback ladder (order = priority)</th>
				</tr>
			</thead>
			<tbody>
				${i.map((n)=>e`<tr>
						<td><b>${n[0]}</b></td>
						<td>${l(this.pills(n[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(a){return a.map((i)=>e`${i[0]} → ${i[1].length} tiers`)}pills(a){return a.map((i,n)=>e`<span class="pill">${n+1}. ${i}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",d);class p extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;if(!a.groups)return e`<h2>Upstream pool</h2>
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
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",p);class c extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="Registered services",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(a)}`}body(a){return e`<table class="ct">
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
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",c);class h extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(a)}`}body(a){if(a.error)return e`<div class="errbox">
				current file does not parse: ${a.error}
			</div>`;return e`<div class="knobs">
			${a.knobs.map((i)=>e`<span class="kchip">${i.k}: <b>${i.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",h);class u extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[o];constructor(){super();this.heading="admin audit",this.data=null}render(){let a=this.data;if(!a)return e`${t}`;if(!a.rows.length)return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no admin actions recorded yet — settings/policy applies and key
					revocations land here
				</p>`;return e`<h2>${this.heading}</h2>
			${a.rows.map((i)=>this.chip(i))}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`}chip(a){let i=a.target?` · ${a.target}`:"",n=a.detail?` · ${a.detail}`:"";return e`<div class="kchip block">
			<b>${a.action}</b> · ${a.actor} · <span class="mono">${a.when}</span
			>${i}${n}
		</div>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",u);
