import{r,e,t,s}from"./lit-17452e2304aadd9e.js";var h=[["prompt.condense","condense"],["prompt.enhance","enhance (local LLM)"],["prompt.debug","debug preview"],["prompt.log","log all stages"]],p={"prompt.condense":!1,"prompt.enhance":!1,"prompt.debug":!1,"prompt.log":!1};class g extends s{static properties={settings:{state:!0},view:{state:!0},busy:{state:!0},err:{state:!0},sent:{state:!0}};static styles=r`
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
	`;project="";goal="";previewId=null;etag=null;constructor(){super();this.settings={...p},this.view=null,this.busy=!1,this.err=null,this.sent=!1}get gated(){return this.settings["prompt.debug"]||this.settings["prompt.log"]}ready(n){return!this.busy&&!this.sent&&this.goal===n&&!!this.project}connectedCallback(){super.connectedCallback(),this.loadSettings()}async loadSettings(){try{let i=await(await fetch("/api/prompt/settings")).json();if(i.settings)this.settings={...p,...i.settings};if(i.etag)this.etag=i.etag}catch{}}async toggle(n,i){let o=this.settings;this.settings={...o,[n]:i};try{let l=await fetch("/api/prompt/settings",{method:"POST",headers:{"content-type":"application/json",...this.etag===null?{}:{"if-match":this.etag}},body:JSON.stringify({[n]:i})}),u=await l.json();if(l.status===412){await this.loadSettings(),this.err="settings changed elsewhere — reloaded";return}if(!l.ok||!u.settings)throw Error(u.why??u.error??`HTTP ${l.status}`);if(this.settings={...p,...u.settings},u.etag)this.etag=u.etag}catch(l){this.settings=o,this.err=`settings not saved: ${l instanceof Error?l.message:String(l)}`}}async prepare(n,i,o){this.project=n,this.goal=i,this.previewId=null,this.view=null,this.err=null,this.sent=!1,this.busy=!0;try{let l=await fetch("/api/orchestrate/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(o?.length?{project:n,goal:i,attachments:o}:{project:n,goal:i}),signal:AbortSignal.timeout(30000)}),u=await l.json();if(!l.ok||!u.ok||!u.preview)throw Error(u.error??`HTTP ${l.status}`);this.view=u.preview,this.previewId=u.previewId??null}catch(l){this.err=`preview failed: ${l instanceof Error?l.message:String(l)}`}finally{this.busy=!1}}clear(){this.view=null,this.err=null,this.sent=!1,this.goal="",this.project="",this.previewId=null}dispatch(){if(this.busy||this.sent||!this.project)return;this.sent=!0,this.dispatchEvent(new CustomEvent("klh-dispatch",{bubbles:!0,composed:!0,detail:{project:this.project,goal:this.goal,previewId:this.previewId}}))}block(n,i){return e`<details ?open=${i}>
			<summary>${n.label} · ${n.bytes} B</summary>
			<pre>${n.text}</pre>
		</details>`}phaseRow(n){let i=n.bytes===null?"size unknown":`${n.bytes} B (~${n.tokens} tok)`,o=`${n.label} · ${n.source} · ${i} · cache ${n.cacheable} · ${n.state}`;return n.text!==null?e`<details>
					<summary>${o}</summary>
					<pre>${n.text}</pre>
				</details>`:e`<div class="ph">
					${o}${n.note?e` — <span class="dim">${n.note}</span>`:t}
				</div>`}summary(){let n=h.filter(([i])=>this.settings[i]).map(([,i])=>i);return`prompt transforms · ${n.length?n.join(", "):"all off"}`}body(){if(!this.busy&&!this.view&&!this.err)return t;let n=this.view;return e`<section class="pv" aria-live="polite" aria-label="dispatch preview">
			<div class="hd">
				<strong>${this.sent?"dispatched":"will dispatch"}</strong>
				${n?e`<span class="dim"
								>${n.finalBytes} B · condense ${n.ran.condense?"ran":"off"} ·
								enhance ${n.ran.enhance?"ran":"off"}${n.wireBytes?` · ${n.wireBytes} B on the wire`:""}</span
							>`:t}
			</div>
			${this.busy?e`<div class="dim">preparing preview…</div>`:t}
			${this.err?e`<div class="err">${this.err}</div>`:t}
			${n?.enhanceNote?e`<div class="dim">${n.enhanceNote}</div>`:t}
			${n?e`<pre aria-label="final prompt">${n.final}</pre>`:t}
			${n?.stages?.length?e`<div class="dim">stages</div>
							${n.stages.map((i)=>this.block(i,!1))}`:t}
			${n?.injected?.length?e`<div class="dim">injected context (appended to the prompt)</div>
							${n.injected.map((i)=>this.block(i,!1))}`:t}
			${n?.phases?.length?e`<div class="dim">pre-injection context phases</div>
							${n.phases.map((i)=>this.phaseRow(i))}`:t}
			${n?.wireNote?e`<div class="dim note">${n.wireNote}</div>`:t}
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
					${h.map(([n,i])=>e`<label>
							<input
								type="checkbox"
								.checked=${this.settings[n]}
								@change=${(o)=>this.toggle(n,o.target.checked)}
							/>
							${i}
						</label>`)}
				</div>
			</details>
			${this.body()}
		`}}customElements.define("klh-prompt-preview",g);class m extends s{static properties={trace:{attribute:!1},events:{attribute:!1},execution:{attribute:!1},loading:{type:Boolean},error:{type:String}};static styles=r`
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
	`;constructor(){super();this.trace=[],this.events=[],this.execution=null,this.loading=!1,this.error=null}stamp(n){let i=new Date(n),o=(d)=>String(d).padStart(2,"0"),l=-i.getTimezoneOffset(),u=Math.abs(l),a=`${o(i.getUTCHours())}:${o(i.getUTCMinutes())}:${o(i.getUTCSeconds())}Z`,c=`${o(i.getHours())}:${o(i.getMinutes())} UTC${l>=0?"+":"-"}${o(Math.floor(u/60))}:${o(u%60)}`;return`${a} (${c})`}render(){let n=this.trace[0]?.traceId??"",i=this.execution,o=i?.hops??[],l=o.filter((a)=>a.status==="error").length,u=[...new Set(o.map((a)=>a.model).filter(Boolean))];return e`<h2>Work trace ${n?e`<code>${n.slice(0,12)}</code>`:""}</h2>
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
			${i?.lane?e`
				<h3>Execution · ${i.days}d window</h3>
				<p>Lane <code>${i.lane.sid}</code> · ${i.lane.executor} on ${i.lane.host} · ${i.lane.state} · attempt ${i.lane.attempt}</p>
					<p>Requests matched by lane ID. Each request shows its gateway trace ID when available.</p>
				${i.hubs.filter((a)=>!a.ok).map((a)=>e`<p class="error">${a.label}: ${a.reason??"unavailable"}</p>`)}
				<div class="counts"><span><strong>${o.length}</strong> requests</span><span><strong>${l}</strong> failed</span><span><strong>${u.length}</strong> models</span></div>
				${u.length?e`<p>Models: ${u.join(", ")}</p>`:""}
				${i.limited?e`<p>History limited to the latest 200 requests in this window.</p>`:""}
				${o.length?e`<details><summary>Request history · ${o.length} Buckle hops</summary><ol>${o.map((a)=>e`<li>
					<time datetime=${new Date(a.at).toISOString()}>${this.stamp(a.at)}</time>
					<div><strong class=${a.status==="error"?"error":""}>${a.hub} · ${a.hop}</strong> → ${a.model??"model unknown"}
						<span class="sub">${[a.endpoint,a.ms==null?null:`${a.ms} ms`,a.inputTokens==null?null:`${a.inputTokens} in`,a.outputTokens==null?null:`${a.outputTokens} out`,a.cacheReadTokens==null?null:`${a.cacheReadTokens} cache read`,a.status,a.traceId?`trace ${a.traceId}`:"trace unavailable (older request)",`request ${a.requestId.slice(0,12)}`].filter(Boolean).join(" · ")}</span>
					</div>
				</li>`)}</ol></details>`:e`<p>No Buckle requests for this lane in the selected window.</p>`}
			`:i&&!i.lane?e`<p>No dispatched lane recorded for this item.</p>`:""}`}}customElements.define("klh-task-trace",m);class b extends s{static properties={eventId:{type:Number,attribute:"event-id"},count:{state:!0},latest:{state:!0},busy:{state:!0},err:{state:!0}};static styles=r`
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
	`;constructor(){super();this.count=0,this.latest=null,this.busy=!1,this.err=null}connectedCallback(){super.connectedCallback(),this.hydrate()}async hydrate(){if(!this.eventId)return;try{let n=await fetch(`/api/decisions/${this.eventId}/evals`);if(!n.ok)return;let i=await n.json();if(this.apply(i.evals??[]),i.status?.running)this.waitForEval(i.status.startedAt).catch((o)=>{this.err=o instanceof Error?o.message:String(o)}).finally(()=>{this.busy=!1})}catch{}}apply(n,i){this.count=i??n.length,this.latest=n[n.length-1]??null,this.err=null}async evaluate(){if(this.busy||!this.eventId)return;this.busy=!0,this.err=null;try{let n=await fetch(`/api/decisions/${this.eventId}/evaluate`,{method:"POST"}),i=await n.json().catch(()=>null);if(!n.ok||!i?.ok)throw Error(i?.error??`Evaluation could not start (HTTP ${n.status})`);await this.waitForEval(i.startedAt??Date.now())}catch(n){this.err=n instanceof Error?n.message:String(n)}finally{this.busy=!1}}async waitForEval(n){this.busy=!0;let i=Date.now()+135000;while(this.isConnected&&Date.now()<i){let o=await fetch(`/api/decisions/${this.eventId}/evals`,{signal:AbortSignal.timeout(8000)});if(!o.ok)throw Error(`Evaluation status unavailable (HTTP ${o.status})`);let l=await o.json();if(this.apply(l.evals??[]),l.status?.error)throw Error(l.status.error);if(!l.status?.running){if(this.latest&&this.latest.ts>=n)return;throw Error("Evaluation stopped without a result — retry")}await new Promise((u)=>setTimeout(u,1500))}if(this.isConnected)throw Error("Evaluation is taking too long — retry")}when(n){let i=new Date(n),o=(d)=>String(d).padStart(2,"0"),l=-i.getTimezoneOffset(),u=Math.abs(l),a=`${o(i.getUTCHours())}:${o(i.getUTCMinutes())}:${o(i.getUTCSeconds())}Z`,c=`${o(i.getHours())}:${o(i.getMinutes())} UTC${l>=0?"+":"-"}${o(Math.floor(u/60))}:${o(u%60)}`;return`${a} (${c})`}render(){return e`
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
		`}}customElements.define("klh-decision-eval",b);function v(){let n=document.querySelectorAll(".dec[data-id]");for(let i of n){if(i.querySelector("klh-decision-eval"))continue;let o=i.querySelector(".dec-actions")??i,l=document.createElement("klh-decision-eval");l.setAttribute("event-id",i.getAttribute("data-id")??""),o.appendChild(l)}}var y=new MutationObserver(v);function f(){let n=document.querySelector("#decisions");if(!n){setTimeout(f,300);return}y.observe(n,{childList:!0,subtree:!0}),v()}f();
