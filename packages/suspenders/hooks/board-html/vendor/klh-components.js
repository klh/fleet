import{r,e,t,s}from"./lit-9bpcreb0.js";var d=[["prompt.condense","condense"],["prompt.enhance","enhance (local LLM)"],["prompt.debug","debug preview"],["prompt.log","log all stages"]],c={"prompt.condense":!1,"prompt.enhance":!1,"prompt.debug":!1,"prompt.log":!1};class u extends s{static properties={settings:{state:!0},view:{state:!0},busy:{state:!0},err:{state:!0},sent:{state:!0}};static styles=r`
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
	`;project="";goal="";previewId=null;constructor(){super();this.settings={...c},this.view=null,this.busy=!1,this.err=null,this.sent=!1}get gated(){return this.settings["prompt.debug"]||this.settings["prompt.log"]}ready(n){return!this.busy&&!this.sent&&this.goal===n&&!!this.project}connectedCallback(){super.connectedCallback(),this.loadSettings()}async loadSettings(){try{let a=await(await fetch("/api/prompt/settings")).json();if(a.settings)this.settings={...c,...a.settings}}catch{}}async toggle(n,a){let i=this.settings;this.settings={...i,[n]:a};try{let o=await fetch("/api/prompt/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({[n]:a})}),l=await o.json();if(!o.ok||!l.settings)throw Error(l.error??`HTTP ${o.status}`);this.settings={...c,...l.settings}}catch(o){this.settings=i,this.err=`settings not saved: ${o instanceof Error?o.message:String(o)}`}}async prepare(n,a,i){this.project=n,this.goal=a,this.previewId=null,this.view=null,this.err=null,this.sent=!1,this.busy=!0;try{let o=await fetch("/api/orchestrate/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(i?.length?{project:n,goal:a,attachments:i}:{project:n,goal:a}),signal:AbortSignal.timeout(30000)}),l=await o.json();if(!o.ok||!l.ok||!l.preview)throw Error(l.error??`HTTP ${o.status}`);this.view=l.preview,this.previewId=l.previewId??null}catch(o){this.err=`preview failed: ${o instanceof Error?o.message:String(o)}`}finally{this.busy=!1}}clear(){this.view=null,this.err=null,this.sent=!1,this.goal="",this.project="",this.previewId=null}dispatch(){if(this.busy||this.sent||!this.project)return;this.sent=!0,this.dispatchEvent(new CustomEvent("klh-dispatch",{bubbles:!0,composed:!0,detail:{project:this.project,goal:this.goal,previewId:this.previewId}}))}block(n,a){return e`<details ?open=${a}>
			<summary>${n.label} · ${n.bytes} B</summary>
			<pre>${n.text}</pre>
		</details>`}summary(){let n=d.filter(([a])=>this.settings[a]).map(([,a])=>a);return`prompt transforms · ${n.length?n.join(", "):"all off"}`}body(){if(!this.busy&&!this.view&&!this.err)return t;let n=this.view;return e`<section class="pv" aria-live="polite" aria-label="dispatch preview">
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
							${n.stages.map((a)=>this.block(a,!1))}`:t}
			${n?.injected?.length?e`<div class="dim">injected context (appended to the prompt)</div>
							${n.injected.map((a)=>this.block(a,!1))}`:t}
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
					${d.map(([n,a])=>e`<label>
							<input
								type="checkbox"
								.checked=${this.settings[n]}
								@change=${(i)=>this.toggle(n,i.target.checked)}
							/>
							${a}
						</label>`)}
				</div>
			</details>
			${this.body()}
		`}}customElements.define("klh-prompt-preview",u);class p extends s{static properties={trace:{attribute:!1},events:{attribute:!1},execution:{attribute:!1},loading:{type:Boolean},error:{type:String}};static styles=r`
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
		code { font: 11px ui-monospace, SFMono-Regular, monospace; }
	`;constructor(){super();this.trace=[],this.events=[],this.execution=null,this.loading=!1,this.error=null}render(){let n=this.trace[0]?.traceId??"",a=this.execution;return e`<h2>Work trace ${n?e`<code>${n.slice(0,12)}</code>`:""}</h2>
			<h3>Work graph</h3>
			${this.events.length?e`<ol>${this.events.map((i)=>e`<li>
				<time datetime=${new Date(i.ts).toISOString()}>${new Date(i.ts).toLocaleString()}</time>
				<div><strong>${i.kind}</strong> · ${i.source}<span class="sub">${[i.note,i.sha?`commit ${i.sha.slice(0,12)}`:null].filter(Boolean).join(" · ")}</span></div>
			</li>`)}</ol>`:e`<p>No work graph events recorded for this item.</p>`}
			${this.trace.length?e`<h3>Plan and registration</h3>`:""}
			<ol>${this.trace.map((i)=>e`<li>
				<time datetime=${new Date(i.at).toISOString()}>${new Date(i.at).toLocaleTimeString()}</time>
				<div><strong class=${i.status==="error"?"error":""}>${i.phase}</strong> · ${i.service}
					<span class="sub">${[i.model,i.endpoint,i.ms==null?null:`${i.ms} ms`,i.inputTokens==null?null:`${i.inputTokens} in`,i.outputTokens==null?null:`${i.outputTokens} out`].filter(Boolean).join(" · ")}</span>
				</div>
			</li>`)}</ol>
			${!this.trace.length?e`<p>No orchestration trace recorded. Directly created work starts at the work graph.</p>`:""}
			${this.loading?e`<p>Checking lane requests across hubs…</p>`:""}
			${this.error?e`<p class="error">Request history unavailable: ${this.error}</p>`:""}
			${a?.lane?e`
				<h3>Execution · ${a.days}d window</h3>
				<p>Lane <code>${a.lane.sid}</code> · ${a.lane.executor} on ${a.lane.host} · ${a.lane.state} · attempt ${a.lane.attempt}</p>
					<p>Requests matched by lane ID. Each request shows its gateway trace ID when available.</p>
				${a.hubs.filter((i)=>!i.ok).map((i)=>e`<p class="error">${i.label}: ${i.reason??"unavailable"}</p>`)}
				${a.limited?e`<p>Showing the latest 200 requests in this window.</p>`:""}
				${a.hops.length?e`<ol>${a.hops.map((i)=>e`<li>
					<time datetime=${new Date(i.at).toISOString()}>${new Date(i.at).toLocaleTimeString()}</time>
					<div><strong class=${i.status==="error"?"error":""}>${i.hub} · ${i.hop}</strong> → ${i.model??"model unknown"}
						<span class="sub">${[i.endpoint,i.ms==null?null:`${i.ms} ms`,i.inputTokens==null?null:`${i.inputTokens} in`,i.outputTokens==null?null:`${i.outputTokens} out`,i.cacheReadTokens==null?null:`${i.cacheReadTokens} cache read`,i.status,i.traceId?`trace ${i.traceId}`:"trace unavailable (older request)",`request ${i.requestId.slice(0,12)}`].filter(Boolean).join(" · ")}</span>
					</div>
				</li>`)}</ol>`:e`<p>No Buckle requests for this lane in the selected window.</p>`}
			`:a&&!a.lane?e`<p>No dispatched lane recorded for this item.</p>`:""}`}}customElements.define("klh-task-trace",p);class h extends s{static properties={eventId:{type:Number,attribute:"event-id"},count:{state:!0},latest:{state:!0},busy:{state:!0},err:{state:!0}};static styles=r`
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
	`;constructor(){super();this.count=0,this.latest=null,this.busy=!1,this.err=null}connectedCallback(){super.connectedCallback(),this.hydrate()}async hydrate(){if(!this.eventId)return;try{let n=await fetch(`/api/decisions/${this.eventId}/evals`);if(!n.ok)return;let a=await n.json();this.apply(a.evals??[])}catch{}}apply(n,a){this.count=a??n.length,this.latest=n[n.length-1]??null,this.err=null}async evaluate(){if(this.busy||!this.eventId)return;this.busy=!0,this.err=null;try{let n=await fetch(`/api/decisions/${this.eventId}/evaluate`,{method:"POST"}),a=await n.json();if(!n.ok||!a.ok)throw Error(a.error??`HTTP ${n.status}`);if(a.latest)this.apply([a.latest],a.count)}catch(n){this.err=n instanceof Error?n.message:String(n)}finally{this.busy=!1}}when(n){return new Date(n).toLocaleTimeString()}render(){return e`
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
		`}}customElements.define("klh-decision-eval",h);function g(){let n=document.querySelectorAll(".dec[data-id]");for(let a of n){if(a.querySelector("klh-decision-eval"))continue;let i=a.querySelector(".dec-actions")??a,o=document.createElement("klh-decision-eval");o.setAttribute("event-id",a.getAttribute("data-id")??""),i.appendChild(o)}}var b=new MutationObserver(g);function m(){let n=document.querySelector("#decisions");if(!n){setTimeout(m,300);return}b.observe(n,{childList:!0,subtree:!0}),g()}m();
