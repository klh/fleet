import{r,e,t,s}from"./lit-9bpcreb0.js";var u=["dim","ok","warn","bad","info","accent"],i=(a)=>{let o=String(a??"").toLowerCase();return u.includes(o)?o:"dim"};class c extends s{static properties={tone:{type:String,reflect:!0}};static styles=r`
		:host {
			display: inline-block;
			font: var(--klh-text-xs, 10px)/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.06em;
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
			border-radius: var(--klh-radius, 2px);
			padding: 0 6px;
			color: var(--klh-dim, #98958e);
			vertical-align: 1px;
			white-space: nowrap;
		}
		:host([tone="ok"]) {
			color: var(--klh-ok-ink, #7da652);
			border-color: var(--klh-ok, #5c7a35);
		}
		:host([tone="warn"]) {
			color: var(--klh-accent, #d8900f);
			border-color: var(--klh-accent, #d8900f);
		}
		:host([tone="bad"]) {
			color: var(--klh-danger-ink, #c96a4f);
			border-color: var(--klh-danger, #af2f12);
		}
		:host([tone="info"]) {
			color: var(--klh-info, #8cbbad);
			border-color: var(--klh-info, #8cbbad);
		}
		:host([tone="accent"]) {
			color: var(--klh-accent, #d8900f);
			border-color: var(--klh-accent, #d8900f);
		}
	`;constructor(){super();this.tone="dim"}render(){return e`<slot></slot>`}}customElements.define("klh-tag",c);var d=(a)=>a===null?"forever":new Date(a).toISOString().slice(0,16).replace("T"," "),m=(a)=>a===null?"—":a.replace("T"," ").slice(0,19);class h extends s{static properties={tokens:{state:!0},issued:{state:!0},pkeys:{state:!0},peers:{state:!0},fedme:{state:!0},fedidle:{state:!0},busy:{state:!0},err:{state:!0}};constructor(){super();this.tokens=null,this.issued=null,this.pkeys=null,this.peers=null,this.fedme=null,this.fedidle=!0,this.busy=!1,this.err=null}connectedCallback(){super.connectedCallback(),this.refresh()}async refresh(){this.busy=!0,this.err=null;try{let[a,o,n]=await Promise.all([fetch("/api/hub/tokens").then((l)=>l.json()),fetch("/api/hub/provider-keys").then((l)=>l.json()),fetch("/api/hub/federation").then((l)=>l.json())]);this.tokens=a.tokens??[],this.pkeys=o.home!==void 0?{home:o.home,files:o.files??[],keys:o.keys??[]}:null,this.peers=n.peers??null,this.fedme=n.me??null,this.fedidle=n.idle!==!1}catch(a){this.err=a instanceof Error?a.message:String(a)}finally{this.busy=!1}}async issue(a){let o=new FormData(a);this.busy=!0,this.err=null;try{let n=await fetch("/api/hub/tokens",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({actor:o.get("actor"),label:o.get("label"),team:o.get("team"),token_class:o.get("token_class"),scopes:String(o.get("scopes")??"").split(",").map((p)=>p.trim()).filter(Boolean),access_ttl_days:Number(o.get("access_ttl_days")??0)||null,refresh_ttl_days:Number(o.get("refresh_ttl_days")??0)||null})}),l=await n.json();if(!n.ok||!l.ok)throw Error(l.error??`HTTP ${String(n.status)}`);this.issued=l.token,a.reset(),await this.refresh()}catch(n){this.err=n instanceof Error?n.message:String(n)}finally{this.busy=!1}}async revoke(a){if(a.length===0)return;let o=`Revoke ALL token rows for actor "${a}"? The actor's access dies at once.`;if(!window.confirm(o))return;this.busy=!0,this.err=null;try{let n=await fetch("/api/hub/tokens/revoke",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({actor:a})}),l=await n.json();if(!n.ok||!l.ok)throw Error(l.error??`HTTP ${String(n.status)}`);await this.refresh()}catch(n){this.err=n instanceof Error?n.message:String(n)}finally{this.busy=!1}}static styles=[r`
		:host {
			display: block;
			max-width: 1000px;
			font: var(--klh-text-lg, 14px)/1.6 var(--klh-font-sans);
			color: var(--klh-ink, #e8e4da);
		}
		h2 {
			font: 600 11px/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
			margin: 18px 0 8px;
		}
		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		th,
		td {
			padding: 4px 8px;
			text-align: left;
			vertical-align: top;
		}
		th {
			font: 600 10px/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
			border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.12));
		}
		td {
			border-bottom: 1px solid var(--klh-edge-faint, rgba(255, 255, 255, 0.06));
		}
	`,r`
		.mono {
			font: 11px/1.5 var(--klh-font-mono);
		}
		.dim {
			color: var(--klh-dim, #98958e);
		}
		button {
			font: 600 11px/1.6 var(--klh-font-mono);
			padding: 3px 12px;
			cursor: pointer;
			border-radius: 2px;
			background: var(--klh-bg, #16150f);
			color: var(--klh-ink, #e8e4da);
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
		}
		button.danger {
			color: var(--klh-danger-ink, #c96a4f);
			border-color: var(--klh-danger, #af2f12);
		}
	`,r`
		button {
			font: 600 11px/1.6 var(--klh-font-mono);
			padding: 3px 12px;
			cursor: pointer;
			border-radius: 2px;
			background: var(--klh-bg, #16150f);
			color: var(--klh-ink, #e8e4da);
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
		}
		button.danger {
			color: var(--klh-danger-ink, #c96a4f);
			border-color: var(--klh-danger, #af2f12);
		}
		input,
		select {
			font: 12px var(--klh-font-mono);
			padding: 4px 8px;
			border-radius: 2px;
			background: var(--klh-bg, #16150f);
			color: var(--klh-ink, #e8e4da);
			border: 1px solid var(--klh-edge, #8a8577);
		}
		label.k {
			display: block;
			font: 600 10px/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--klh-dim, #98958e);
			margin: 8px 0 2px;
		}
		details {
			border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.1));
			border-radius: 3px;
			padding: 8px 12px;
			margin: 0 0 14px;
			background: var(--klh-surface, #23211d);
		}
		summary {
			cursor: pointer;
			font: 600 11px/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.06em;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
			gap: 0 16px;
		}
		.once {
			border: 1px solid var(--klh-accent, #d8900f);
			background: var(--klh-bg, #16150f);
			border-radius: 2px;
			padding: 8px 10px;
			margin: 8px 0;
		}
		.once code {
			font: 11px/1.5 var(--klh-font-mono);
			word-break: break-all;
		}
		.err {
			border: 1px solid var(--klh-danger, #af2f12);
			color: var(--klh-danger-ink, #c96a4f);
			border-radius: 2px;
			padding: 6px 10px;
			font-size: 12px;
			margin: 8px 0;
		}
		.foot,
		.dim,
		.mono {
			font-size: 11px;
			color: var(--klh-dim, #98958e);
		}
		.mono {
			font-family: var(--klh-font-mono);
		}
	`];render(){return e`
			<p class="dim intro">
				Tokens, provider keys and federation for this hub — enforcement rides
				the identity layer (scoped, expiring bearer tokens) and every GUI
				mutation lands in the audit trail.
			</p>
			${this.err===null?t:e`<div class="err" role="alert">${this.err}</div>`}
			${this.renderTokens()} ${this.renderKeys()} ${this.renderFederation()}
		`}renderTokens(){let a=this.tokens??[];return e`
			<details>
				<summary>Issue a token</summary>
				<form @submit=${this.onIssue}>
					<div class="grid">
						<div>
							<label class="k" for="ha-actor">actor (user or machine)</label>
							<input id="ha-actor" name="actor" required maxlength="120" />
						</div>
						<div>
							<label class="k" for="ha-class">class</label>
							<select id="ha-class" name="token_class">
								<option value="app-role">app-role (machine)</option>
								<option value="delegated">delegated (user)</option>
							</select>
						</div>
						<div>
							<label class="k" for="ha-team">team (optional)</label>
							<input id="ha-team" name="team" maxlength="120" />
						</div>
						<div>
							<label class="k" for="ha-label">label (optional)</label>
							<input id="ha-label" name="label" maxlength="120" />
						</div>
						<div>
							<label class="k" for="ha-scopes">scopes (comma-separated)</label>
							<input id="ha-scopes" name="scopes" value="buckle:admin" />
						</div>
						<div>
							<label class="k" for="ha-at">access ttl days (empty = forever)</label>
							<input id="ha-at" name="access_ttl_days" inputmode="numeric" />
						</div>
						<div>
							<label class="k" for="ha-rt">refresh ttl days (empty = forever)</label>
							<input id="ha-rt" name="refresh_ttl_days" inputmode="numeric" />
						</div>
					</div>
					<p><button type="submit" ?disabled=${this.busy}>Issue token</button></p>
				</form>
			</details>
			${this.issued===null?t:this.renderIssued()}
			<h2>Tokens</h2>
			<table>
				<thead>
					<tr>
						<th>token</th>
						<th>actor</th>
						<th>class</th>
						<th>team</th>
						<th>scopes</th>
						<th>expires</th>
						<th>state</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					${a.length===0?e`<tr><td colspan="8" class="dim">no tokens yet</td></tr>`:a.map((o)=>this.tokenRow(o))}
				</tbody>
			</table>
			<p class="foot">
				Listing is masked (8-char id, no material). Every issue/revoke lands
				in the console audit trail (governor.db).
			</p>
		`}tokenRow(a){let o=a.state==="active";return e`
			<tr>
				<td class="mono">${a.key_id}</td>
				<td>${a.actor??"—"}</td>
				<td>${a.class==="delegated"?"user":"machine"}</td>
				<td>${a.team??"—"}</td>
				<td class="mono">${a.scopes.join(", ")}</td>
				<td class="mono">${d(a.expires_at)}</td>
				<td>
					<klh-tag
						tone=${i(o?"ok":a.state==="revoked"?"bad":"dim")}
						>${a.state}</klh-tag
					>
				</td>
				<td>
					${o?e`<button
								class="danger"
								@click=${()=>this.revoke(a.actor??"")}
							>revoke actor</button>`:t}
				</td>
			</tr>
		`}renderIssued(){let a=this.issued;if(a===null)return t;return e`
			<div class="once" role="status">
				<p><strong>Token minted — shown once, copy now.</strong></p>
				<p class="mono">access: <code>${a.access}</code></p>
				<p class="mono">refresh: <code>${a.refresh}</code></p>
				<p class="foot">
					jti ${a.jti} · access ${d(a.expires_at)} · refresh
					${d(a.refresh_expires_at)}
				</p>
			</div>
		`}renderKeys(){let a=this.pkeys;return e`
			<h2>Provider keys (masked)</h2>
			${a===null?e`<p class="dim">loading…</p>`:e`
						<table>
							<thead>
								<tr><th>env name</th><th>source</th><th>value</th></tr>
							</thead>
							<tbody>
								${a.keys.length===0?e`<tr><td colspan="3" class="dim">no provider keys found</td></tr>`:a.keys.map((o)=>e`<tr>
												<td class="mono">${o.name}</td>
												<td>${o.source}</td>
												<td class="mono">${o.masked??"—"}</td>
											</tr>`)}
							</tbody>
						</table>
						<p class="foot">sources: ${a.home} · ${a.files.join(", ")}</p>
					`}
		`}renderFederation(){let a=this.peers??[];return e`
			<h2>Federation</h2>
			${this.fedidle?e`<p class="dim">
						no peer edges declared (HUB_PEERS / stack.yaml hubs.&lt;me&gt;.peers)
						— idle
					</p>`:e`
						<table>
							<thead>
								<tr>
									<th>peer</th><th>state</th><th>policy version</th>
									<th>last pull</th><th>via</th>
								</tr>
							</thead>
							<tbody>
								${a.map((o)=>e`<tr>
										<td>${o.label}</td>
										<td>
											<klh-tag
												tone=${i(o.state==="live"?"ok":o.state==="stale"?"warn":"bad")}
												>${o.state}</klh-tag
											>
										</td>
										<td class="mono">${o.version??"—"}</td>
										<td class="mono">${m(o.pulled_at)}</td>
										<td class="dim mono">${o.via??"—"}</td>
									</tr>`)}
							</tbody>
						</table>
					`}
			<p class="foot">
				Peer edges propagate the hub policy manifest peer-to-peer; last-known
				stays in force when a peer degrades.
			</p>
		`}onIssue(a){a.preventDefault(),this.issue(a.target)}}customElements.define("klh-hub-admin",h);
