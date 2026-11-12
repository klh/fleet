import{n,e,t,o}from"./lit-ac8284bbd881cce8.js";var h=[["prompt.condense","condense"],["prompt.enhance","enhance (local LLM)"],["prompt.debug","debug preview"],["prompt.log","log all stages"]],p={"prompt.condense":!1,"prompt.enhance":!1,"prompt.debug":!1,"prompt.log":!1};class g extends o{static properties={settings:{state:!0},view:{state:!0},busy:{state:!0},err:{state:!0},sent:{state:!0}};static styles=n`
		:host {
			display: block;
			margin: 4px 0;
			font: 12px/1.45 ui-sans-serif, system-ui;
			color: var(--klh-ink, #e8e4da);
		}
		summary {
			cursor: pointer;
			color: var(--klh-dim, #97917f);
		}
		.toggles {
			display: flex;
			flex-wrap: wrap;
			gap: 12px;
			padding: 4px 0;
		}
		.pv {
			margin-top: 6px;
			padding: 8px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-left: 3px solid var(--klh-accent, #d9a53a);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
		}
		.hd {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: baseline;
		}
		.dim {
			color: var(--klh-dim, #97917f);
		}
		.ph {
			padding: 2px 0;
		}
		pre {
			margin: 4px 0;
			padding: 6px 8px;
			white-space: pre-wrap;
			word-break: break-word;
			max-height: 16em;
			overflow: auto;
			font: 12px/1.4 ui-monospace, monospace;
			background: rgb(0 0 0 / 0.18);
			border-radius: 4px;
			user-select: text;
		}
		.err {
			color: #e07a5f;
		}
		.actions {
			display: flex;
			gap: 8px;
			margin-top: 6px;
		}
		button {
			font: inherit;
			cursor: pointer;
			padding: 3px 10px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
			color: var(--klh-ink, #e8e4da);
		}
		button.go {
			border-color: var(--klh-accent, #d9a53a);
			font-weight: 600;
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
	`;project="";goal="";previewId=null;etag=null;constructor(){super();this.settings={...p},this.view=null,this.busy=!1,this.err=null,this.sent=!1}get gated(){return this.settings["prompt.debug"]||this.settings["prompt.log"]}ready(s){return!this.busy&&!this.sent&&this.goal===s&&!!this.project}connectedCallback(){super.connectedCallback(),this.loadSettings()}async loadSettings(){try{let r=await(await fetch("/api/prompt/settings")).json();if(r.settings)this.settings={...p,...r.settings};if(r.etag)this.etag=r.etag}catch{}}async toggle(s,r){let i=this.settings;this.settings={...i,[s]:r};try{let l=await fetch("/api/prompt/settings",{method:"POST",headers:{"content-type":"application/json",...this.etag===null?{}:{"if-match":this.etag}},body:JSON.stringify({[s]:r})}),d=await l.json();if(l.status===412){await this.loadSettings(),this.err="settings changed elsewhere — reloaded";return}if(!l.ok||!d.settings)throw Error(d.why??d.error??`HTTP ${l.status}`);if(this.settings={...p,...d.settings},d.etag)this.etag=d.etag}catch(l){this.settings=i,this.err=`settings not saved: ${l instanceof Error?l.message:String(l)}`}}async prepare(s,r,i){this.project=s,this.goal=r,this.previewId=null,this.view=null,this.err=null,this.sent=!1,this.busy=!0;try{let l=await fetch("/api/orchestrate/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(i?.length?{project:s,goal:r,attachments:i}:{project:s,goal:r}),signal:AbortSignal.timeout(30000)}),d=await l.json();if(!l.ok||!d.ok||!d.preview)throw Error(d.error??`HTTP ${l.status}`);this.view=d.preview,this.previewId=d.previewId??null}catch(l){this.err=`preview failed: ${l instanceof Error?l.message:String(l)}`}finally{this.busy=!1}}clear(){this.view=null,this.err=null,this.sent=!1,this.goal="",this.project="",this.previewId=null}dispatch(){if(this.busy||this.sent||!this.project)return;this.sent=!0,this.dispatchEvent(new CustomEvent("klh-dispatch",{bubbles:!0,composed:!0,detail:{project:this.project,goal:this.goal,previewId:this.previewId}}))}block(s,r){return e`<details ?open=${r}>
			<summary>${s.label} · ${s.bytes} B</summary>
			<pre>${s.text}</pre>
		</details>`}phaseRow(s){let r=s.bytes===null?"size unknown":`${s.bytes} B (~${s.tokens} tok)`,i=`${s.label} · ${s.source} · ${r} · cache ${s.cacheable} · ${s.state}`;return s.text!==null?e`<details>
					<summary>${i}</summary>
					<pre>${s.text}</pre>
				</details>`:e`<div class="ph">
					${i}${s.note?e` — <span class="dim">${s.note}</span>`:t}
				</div>`}summary(){let s=h.filter(([r])=>this.settings[r]).map(([,r])=>r);return`prompt transforms · ${s.length?s.join(", "):"all off"}`}body(){if(!this.busy&&!this.view&&!this.err)return t;let s=this.view;return e`<section class="pv" aria-live="polite" aria-label="dispatch preview">
			<div class="hd">
				<strong>${this.sent?"dispatched":"will dispatch"}</strong>
				${s?e`<span class="dim"
								>${s.finalBytes} B · condense ${s.ran.condense?"ran":"off"} ·
								enhance ${s.ran.enhance?"ran":"off"}${s.wireBytes?` · ${s.wireBytes} B on the wire`:""}</span
							>`:t}
			</div>
			${this.busy?e`<div class="dim">preparing preview…</div>`:t}
			${this.err?e`<div class="err">${this.err}</div>`:t}
			${s?.enhanceNote?e`<div class="dim">${s.enhanceNote}</div>`:t}
			${s?e`<pre aria-label="final prompt">${s.final}</pre>`:t}
			${s?.stages?.length?e`<div class="dim">stages</div>
							${s.stages.map((r)=>this.block(r,!1))}`:t}
			${s?.injected?.length?e`<div class="dim">injected context (appended to the prompt)</div>
							${s.injected.map((r)=>this.block(r,!1))}`:t}
			${s?.phases?.length?e`<div class="dim">pre-injection context phases</div>
							${s.phases.map((r)=>this.phaseRow(r))}`:t}
			${s?.wireNote?e`<div class="dim note">${s.wireNote}</div>`:t}
			${this.sent||!this.project?t:e`<div class="actions">
							<button
								class="go"
								type="button"
								?disabled=${this.busy}
								@click=${this.dispatch}
							>
								dispatch anyway ⏎
							</button>
							<button type="button" @click=${this.clear}>cancel</button>
						</div>`}
		</section>`}render(){return e`
			<details>
				<summary>${this.summary()}</summary>
				<div class="toggles">
					${h.map(([s,r])=>e`<label>
							<input
								type="checkbox"
								.checked=${this.settings[s]}
								@change=${(i)=>this.toggle(s,i.target.checked)}
							/>
							${r}
						</label>`)}
				</div>
			</details>
			${this.body()}
		`}}customElements.define("klh-prompt-preview",g);class m extends o{static properties={view:{state:!0},err:{state:!0},note:{state:!0}};static styles=n`
		:host {
			display: block;
			margin: 4px 0;
			font: 12px/1.45 ui-sans-serif, system-ui;
			color: var(--klh-ink, #e8e4da);
		}
		summary {
			cursor: pointer;
			color: var(--klh-dim, #97917f);
		}
		.row {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			align-items: center;
			padding: 4px 0;
		}
		.dim {
			color: var(--klh-dim, #97917f);
		}
		.err {
			color: #e07a5f;
		}
		.badge {
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 4px;
			padding: 0 4px;
		}
		.badge.held {
			border-color: #d9a53a;
			color: #d9a53a;
		}
		.badge.off {
			border-color: #e07a5f;
			color: #e07a5f;
		}
		select,
		button {
			font: inherit;
			color: var(--klh-ink, #e8e4da);
			background: var(--klh-surface, #23211d);
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			padding: 2px 8px;
		}
	`;async refresh(){try{let s=await fetch("/api/posture"),r=await s.json().catch(()=>null);if(!s.ok)this.err=r?.error??`HTTP ${s.status}`;else this.view=r,this.err=null}catch(s){this.err=s instanceof Error?s.message:String(s)}}async save(s){if(!this.view?.configured||!s)return;let r=await fetch("/api/posture/selection",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({selection:s,revision:this.view.revision})}),i=await r.json().catch(()=>null);if(r.status===412){this.note="changed elsewhere — re-apply",await this.refresh();return}if(!r.ok){this.err=i?.error??`HTTP ${r.status}`;return}if(this.note=null,i?.revision&&this.view)this.view.revision=i.revision;await this.refresh()}connectedCallback(){super.connectedCallback(),this.refresh()}render(){let s=this.view;return e`<details>
			<summary>
				Posture
				<span class="dim"> base selection, effective overrides, holds</span>
			</summary>
			${s==null?e`<p class="dim">loading…</p>`:s.configured?this.renderConfigured(s):e`<p class="dim">${s.unconfiguredReason??"not migrated"}</p>`}
			${this.err===null?t:e`<p class="err">${this.err}</p>`}
			${this.note===null?t:e`<p class="dim">${this.note}</p>`}
		</details>`}renderConfigured(s){let r=s.selection;if(!r||!s.effective)return e`<p class="err">malformed view</p>`;return e`
			<div class="row">
				<label>
					base
					<select
						@change=${(i)=>{let l=i.target.value;this.save({...r,posture:l})}}
					>
						${(s.postures??[]).map((i)=>e`<option value=${i} ?selected=${i===r.posture}>
									${i}
								</option>`)}
					</select>
				</label>
				<span>
					effective <strong>${s.effective.posture}</strong>
					${s.effective.overridden?e`<span class="badge">override</span>`:t}
				</span>
				<label>
					<input
						type="checkbox"
						?checked=${r.developmentOverride}
						@change=${(i)=>{let l=i.target.checked;this.save({...r,developmentOverride:l})}}
					/>
					dev override
				</label>
			</div>
			${s.effective.overrides.length===0?t:e`<p class="dim">
						.prefer sources:
						${s.effective.overrides.map((i,l)=>e`${l>0?", ":t}<code>${i}</code>`)}
					</p>`}
			<details>
				<summary class="dim">
					entries (${s.effective.entries.length})
				</summary>
				${this.entriesTable(s.effective.entries)}
			</details>
		`}entriesTable(s){return e`
			<table>
				<thead>
					<tr>
						<th>hub</th>
						<th>model</th>
						<th>policy</th>
						<th>lanes</th>
						<th>active</th>
					</tr>
				</thead>
				<tbody>
					${s.map((r)=>e`
							<tr>
								<td>${r.hub}</td>
								<td>${r.model}</td>
								<td>${r.policy}</td>
								<td>${r.lanes==="MAX"?"MAX":`${r.lanes}`}</td>
								<td>
									${`${r.occupancy}`}
									${r.held?e`<span class="badge held">held</span>`:t}
									${r.disabled?e`<span class="badge off">disabled</span>`:t}
								</td>
							</tr>
						`)}
				</tbody>
			</table>
		`}}customElements.define("klh-posture-panel",m);class v extends o{static properties={trace:{attribute:!1},events:{attribute:!1},execution:{attribute:!1},loading:{type:Boolean},error:{type:String}};static styles=n`
		:host { display: block; border-top: 1px solid var(--klh-edge, #5d5a52); padding: 12px 0; }
		h2 { margin: 0 0 8px; font: 600 13px/1.3 ui-sans-serif, system-ui; color: var(--klh-ink, #e8e4da); }
		h3 { margin: 12px 0 5px; font: 600 12px/1.3 ui-sans-serif, system-ui; color: var(--klh-ink, #e8e4da); }
		p { margin: 4px 0; font: 12px/1.45 ui-sans-serif, system-ui; color: var(--klh-dim, #97917f); }
		ol { margin: 0; padding: 0; list-style: none; }
		li { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 8px; padding: 5px 0; border-top: 1px solid var(--klh-edge, #5d5a52); font: 12px/1.45 ui-sans-serif, system-ui; }
		time, .sub, code { color: var(--klh-dim, #97917f); }
		strong { font-weight: 600; color: var(--klh-ink, #e8e4da); }
		.error { color: var(--klh-danger-ink, #e07a5f); }
		.sub { display: block; overflow-wrap: anywhere; }
		details { margin: 10px 0; border: 1px solid var(--klh-edge, #5d5a52); padding: 8px 10px; }
		summary { cursor: pointer; font: 600 12px/1.4 ui-sans-serif, system-ui; }
		summary:focus-visible { outline: 2px solid var(--klh-accent, #b87b16); outline-offset: 2px; }
		.counts { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0; font: 12px/1.45 ui-sans-serif, system-ui; }
		.counts span { color: var(--klh-dim, #97917f); }
		code { font: 11px ui-monospace, SFMono-Regular, monospace; }
	`;constructor(){super();this.trace=[],this.events=[],this.execution=null,this.loading=!1,this.error=null}stamp(s){let r=new Date(s),i=(u)=>String(u).padStart(2,"0"),l=-r.getTimezoneOffset(),d=Math.abs(l),a=`${i(r.getUTCHours())}:${i(r.getUTCMinutes())}:${i(r.getUTCSeconds())}Z`,c=`${i(r.getHours())}:${i(r.getMinutes())} UTC${l>=0?"+":"-"}${i(Math.floor(d/60))}:${i(d%60)}`;return`${a} (${c})`}render(){let s=this.trace[0]?.traceId??"",r=this.execution,i=r?.hops??[],l=i.filter((a)=>a.status==="error").length,d=[...new Set(i.map((a)=>a.model).filter(Boolean))];return e`<h2>Work trace ${s?e`<code>${s.slice(0,12)}</code>`:""}</h2>
			<h3>Work graph</h3>
			${this.events.length?e`<ol>${this.events.map((a)=>e`<li>
				<time datetime=${new Date(a.ts).toISOString()}>${this.stamp(a.ts)}</time>
				<div><strong>${a.kind}</strong> · ${a.source}<span class="sub">${[a.note,a.sha?`commit ${a.sha.slice(0,12)}`:null].filter(Boolean).join(" · ")}</span></div>
			</li>`)}</ol>`:e`<p>No work graph events recorded for this item.</p>`}
			${this.trace.length?e`<h3>Plan and registration</h3>`:""}
			<ol>${this.trace.map((a)=>e`<li>
				<time datetime=${new Date(a.at).toISOString()}>${this.stamp(a.at)}</time>
				<div><strong class=${a.status==="error"?"error":""}>${a.phase}</strong> · ${a.service}
					<span class="sub">${[a.model,a.endpoint,a.ms==null?null:`${a.ms} ms`,a.inputTokens==null?null:`${a.inputTokens} in`,a.outputTokens==null?null:`${a.outputTokens} out`].filter(Boolean).join(" · ")}</span>
				</div>
			</li>`)}</ol>
			${!this.trace.length?e`<p>No orchestration trace recorded. Directly created work starts at the work graph.</p>`:""}
			${this.loading?e`<p>Checking lane requests across hubs…</p>`:""}
			${this.error?e`<p class="error">Request history unavailable: ${this.error}</p>`:""}
			${r?.lane?e`
				<h3>Execution · ${r.days}d window</h3>
				<p>Lane <code>${r.lane.sid}</code> · ${r.lane.executor} on ${r.lane.host} · ${r.lane.state} · attempt ${r.lane.attempt}</p>
					<p>Requests matched by lane ID. Each request shows its gateway trace ID when available.</p>
				${r.hubs.filter((a)=>!a.ok).map((a)=>e`<p class="error">${a.label}: ${a.reason??"unavailable"}</p>`)}
				<div class="counts"><span><strong>${i.length}</strong> requests</span><span><strong>${l}</strong> failed</span><span><strong>${d.length}</strong> models</span></div>
				${d.length?e`<p>Models: ${d.join(", ")}</p>`:""}
				${r.limited?e`<p>History limited to the latest 200 requests in this window.</p>`:""}
				${i.length?e`<details><summary>Request history · ${i.length} Buckle hops</summary><ol>${i.map((a)=>e`<li>
					<time datetime=${new Date(a.at).toISOString()}>${this.stamp(a.at)}</time>
					<div><strong class=${a.status==="error"?"error":""}>${a.hub} · ${a.hop}</strong> → ${a.model??"model unknown"}
						<span class="sub">${[a.endpoint,a.ms==null?null:`${a.ms} ms`,a.inputTokens==null?null:`${a.inputTokens} in`,a.outputTokens==null?null:`${a.outputTokens} out`,a.cacheReadTokens==null?null:`${a.cacheReadTokens} cache read`,a.status,a.traceId?`trace ${a.traceId}`:"trace unavailable (older request)",`request ${a.requestId.slice(0,12)}`].filter(Boolean).join(" · ")}</span>
					</div>
				</li>`)}</ol></details>`:e`<p>No Buckle requests for this lane in the selected window.</p>`}
			`:r&&!r.lane?e`<p>No dispatched lane recorded for this item.</p>`:""}`}}customElements.define("klh-task-trace",v);class b extends o{static properties={eventId:{type:Number,attribute:"event-id"},count:{state:!0},latest:{state:!0},busy:{state:!0},err:{state:!0}};static styles=n`
		:host {
			display: block;
			margin-top: 6px;
			font: 12px/1.45 ui-sans-serif, system-ui;
		}
		.row {
			display: flex;
			gap: 8px;
			align-items: center;
		}
		button {
			font: inherit;
			cursor: pointer;
			padding: 3px 10px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
			color: var(--klh-ink, #e8e4da);
		}
		button:hover {
			border-color: var(--klh-accent, #d9a53a);
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
		.cnt {
			color: var(--klh-dim, #97917f);
		}
		output {
			display: block;
			margin-top: 6px;
			white-space: pre-wrap;
			color: var(--klh-ink, #e8e4da);
			border-left: 2px solid var(--klh-accent, #d9a53a);
			padding-left: 8px;
		}
		output.err {
			color: var(--klh-danger-ink, #e07a5f);
			border-left-color: var(--klh-danger, #e07a5f);
		}
	`;constructor(){super();this.count=0,this.latest=null,this.busy=!1,this.err=null}connectedCallback(){super.connectedCallback(),this.hydrate()}async hydrate(){if(!this.eventId)return;try{let s=await fetch(`/api/decisions/${this.eventId}/evals`);if(!s.ok)return;let r=await s.json();if(this.apply(r.evals??[]),r.status?.running)this.waitForEval(r.status.startedAt).catch((i)=>{this.err=i instanceof Error?i.message:String(i)}).finally(()=>{this.busy=!1})}catch{}}apply(s,r){this.count=r??s.length,this.latest=s[s.length-1]??null,this.err=null}async evaluate(){if(this.busy||!this.eventId)return;this.busy=!0,this.err=null;try{let s=await fetch(`/api/decisions/${this.eventId}/evaluate`,{method:"POST"}),r=await s.json().catch(()=>null);if(!s.ok||!r?.ok)throw Error(r?.error??`Evaluation could not start (HTTP ${s.status})`);await this.waitForEval(r.startedAt??Date.now())}catch(s){this.err=s instanceof Error?s.message:String(s)}finally{this.busy=!1}}async waitForEval(s){this.busy=!0;let r=Date.now()+135000;while(this.isConnected&&Date.now()<r){let i=await fetch(`/api/decisions/${this.eventId}/evals`,{signal:AbortSignal.timeout(8000)});if(!i.ok)throw Error(`Evaluation status unavailable (HTTP ${i.status})`);let l=await i.json();if(this.apply(l.evals??[]),l.status?.error)throw Error(l.status.error);if(!l.status?.running){if(this.latest&&this.latest.ts>=s)return;throw Error("Evaluation stopped without a result — retry")}await new Promise((d)=>setTimeout(d,1500))}if(this.isConnected)throw Error("Evaluation is taking too long — retry")}when(s){let r=new Date(s),i=(u)=>String(u).padStart(2,"0"),l=-r.getTimezoneOffset(),d=Math.abs(l),a=`${i(r.getUTCHours())}:${i(r.getUTCMinutes())}:${i(r.getUTCSeconds())}Z`,c=`${i(r.getHours())}:${i(r.getMinutes())} UTC${l>=0?"+":"-"}${i(Math.floor(d/60))}:${i(d%60)}`;return`${a} (${c})`}render(){return e`
			<div class="row">
				<button
					?disabled=${this.busy}
					@click=${this.evaluate}
					type="button"
				>
					${this.busy?"evaluating…":"re-evaluate"}
				</button>
				<span class="cnt">
					${this.count}
					${this.count===1?"evaluation":"evaluations"}
				</span>
			</div>
			${this.err?e`<output class="err">${this.err}</output>`:""}
			${this.latest?e`<output>
						${this.when(this.latest.ts)} — ${this.latest.text}
					</output>`:""}
		`}}customElements.define("klh-decision-eval",b);function f(){let s=document.querySelectorAll(".dec[data-id]");for(let r of s){if(r.querySelector("klh-decision-eval"))continue;let i=r.querySelector(".dec-actions")??r.querySelector(".dbody")??r,l=document.createElement("klh-decision-eval");l.setAttribute("event-id",r.getAttribute("data-id")??""),i.appendChild(l)}}var w=new MutationObserver(f);function y(){let s=document.querySelector("#decisions");if(!s){setTimeout(y,300);return}w.observe(s,{childList:!0,subtree:!0}),f()}y();
