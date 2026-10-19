import{r,e,t,s}from"./lit-9bpcreb0.js";var d=[["prompt.condense","condense"],["prompt.enhance","enhance (local LLM)"],["prompt.debug","debug preview"],["prompt.log","log all stages"]],c={"prompt.condense":!1,"prompt.enhance":!1,"prompt.debug":!1,"prompt.log":!1};class p extends s{static properties={settings:{state:!0},view:{state:!0},busy:{state:!0},err:{state:!0},sent:{state:!0}};static styles=r`
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
	`;project="";goal="";previewId=null;constructor(){super();this.settings={...c},this.view=null,this.busy=!1,this.err=null,this.sent=!1}get gated(){return this.settings["prompt.debug"]||this.settings["prompt.log"]}ready(i){return!this.busy&&!this.sent&&this.goal===i&&!!this.project}connectedCallback(){super.connectedCallback(),this.loadSettings()}async loadSettings(){try{let n=await(await fetch("/api/prompt/settings")).json();if(n.settings)this.settings={...c,...n.settings}}catch{}}async toggle(i,n){let o=this.settings;this.settings={...o,[i]:n};try{let a=await fetch("/api/prompt/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({[i]:n})}),l=await a.json();if(!a.ok||!l.settings)throw Error(l.error??`HTTP ${a.status}`);this.settings={...c,...l.settings}}catch(a){this.settings=o,this.err=`settings not saved: ${a instanceof Error?a.message:String(a)}`}}async prepare(i,n,o){this.project=i,this.goal=n,this.previewId=null,this.view=null,this.err=null,this.sent=!1,this.busy=!0;try{let a=await fetch("/api/orchestrate/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(o?.length?{project:i,goal:n,attachments:o}:{project:i,goal:n}),signal:AbortSignal.timeout(30000)}),l=await a.json();if(!a.ok||!l.ok||!l.preview)throw Error(l.error??`HTTP ${a.status}`);this.view=l.preview,this.previewId=l.previewId??null}catch(a){this.err=`preview failed: ${a instanceof Error?a.message:String(a)}`}finally{this.busy=!1}}clear(){this.view=null,this.err=null,this.sent=!1,this.goal="",this.project="",this.previewId=null}dispatch(){if(this.busy||this.sent||!this.project)return;this.sent=!0,this.dispatchEvent(new CustomEvent("klh-dispatch",{bubbles:!0,composed:!0,detail:{project:this.project,goal:this.goal,previewId:this.previewId}}))}block(i,n){return e`<details ?open=${n}>
			<summary>${i.label} · ${i.bytes} B</summary>
			<pre>${i.text}</pre>
		</details>`}summary(){let i=d.filter(([n])=>this.settings[n]).map(([,n])=>n);return`prompt transforms · ${i.length?i.join(", "):"all off"}`}body(){if(!this.busy&&!this.view&&!this.err)return t;let i=this.view;return e`<section class="pv" aria-live="polite" aria-label="dispatch preview">
			<div class="hd">
				<strong>${this.sent?"dispatched":"will dispatch"}</strong>
				${i?e`<span class="dim"
								>${i.finalBytes} B · condense ${i.ran.condense?"ran":"off"} ·
								enhance ${i.ran.enhance?"ran":"off"}${i.wireBytes?` · ${i.wireBytes} B on the wire`:""}</span
							>`:t}
			</div>
			${this.busy?e`<div class="dim">preparing preview…</div>`:t}
			${this.err?e`<div class="err">${this.err}</div>`:t}
			${i?.enhanceNote?e`<div class="dim">${i.enhanceNote}</div>`:t}
			${i?e`<pre aria-label="final prompt">${i.final}</pre>`:t}
			${i?.stages?.length?e`<div class="dim">stages</div>
							${i.stages.map((n)=>this.block(n,!1))}`:t}
			${i?.injected?.length?e`<div class="dim">injected context (appended to the prompt)</div>
							${i.injected.map((n)=>this.block(n,!1))}`:t}
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
					${d.map(([i,n])=>e`<label>
							<input
								type="checkbox"
								.checked=${this.settings[i]}
								@change=${(o)=>this.toggle(i,o.target.checked)}
							/>
							${n}
						</label>`)}
				</div>
			</details>
			${this.body()}
		`}}customElements.define("klh-prompt-preview",p);class u extends s{static properties={trace:{attribute:!1}};static styles=r`
		:host { display: block; border-top: 1px solid var(--klh-edge, #5d5a52); padding: 12px 0; }
		h2 { margin: 0 0 8px; font: 600 13px/1.3 ui-sans-serif, system-ui; color: var(--klh-ink, #e8e4da); }
		ol { margin: 0; padding: 0; list-style: none; }
		li { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 8px; padding: 5px 0; border-top: 1px solid var(--klh-edge, #5d5a52); font: 12px/1.45 ui-sans-serif, system-ui; }
		time, .sub, code { color: var(--klh-dim, #97917f); }
		strong { font-weight: 600; color: var(--klh-ink, #e8e4da); }
		.error { color: var(--klh-danger-ink, #e07a5f); }
		.sub { display: block; overflow-wrap: anywhere; }
		code { font: 11px ui-monospace, SFMono-Regular, monospace; }
	`;constructor(){super();this.trace=[]}render(){let i=this.trace[0]?.traceId??"";return e`<h2>Request trace <code>${i.slice(0,12)}</code></h2>
			<ol>${this.trace.map((n)=>e`<li>
				<time datetime=${new Date(n.at).toISOString()}>${new Date(n.at).toLocaleTimeString()}</time>
				<div><strong class=${n.status==="error"?"error":""}>${n.phase}</strong> · ${n.service}
					<span class="sub">${[n.model,n.endpoint,n.ms==null?null:`${n.ms} ms`,n.inputTokens==null?null:`${n.inputTokens} in`,n.outputTokens==null?null:`${n.outputTokens} out`].filter(Boolean).join(" · ")}</span>
				</div>
			</li>`)}</ol>`}}customElements.define("klh-task-trace",u);class h extends s{static properties={eventId:{type:Number,attribute:"event-id"},count:{state:!0},latest:{state:!0},busy:{state:!0},err:{state:!0}};static styles=r`
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
	`;constructor(){super();this.count=0,this.latest=null,this.busy=!1,this.err=null}connectedCallback(){super.connectedCallback(),this.hydrate()}async hydrate(){if(!this.eventId)return;try{let i=await fetch(`/api/decisions/${this.eventId}/evals`);if(!i.ok)return;let n=await i.json();this.apply(n.evals??[])}catch{}}apply(i,n){this.count=n??i.length,this.latest=i[i.length-1]??null,this.err=null}async evaluate(){if(this.busy||!this.eventId)return;this.busy=!0,this.err=null;try{let i=await fetch(`/api/decisions/${this.eventId}/evaluate`,{method:"POST"}),n=await i.json();if(!i.ok||!n.ok)throw Error(n.error??`HTTP ${i.status}`);if(n.latest)this.apply([n.latest],n.count)}catch(i){this.err=i instanceof Error?i.message:String(i)}finally{this.busy=!1}}when(i){return new Date(i).toLocaleTimeString()}render(){return e`
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
		`}}customElements.define("klh-decision-eval",h);function g(){let i=document.querySelectorAll(".dec[data-id]");for(let n of i){if(n.querySelector("klh-decision-eval"))continue;let o=n.querySelector(".dec-actions")??n,a=document.createElement("klh-decision-eval");a.setAttribute("event-id",n.getAttribute("data-id")??""),o.appendChild(a)}}var v=new MutationObserver(g);function m(){let i=document.querySelector("#decisions");if(!i){setTimeout(m,300);return}v.observe(i,{childList:!0,subtree:!0}),g()}m();
