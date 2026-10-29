import{n,e,t,r}from"./lit-801c06b16c5fa88d.js";var h=[["prompt.condense","condense"],["prompt.enhance","enhance (local LLM)"],["prompt.debug","debug preview"],["prompt.log","log all stages"]],p={"prompt.condense":!1,"prompt.enhance":!1,"prompt.debug":!1,"prompt.log":!1};class g extends r{static properties={settings:{state:!0},view:{state:!0},busy:{state:!0},err:{state:!0},sent:{state:!0}};static styles=n`
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
	`;project="";goal="";previewId=null;etag=null;constructor(){super();this.settings={...p},this.view=null,this.busy=!1,this.err=null,this.sent=!1}get gated(){return this.settings["prompt.debug"]||this.settings["prompt.log"]}ready(s){return!this.busy&&!this.sent&&this.goal===s&&!!this.project}connectedCallback(){super.connectedCallback(),this.loadSettings()}async loadSettings(){try{let i=await(await fetch("/api/prompt/settings")).json();if(i.settings)this.settings={...p,...i.settings};if(i.etag)this.etag=i.etag}catch{}}async toggle(s,i){let a=this.settings;this.settings={...a,[s]:i};try{let l=await fetch("/api/prompt/settings",{method:"POST",headers:{"content-type":"application/json",...this.etag===null?{}:{"if-match":this.etag}},body:JSON.stringify({[s]:i})}),d=await l.json();if(l.status===412){await this.loadSettings(),this.err="settings changed elsewhere — reloaded";return}if(!l.ok||!d.settings)throw Error(d.why??d.error??`HTTP ${l.status}`);if(this.settings={...p,...d.settings},d.etag)this.etag=d.etag}catch(l){this.settings=a,this.err=`settings not saved: ${l instanceof Error?l.message:String(l)}`}}async prepare(s,i,a){this.project=s,this.goal=i,this.previewId=null,this.view=null,this.err=null,this.sent=!1,this.busy=!0;try{let l=await fetch("/api/orchestrate/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(a?.length?{project:s,goal:i,attachments:a}:{project:s,goal:i}),signal:AbortSignal.timeout(30000)}),d=await l.json();if(!l.ok||!d.ok||!d.preview)throw Error(d.error??`HTTP ${l.status}`);this.view=d.preview,this.previewId=d.previewId??null}catch(l){this.err=`preview failed: ${l instanceof Error?l.message:String(l)}`}finally{this.busy=!1}}clear(){this.view=null,this.err=null,this.sent=!1,this.goal="",this.project="",this.previewId=null}dispatch(){if(this.busy||this.sent||!this.project)return;this.sent=!0,this.dispatchEvent(new CustomEvent("klh-dispatch",{bubbles:!0,composed:!0,detail:{project:this.project,goal:this.goal,previewId:this.previewId}}))}block(s,i){return e`<details ?open=${i}>
			<summary>${s.label} · ${s.bytes} B</summary>
			<pre>${s.text}</pre>
		</details>`}phaseRow(s){let i=s.bytes===null?"size unknown":`${s.bytes} B (~${s.tokens} tok)`,a=`${s.label} · ${s.source} · ${i} · cache ${s.cacheable} · ${s.state}`;return s.text!==null?e`<details>
					<summary>${a}</summary>
					<pre>${s.text}</pre>
				</details>`:e`<div class="ph">
					${a}${s.note?e` — <span class="dim">${s.note}</span>`:t}
				</div>`}summary(){let s=h.filter(([i])=>this.settings[i]).map(([,i])=>i);return`prompt transforms · ${s.length?s.join(", "):"all off"}`}body(){if(!this.busy&&!this.view&&!this.err)return t;let s=this.view;return e`<section class="pv" aria-live="polite" aria-label="dispatch preview">
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
							${s.stages.map((i)=>this.block(i,!1))}`:t}
			${s?.injected?.length?e`<div class="dim">injected context (appended to the prompt)</div>
							${s.injected.map((i)=>this.block(i,!1))}`:t}
			${s?.phases?.length?e`<div class="dim">pre-injection context phases</div>
							${s.phases.map((i)=>this.phaseRow(i))}`:t}
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
					${h.map(([s,i])=>e`<label>
							<input
								type="checkbox"
								.checked=${this.settings[s]}
								@change=${(a)=>this.toggle(s,a.target.checked)}
							/>
							${i}
						</label>`)}
				</div>
			</details>
			${this.body()}
		`}}customElements.define("klh-prompt-preview",g);class m extends r{static properties={view:{state:!0},err:{state:!0},note:{state:!0}};static styles=n`
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
	`;async refresh(){try{let s=await fetch("/api/posture"),i=await s.json().catch(()=>null);if(!s.ok)this.err=i?.error??`HTTP ${s.status}`;else this.view=i,this.err=null}catch(s){this.err=s instanceof Error?s.message:String(s)}}async save(s){if(!this.view?.configured||!s)return;let i=await fetch("/api/posture/selection",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({selection:s,revision:this.view.revision})}),a=await i.json().catch(()=>null);if(i.status===412){this.note="changed elsewhere — re-apply",await this.refresh();return}if(!i.ok){this.err=a?.error??`HTTP ${i.status}`;return}if(this.note=null,a?.revision&&this.view)this.view.revision=a.revision;await this.refresh()}connectedCallback(){super.connectedCallback(),this.refresh()}render(){let s=this.view;return e`<details>
			<summary>
				Posture
				<span class="dim"> base selection, effective overrides, holds</span>
			</summary>
			${s==null?e`<p class="dim">loading…</p>`:s.configured?this.renderConfigured(s):e`<p class="dim">${s.unconfiguredReason??"not migrated"}</p>`}
			${this.err===null?t:e`<p class="err">${this.err}</p>`}
			${this.note===null?t:e`<p class="dim">${this.note}</p>`}
		</details>`}renderConfigured(s){let i=s.selection;if(!i||!s.effective)return e`<p class="err">malformed view</p>`;return e`
			<div class="row">
				<label>
					base
					<select
						@change=${(a)=>{let l=a.target.value;this.save({...i,posture:l})}}
					>
						${(s.postures??[]).map((a)=>e`<option value=${a} ?selected=${a===i.posture}>
									${a}
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
						?checked=${i.developmentOverride}
						@change=${(a)=>{let l=a.target.checked;this.save({...i,developmentOverride:l})}}
					/>
					dev override
				</label>
			</div>
			${s.effective.overrides.length===0?t:e`<p class="dim">
						.prefer sources:
						${s.effective.overrides.map((a,l)=>e`${l>0?", ":t}<code>${a}</code>`)}
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
					${s.map((i)=>e`
							<tr>
								<td>${i.hub}</td>
								<td>${i.model}</td>
								<td>${i.policy}</td>
								<td>${i.lanes==="MAX"?"MAX":`${i.lanes}`}</td>
								<td>
									${`${i.occupancy}`}
									${i.held?e`<span class="badge held">held</span>`:t}
									${i.disabled?e`<span class="badge off">disabled</span>`:t}
								</td>
							</tr>
						`)}
				</tbody>
			</table>
		`}}customElements.define("klh-posture-panel",m);class v extends r{static properties={trace:{attribute:!1},events:{attribute:!1},execution:{attribute:!1},loading:{type:Boolean},error:{type:String}};static styles=n`
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
	`;constructor(){super();this.trace=[],this.events=[],this.execution=null,this.loading=!1,this.error=null}stamp(s){let i=new Date(s),a=(u)=>String(u).padStart(2,"0"),l=-i.getTimezoneOffset(),d=Math.abs(l),o=`${a(i.getUTCHours())}:${a(i.getUTCMinutes())}:${a(i.getUTCSeconds())}Z`,c=`${a(i.getHours())}:${a(i.getMinutes())} UTC${l>=0?"+":"-"}${a(Math.floor(d/60))}:${a(d%60)}`;return`${o} (${c})`}render(){let s=this.trace[0]?.traceId??"",i=this.execution,a=i?.hops??[],l=a.filter((o)=>o.status==="error").length,d=[...new Set(a.map((o)=>o.model).filter(Boolean))];return e`<h2>Work trace ${s?e`<code>${s.slice(0,12)}</code>`:""}</h2>
			<h3>Work graph</h3>
			${this.events.length?e`<ol>${this.events.map((o)=>e`<li>
				<time datetime=${new Date(o.ts).toISOString()}>${this.stamp(o.ts)}</time>
				<div><strong>${o.kind}</strong> · ${o.source}<span class="sub">${[o.note,o.sha?`commit ${o.sha.slice(0,12)}`:null].filter(Boolean).join(" · ")}</span></div>
			</li>`)}</ol>`:e`<p>No work graph events recorded for this item.</p>`}
			${this.trace.length?e`<h3>Plan and registration</h3>`:""}
			<ol>${this.trace.map((o)=>e`<li>
				<time datetime=${new Date(o.at).toISOString()}>${this.stamp(o.at)}</time>
				<div><strong class=${o.status==="error"?"error":""}>${o.phase}</strong> · ${o.service}
					<span class="sub">${[o.model,o.endpoint,o.ms==null?null:`${o.ms} ms`,o.inputTokens==null?null:`${o.inputTokens} in`,o.outputTokens==null?null:`${o.outputTokens} out`].filter(Boolean).join(" · ")}</span>
				</div>
			</li>`)}</ol>
			${!this.trace.length?e`<p>No orchestration trace recorded. Directly created work starts at the work graph.</p>`:""}
			${this.loading?e`<p>Checking lane requests across hubs…</p>`:""}
			${this.error?e`<p class="error">Request history unavailable: ${this.error}</p>`:""}
			${i?.lane?e`
				<h3>Execution · ${i.days}d window</h3>
				<p>Lane <code>${i.lane.sid}</code> · ${i.lane.executor} on ${i.lane.host} · ${i.lane.state} · attempt ${i.lane.attempt}</p>
					<p>Requests matched by lane ID. Each request shows its gateway trace ID when available.</p>
				${i.hubs.filter((o)=>!o.ok).map((o)=>e`<p class="error">${o.label}: ${o.reason??"unavailable"}</p>`)}
				<div class="counts"><span><strong>${a.length}</strong> requests</span><span><strong>${l}</strong> failed</span><span><strong>${d.length}</strong> models</span></div>
				${d.length?e`<p>Models: ${d.join(", ")}</p>`:""}
				${i.limited?e`<p>History limited to the latest 200 requests in this window.</p>`:""}
				${a.length?e`<details><summary>Request history · ${a.length} Buckle hops</summary><ol>${a.map((o)=>e`<li>
					<time datetime=${new Date(o.at).toISOString()}>${this.stamp(o.at)}</time>
					<div><strong class=${o.status==="error"?"error":""}>${o.hub} · ${o.hop}</strong> → ${o.model??"model unknown"}
						<span class="sub">${[o.endpoint,o.ms==null?null:`${o.ms} ms`,o.inputTokens==null?null:`${o.inputTokens} in`,o.outputTokens==null?null:`${o.outputTokens} out`,o.cacheReadTokens==null?null:`${o.cacheReadTokens} cache read`,o.status,o.traceId?`trace ${o.traceId}`:"trace unavailable (older request)",`request ${o.requestId.slice(0,12)}`].filter(Boolean).join(" · ")}</span>
					</div>
				</li>`)}</ol></details>`:e`<p>No Buckle requests for this lane in the selected window.</p>`}
			`:i&&!i.lane?e`<p>No dispatched lane recorded for this item.</p>`:""}`}}customElements.define("klh-task-trace",v);class b extends r{static properties={eventId:{type:Number,attribute:"event-id"},count:{state:!0},latest:{state:!0},busy:{state:!0},err:{state:!0}};static styles=n`
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
	`;constructor(){super();this.count=0,this.latest=null,this.busy=!1,this.err=null}connectedCallback(){super.connectedCallback(),this.hydrate()}async hydrate(){if(!this.eventId)return;try{let s=await fetch(`/api/decisions/${this.eventId}/evals`);if(!s.ok)return;let i=await s.json();if(this.apply(i.evals??[]),i.status?.running)this.waitForEval(i.status.startedAt).catch((a)=>{this.err=a instanceof Error?a.message:String(a)}).finally(()=>{this.busy=!1})}catch{}}apply(s,i){this.count=i??s.length,this.latest=s[s.length-1]??null,this.err=null}async evaluate(){if(this.busy||!this.eventId)return;this.busy=!0,this.err=null;try{let s=await fetch(`/api/decisions/${this.eventId}/evaluate`,{method:"POST"}),i=await s.json().catch(()=>null);if(!s.ok||!i?.ok)throw Error(i?.error??`Evaluation could not start (HTTP ${s.status})`);await this.waitForEval(i.startedAt??Date.now())}catch(s){this.err=s instanceof Error?s.message:String(s)}finally{this.busy=!1}}async waitForEval(s){this.busy=!0;let i=Date.now()+135000;while(this.isConnected&&Date.now()<i){let a=await fetch(`/api/decisions/${this.eventId}/evals`,{signal:AbortSignal.timeout(8000)});if(!a.ok)throw Error(`Evaluation status unavailable (HTTP ${a.status})`);let l=await a.json();if(this.apply(l.evals??[]),l.status?.error)throw Error(l.status.error);if(!l.status?.running){if(this.latest&&this.latest.ts>=s)return;throw Error("Evaluation stopped without a result — retry")}await new Promise((d)=>setTimeout(d,1500))}if(this.isConnected)throw Error("Evaluation is taking too long — retry")}when(s){let i=new Date(s),a=(u)=>String(u).padStart(2,"0"),l=-i.getTimezoneOffset(),d=Math.abs(l),o=`${a(i.getUTCHours())}:${a(i.getUTCMinutes())}:${a(i.getUTCSeconds())}Z`,c=`${a(i.getHours())}:${a(i.getMinutes())} UTC${l>=0?"+":"-"}${a(Math.floor(d/60))}:${a(d%60)}`;return`${o} (${c})`}render(){return e`
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
		`}}customElements.define("klh-decision-eval",b);function f(){let s=document.querySelectorAll(".dec[data-id]");for(let i of s){if(i.querySelector("klh-decision-eval"))continue;let a=i.querySelector(".dec-actions")??i,l=document.createElement("klh-decision-eval");l.setAttribute("event-id",i.getAttribute("data-id")??""),a.appendChild(l)}}var w=new MutationObserver(f);function y(){let s=document.querySelector("#decisions");if(!s){setTimeout(y,300);return}w.observe(s,{childList:!0,subtree:!0}),f()}y();
