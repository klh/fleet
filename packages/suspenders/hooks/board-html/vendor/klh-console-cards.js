import{e,t,s}from"./lit-sq0mv1by.js";import{a}from"./lit-aqxetgnz.js";var o=(r,i)=>r.flatMap((n,u)=>u?[e`${i}`,n]:[n]);class l extends s{static properties={heading:{type:String},compact:{type:Boolean},foot:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="",this.compact=!1,this.foot="",this.data=null}render(){let r=this.data;if(!r)return e`${t}`;if(r.kind==="missing")return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no routing-policy.yaml found on the belt chain (BELT_POLICY/
					BUCKLE_POLICY → ~/.claude/local-llm/ → committed default)
				</p>`;if(r.kind==="no-gateway")return e`<h2>${this.heading}</h2>
				<p class="dimpl">policy resolved but no gateway section parsed</p>`;if(r.kind==="error")return e`<h2>${this.heading}</h2>
				<div class="errbox">
					resolved ${r.path} does not parse: ${r.error}
				</div>`;let i=r.gateway;return e`<h2>${this.head(r.path,r.source)}</h2>
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
					`:t}${this.foot?e`<p class="cfoot">${this.foot}</p>`:t}`}head(r,i){let n=this.heading;if(r)n+=` · ${r}`;if(i)n+=` · source: ${i}`;return n}ladder(r){let i=Object.entries(r);if(this.compact&&i.length)return e`<span class="kchip">
				ladder: <b>${o(this.chips(i)," · ")}</b>
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
						<td>${o(this.pills(n[1])," → ")}</td>
					</tr>`)}
			</tbody>
		</table>`}chips(r){return r.map((i)=>e`${i[0]} → ${i[1].length} tiers`)}pills(r){return r.map((i,n)=>e`<span class="pill">${n+1}. ${i}</span>`)}}if(!customElements.get("klh-policy-card"))customElements.define("klh-policy-card",l);class d extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="Configured upstream pool",this.data=null}render(){let r=this.data;if(!r)return e`${t}`;if(!r.groups)return e`<h2>Upstream pool</h2>
				<p class="dimpl">
					upstreams.yaml unreadable — the ladder above still applies
				</p>`;return e`<h2>${this.heading} · ${r.source}</h2>${this.table(r.groups)}`}table(r){return e`<table class="ct">
			<thead>
				<tr>
					<th>group</th>
					<th>deployments</th>
					<th>state</th>
					<th>source</th>
				</tr>
			</thead>
			<tbody>
				${r.map((i)=>this.row(i))}
			</tbody>
		</table>
		<p class="cfoot">
			Deployment counts merge the fleet default with machine overrides.
			Reachability is shown by the endpoint checks above.
		</p>`}row(r){let i=r.dormant?e`<span class="dimpl">dormant</span>`:e`<span>configured</span>`;return e`<tr>
			<td><b>${r.name}</b></td>
			<td class="num">${r.tiers}</td>
			<td>${i}</td>
			<td>${r.source}</td>
		</tr>`}}if(!customElements.get("klh-upstreams-card"))customElements.define("klh-upstreams-card",d);class c extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="Registered services",this.data=null}render(){let r=this.data;if(!r)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(r)}`}body(r){return e`<table class="ct">
			<thead>
				<tr>
					<th>Service</th>
					<th>Scope</th>
					<th>Upstream</th>
					<th>Observation</th>
				</tr>
			</thead>
			<tbody>
				${r.rows.map((i)=>this.row(i))}
			</tbody>
		</table>
		<p class="cfoot">
			Route registration is configuration; local endpoint evidence is shown
			below. <a href="https://bar.local/">Inspect Caddy checks and mDNS
			claims</a>
		</p>`}row(r){return e`<tr>
			<td><a href="https://${r.name}.local/">${r.name}.local</a></td>
			<td><span class="pill">${r.scope}</span></td>
			<td class="mono">${r.upstream}</td>
			<td>${r.monitored}</td>
		</tr>`}}if(!customElements.get("klh-registry-card"))customElements.define("klh-registry-card",c);class p extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="suspenders-board.json",this.data=null}render(){let r=this.data;if(!r)return e`${t}`;return e`<h2>${this.heading}</h2>${this.body(r)}`}body(r){if(r.error)return e`<div class="errbox">
				current file does not parse: ${r.error}
			</div>`;return e`<div class="knobs">
			${r.knobs.map((i)=>e`<span class="kchip">${i.k}: <b>${i.v}</b></span>`)}
		</div>`}}if(!customElements.get("klh-knobs-card"))customElements.define("klh-knobs-card",p);class h extends s{static properties={heading:{type:String},data:{type:Object}};static styles=[a];constructor(){super();this.heading="admin audit",this.data=null}render(){let r=this.data;if(!r)return e`${t}`;if(!r.rows.length)return e`<h2>${this.heading}</h2>
				<p class="dimpl">
					no admin actions recorded yet — settings/policy applies and key
					revocations land here
				</p>`;return e`<h2>${this.heading}</h2>
			${r.rows.map((i)=>this.chip(i))}
			<p class="cfoot">
				settings applies, policy edits, key revocations — archived to NDJSON +
				aged out at 365d by coord gc
			</p>`}chip(r){let i=r.target?` · ${r.target}`:"",n=r.detail?` · ${r.detail}`:"";return e`<div class="kchip block">
			<b>${r.action}</b> · ${r.actor} · <span class="mono">${r.when}</span
			>${i}${n}
		</div>`}}if(!customElements.get("klh-audit-list"))customElements.define("klh-audit-list",h);
