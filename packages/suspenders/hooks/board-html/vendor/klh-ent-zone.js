import{r,e,s}from"./lit-c5g9ct2w.js";var u=["identity","federation","audit","usage","policy","vault","ma"];var a=(n,t)=>e`<span class="chip ${n}">${t}</span>`,o=(n)=>n===null||n===void 0?"—":new Date(n).toISOString().slice(5,16).replace("T"," "),c=(n)=>n>=1e6?`${(n/1e6).toFixed(1)}M`:n>=1000?`${(n/1000).toFixed(0)}k`:String(n);class i extends s{static properties={data:{state:!0}};static styles=r`
		:host {
			display: block;
			background: var(--klh-surface);
			border: 1px solid var(--klh-ent-edge, var(--klh-edge));
			border-radius: var(--klh-radius-lg);
			overflow: hidden;
		}
		header {
			display: flex;
			align-items: baseline;
			padding: var(--klh-space-4) var(--klh-space-5);
			background: var(--klh-ent-accent-bg, var(--klh-surface-hi));
			border-bottom: 1px solid var(--klh-ent-edge, var(--klh-edge));
		}
		header .glyph {
			color: var(--klh-ent-accent, var(--klh-accent));
			font-size: var(--klh-text-lg);
		}
		header h3 {
			margin: 0;
			font-size: var(--klh-text-xl);
			font-weight: 600;
			letter-spacing: 0.03em;
		}
		header .count {
			margin-left: auto;
			font-size: var(--klh-text-sm);
			color: var(--klh-dim);
		}
	`;spec={title:"panel",glyph:"▪"};constructor(){super();this.data=null}body(){return null}count(){return null}sliceOf(){if(this.data===null||this.data.ok===!1)return null;return this.data}render(){let n=this.data;return e`
			<header>
				<span class="glyph" aria-hidden="true">${this.spec.glyph}</span>
				<h3>${this.spec.title}</h3>
				<span class="count">${this.chipText()}</span>
			</header>
			<div class="body">
				${n===null?e`<div class="state">waiting for entitlements…</div>`:n.ok===!1?e`<div class="state bad">${n.why}</div>`:this.body()??e`<div class="state">no data yet</div>`}
			</div>
		`}chipText(){if(this.data===null)return"";if(this.data.ok===!1)return"unavailable";let n=this.count();return n===null?"":String(n)}}class h extends i{constructor(){super();this.spec={title:"Identity Governance",glyph:"◇"}}count(){return this.sliceOf().users.length}body(){let n=this.sliceOf();if(n===null)return null;return e`
			<table>
				<thead>
					<tr><th>user</th><th>roles</th><th>mfa</th><th>entitled</th></tr>
				</thead>
				<tbody>
					${n.users.map((t)=>{let l=t.mfa==="enforced"?"ok":t.mfa==="off"?"bad":"muted";return e`
							<tr>
								<td>
									${t.label}
									${a(t.kind==="contractor"?"ent":"muted",t.kind)}
								</td>
								<td>${t.roles.length===0?"—":t.roles.join(", ")}</td>
								<td>${a(l,t.mfa)}</td>
								<td>${a(t.entitled?"ok":"muted",t.entitled?"yes":"no")}</td>
							</tr>
						`})}
				</tbody>
			</table>
			${n.roles.length===0?"":e`<div class="state">
						roles:
						${n.roles.map((t)=>`${t.id}(${t.members})`).join(" · ")}
					</div>`}
		`}}if(!customElements.get("klh-ent-identity"))customElements.define("klh-ent-identity",h);class p extends i{constructor(){super();this.spec={title:"Federation Topology",glyph:"◈"}}count(){return this.sliceOf()?.peers.length??null}body(){let n=this.sliceOf();if(n===null)return null;return e`
			<table>
				<thead>
					<tr><th>spoke</th><th>state</th><th>region</th><th>seen</th></tr>
				</thead>
				<tbody>
					${n.peers.map((t)=>{let l=t.state==="enrolled"?"ok":t.state==="stale"?"bad":"muted";return e`
							<tr>
								<td>${t.spoke_id}</td>
								<td>${a(l,t.state)}</td>
								<td>${t.region??"—"}</td>
								<td>${o(t.last_seen)}</td>
							</tr>
						`})}
				</tbody>
			</table>
		`}}if(!customElements.get("klh-ent-federation"))customElements.define("klh-ent-federation",p);class m extends i{constructor(){super();this.spec={title:"Audit & Compliance",glyph:"≡"}}count(){return this.sliceOf()?.entries.length??null}body(){let n=this.sliceOf();if(n===null)return null;return e`
			<table>
				<thead>
					<tr><th>when</th><th>actor</th><th>action</th><th>outcome</th></tr>
				</thead>
				<tbody>
					${n.entries.map((t)=>{let l=t.outcome==="ok"?"ok":"bad";return e`
							<tr>
								<td>${o(t.ts)}</td>
								<td>${t.actor}</td>
								<td>${t.action} → ${t.target}</td>
								<td>${a(l,t.outcome)}</td>
							</tr>
						`})}
				</tbody>
			</table>
		`}}if(!customElements.get("klh-ent-audit"))customElements.define("klh-ent-audit",m);class y extends i{constructor(){super();this.spec={title:"Usage & Quotas",glyph:"▤"}}count(){return this.sliceOf()?.departments.length??null}body(){let n=this.sliceOf();if(n===null)return null;return e`
			<table>
				<thead>
					<tr><th>department</th><th>spend/cap</th><th>anomaly</th></tr>
				</thead>
				<tbody>
					${n.departments.map((t)=>{let l=t.cap_tok===null||t.cap_tok===0?null:Math.round(t.spend_tok/t.cap_tok*100);return e`
							<tr>
								<td>${t.label}</td>
								<td>
									${c(t.spend_tok)}
									${t.cap_tok===null?"":` / ${c(t.cap_tok)}`}
									${l===null?"":` (${l}%)`}
								</td>
								<td>${a(t.anomaly?"bad":"ok",t.anomaly?"flag":"clear")}</td>
							</tr>
						`})}
				</tbody>
			</table>
		`}}if(!customElements.get("klh-ent-usage"))customElements.define("klh-ent-usage",y);class g extends i{constructor(){super();this.spec={title:"Policy Manifest",glyph:"§"}}count(){return this.sliceOf()?.versions.length??null}body(){let n=this.sliceOf();if(n===null)return null;return e`
			<div class="state">
				CR queue: ${n.cr_queue} · overrides: ${n.overrides.length}
			</div>
			<table>
				<thead>
					<tr><th>version</th><th>rollout</th><th>signed</th><th>pinned</th></tr>
				</thead>
				<tbody>
					${n.versions.map((t)=>{let l=t.rollout==="active"?"ok":t.rollout==="canary"?"ent":"muted";return e`
							<tr>
								<td>${t.version}</td>
								<td>${a(l,t.rollout)}</td>
								<td>${a(t.signed?"ok":"bad",t.signed?"yes":"no")}</td>
								<td>${t.pinned_by===null?"—":String(t.pinned_by)}</td>
							</tr>
						`})}
				</tbody>
			</table>
		`}}if(!customElements.get("klh-ent-policy"))customElements.define("klh-ent-policy",g);class f extends i{constructor(){super();this.spec={title:"Secrets Vault",glyph:"⛨"}}count(){return this.sliceOf()?.secrets.length??null}body(){let n=this.sliceOf();if(n===null)return null;return e`
			<table>
				<thead>
					<tr><th>secret</th><th>age</th><th>next rotation</th><th>24h access</th></tr>
				</thead>
				<tbody>
					${n.secrets.map((t)=>{let l=t.age_days===null||t.age_days>90?"bad":"ok";return e`
							<tr>
								<td>${t.name}</td>
								<td>${a(l,t.age_days===null?"never":`${t.age_days}d`)}</td>
								<td>${o(t.next_rotation)}</td>
								<td>${String(t.accesses_24h)}</td>
							</tr>
						`})}
				</tbody>
			</table>
		`}}if(!customElements.get("klh-ent-vault"))customElements.define("klh-ent-vault",f);class k extends i{constructor(){super();this.spec={title:"M&A Operations",glyph:"⇄"}}count(){let n=this.sliceOf();if(n===null)return null;return n.transfers.length+n.revocations.length}body(){let n=this.sliceOf();if(n===null)return null;return e`
			<table>
				<thead>
					<tr><th>when</th><th>dept</th><th>spoke</th><th>outcome</th></tr>
				</thead>
				<tbody>
					${n.transfers.map((t)=>{let l=t.outcome==="done"?"ok":t.outcome==="pending"?"ent":"bad";return e`
							<tr>
								<td>${o(t.ts)}</td>
								<td>${t.dept}</td>
								<td>${t.spoke_id}</td>
								<td>${a(l,t.outcome)}</td>
							</tr>
						`})}
				</tbody>
			</table>
			${n.revocations.length===0?"":e`<div class="state">
						revoked:
						${n.revocations.map((t)=>`${t.id} (${t.dept})`).join(", ")}
					</div>`}
		`}}if(!customElements.get("klh-ent-ma"))customElements.define("klh-ent-ma",k);var E=u;class b extends s{static properties={active:{type:Boolean,reflect:!0},ent:{state:!0},slices:{state:!0},stamp:{state:!0}};static styles=r`
		:host {
			display: block;
		}
		:host(:not([active])) {
			display: none;
		}
		.zone {
			border: 1px solid var(--klh-ent-edge, var(--klh-edge));
			border-radius: var(--klh-radius-lg);
		}
		.zhead {
			display: flex;
			align-items: baseline;
			gap: var(--klh-space-4);
			padding: var(--klh-space-4) var(--klh-space-5);
			background: var(--klh-ent-accent-wash, transparent);
		}
		.badge {
			font-size: var(--klh-text-xs);
			font-weight: 700;
			letter-spacing: 0.12em;
			color: var(--klh-ent-accent, var(--klh-accent));
			border: 1px solid var(--klh-ent-edge, var(--klh-edge));
			border-radius: 8px;
			padding: 0 var(--klh-space-3);
		}
		.tenant,
		.stamp {
			font-size: var(--klh-text-xs);
			color: var(--klh-dim);
		}
		.stamp {
			margin-left: auto;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
			gap: var(--klh-space-4);
			padding: var(--klh-space-4);
		}
	`;#e=null;constructor(){super();this.active=!1,this.ent=null,this.slices=null,this.stamp=null}#t(){fetch("/api/enterprise").then((n)=>n.status===200?n.json():null).then((n)=>{if(n===null||n.ok!==!0)return;this.slices=n.panels,this.stamp=Date.now()}).catch(()=>{})}#n(n){if(n===null||n.ok!==!0)return;this.ent=n,this.active=!0,this.dispatchEvent(new CustomEvent("ent-entitled",{bubbles:!0,composed:!0})),this.#t(),this.#e=setInterval(()=>{this.#t()},60000)}#l(){fetch("/api/entitlements").then((n)=>n.status===200?n.json():null).then((n)=>this.#n(n)).catch(()=>{})}connectedCallback(){super.connectedCallback(),this.#l()}disconnectedCallback(){if(super.disconnectedCallback(),this.#e!==null)clearInterval(this.#e),this.#e=null}#r(n,t){let l=t??{ok:!1,why:"waiting for first refresh…"};switch(n){case"identity":return e`<klh-ent-identity .data=${l}></klh-ent-identity>`;case"federation":return e`<klh-ent-federation .data=${l}></klh-ent-federation>`;case"audit":return e`<klh-ent-audit .data=${l}></klh-ent-audit>`;case"usage":return e`<klh-ent-usage .data=${l}></klh-ent-usage>`;case"policy":return e`<klh-ent-policy .data=${l}></klh-ent-policy>`;case"vault":return e`<klh-ent-vault .data=${l}></klh-ent-vault>`;case"ma":return e`<klh-ent-ma .data=${l}></klh-ent-ma>`}}render(){if(!this.active)return e``;let n=new Set(this.ent?.panels??[]),t=E.filter((d)=>n.has(d)),l=this.ent?.tenant??"",v=this.stamp===null?"":o(this.stamp);return e`
			<div class="zone">
				<div class="zhead">
					<span class="badge">ENTERPRISE</span>
					<span class="tenant">${l}</span>
					<div class="stamp">${v}</div>
				</div>
			</div>
			<div class="grid">
				${t.map((d)=>this.#r(d,this.slices?.[d]))}
			</div>
		`}}if(!customElements.get("klh-ent-zone"))customElements.define("klh-ent-zone",b);export{b as KlhEntZone};
