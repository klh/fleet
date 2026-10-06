import{r,e,t,s}from"./lit-ca3y6nz3.js";var p=[["prompt.condense","condense"],["prompt.enhance","enhance (local LLM)"],["prompt.debug","debug preview"],["prompt.log","log all stages"]],c={"prompt.condense":!1,"prompt.enhance":!1,"prompt.debug":!1,"prompt.log":!1};class d extends s{static properties={settings:{state:!0},view:{state:!0},busy:{state:!0},err:{state:!0},sent:{state:!0}};static styles=r`
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
	`;project="";goal="";previewId=null;constructor(){super();this.settings={...c},this.view=null,this.busy=!1,this.err=null,this.sent=!1}get gated(){return this.settings["prompt.debug"]||this.settings["prompt.log"]}ready(i){return!this.busy&&!this.sent&&this.goal===i&&!!this.project}connectedCallback(){super.connectedCallback(),this.loadSettings()}async loadSettings(){try{let a=await(await fetch("/api/prompt/settings")).json();if(a.settings)this.settings={...c,...a.settings}}catch{}}async toggle(i,a){let o=this.settings;this.settings={...o,[i]:a};try{let n=await fetch("/api/prompt/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({[i]:a})}),l=await n.json();if(!n.ok||!l.settings)throw Error(l.error??`HTTP ${n.status}`);this.settings={...c,...l.settings}}catch(n){this.settings=o,this.err=`settings not saved: ${n instanceof Error?n.message:String(n)}`}}async prepare(i,a){this.project=i,this.goal=a,this.previewId=null,this.view=null,this.err=null,this.sent=!1,this.busy=!0;try{let o=await fetch("/api/orchestrate/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({project:i,goal:a}),signal:AbortSignal.timeout(30000)}),n=await o.json();if(!o.ok||!n.ok||!n.preview)throw Error(n.error??`HTTP ${o.status}`);this.view=n.preview,this.previewId=n.previewId??null}catch(o){this.err=`preview failed: ${o instanceof Error?o.message:String(o)}`}finally{this.busy=!1}}clear(){this.view=null,this.err=null,this.sent=!1,this.goal="",this.project="",this.previewId=null}dispatch(){if(this.busy||this.sent||!this.project)return;this.sent=!0,this.dispatchEvent(new CustomEvent("klh-dispatch",{bubbles:!0,composed:!0,detail:{project:this.project,goal:this.goal,previewId:this.previewId}}))}block(i,a){return e`<details ?open=${a}>
			<summary>${i.label} · ${i.bytes} B</summary>
			<pre>${i.text}</pre>
		</details>`}summary(){let i=p.filter(([a])=>this.settings[a]).map(([,a])=>a);return`prompt transforms · ${i.length?i.join(", "):"all off"}`}body(){if(!this.busy&&!this.view&&!this.err)return t;let i=this.view;return e`<section class="pv" aria-live="polite" aria-label="dispatch preview">
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
							${i.stages.map((a)=>this.block(a,!1))}`:t}
			${i?.injected?.length?e`<div class="dim">injected context (appended to the prompt)</div>
							${i.injected.map((a)=>this.block(a,!1))}`:t}
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
					${p.map(([i,a])=>e`<label>
							<input
								type="checkbox"
								.checked=${this.settings[i]}
								@change=${(o)=>this.toggle(i,o.target.checked)}
							/>
							${a}
						</label>`)}
				</div>
			</details>
			${this.body()}
		`}}customElements.define("klh-prompt-preview",d);class u extends s{static properties={eventId:{type:Number,attribute:"event-id"},count:{state:!0},latest:{state:!0},busy:{state:!0},err:{state:!0}};static styles=r`
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
	`;constructor(){super();this.count=0,this.latest=null,this.busy=!1,this.err=null}connectedCallback(){super.connectedCallback(),this.hydrate()}async hydrate(){if(!this.eventId)return;try{let i=await fetch(`/api/decisions/${this.eventId}/evals`);if(!i.ok)return;let a=await i.json();this.apply(a.evals??[])}catch{}}apply(i,a){this.count=a??i.length,this.latest=i[i.length-1]??null,this.err=null}async evaluate(){if(this.busy||!this.eventId)return;this.busy=!0,this.err=null;try{let i=await fetch(`/api/decisions/${this.eventId}/evaluate`,{method:"POST"}),a=await i.json();if(!i.ok||!a.ok)throw Error(a.error??`HTTP ${i.status}`);if(a.latest)this.apply([a.latest],a.count)}catch(i){this.err=i instanceof Error?i.message:String(i)}finally{this.busy=!1}}when(i){return new Date(i).toLocaleTimeString()}render(){return e`
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
		`}}customElements.define("klh-decision-eval",u);function h(){let i=document.querySelectorAll(".dec[data-id]");for(let a of i){if(a.querySelector("klh-decision-eval"))continue;let o=a.querySelector(".dec-actions")??a,n=document.createElement("klh-decision-eval");n.setAttribute("event-id",a.getAttribute("data-id")??""),o.appendChild(n)}}var v=new MutationObserver(h);function g(){let i=document.querySelector("#decisions");if(!i){setTimeout(g,300);return}v.observe(i,{childList:!0,subtree:!0}),h()}g();
