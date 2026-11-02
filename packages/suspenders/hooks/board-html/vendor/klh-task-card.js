import{n,e,t,r}from"./lit-96e87015cf7d620b.js";import{f,S,d,s,u,y,l,i,z,o,E}from"./lit-5ab415d586a6f867.js";class k extends d{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(a,c,m,x){super(k.eventName);this.action=a,this.id=c,this.project=m,this.executor=x?.executor,this.effort=x?.effort}}class b extends d{static eventName="task-card-open-requested";id;project;constructor(a,c){super(b.eventName);this.id=a,this.project=c}}function C(a){if(a==="CLAIMED"||a==="RUNNING")return"working";if(a==="WAITING"||a==="BLOCKED"||a==="PAUSED")return"blocked";if(a==="SHATTERED")return"split";if(a==="FAILED")return"failed";if(a==="DONE")return"done";if(a==="CANCELLED")return"cancelled";return"ready"}var h=o(E(s())),g=o(E(u())),q=i({value:s(),label:s(),badge:o(s()),reasoningEffort:o(y())}),K=i({tokens:g,wallMs:g,tokPerMin:g,cachePct:g}),D=i({mode:z(["spend","attempt"]),windowStartMs:g,windowEndMs:g,binMs:g,elapsedMs:g,scaleMs:g}),F=i({id:s(),project:h,title:h,state:s(),ageS:g,context:h,parentRef:h,model:h,host:h,warn:h,metrics:o(K),activity:o(D),nested:o(y()),preferColor:h,executors:o(l(q)),executorPick:h,effortOptions:o(l(s())),effortPick:h});function R(a){if(a==null)return"—";if(a>=1e6)return`${(a/1e6).toFixed(1)}M`;if(a>=1000)return`${Math.round(a/1000)}k`;return String(Math.round(a))}function A(a){if(a==null)return"—";if(a<60000)return`${Math.max(1,Math.round(a/1000))}s`;let c=Math.round(a/60000);if(c>=60)return`${Math.floor(c/60)}h${String(c%60).padStart(2,"0")}m`;return`${c}m`}function P(a){if(a==null)return"—";if(a>=1e6)return`${(a/1e6).toFixed(1)}M`;if(a>=1000)return`${(a/1000).toFixed(1)}k`;return String(Math.round(a))}function L(a){if(a==null)return"—";return`${Math.round(a)}%`}var w="—";class O extends r{static properties={card:{attribute:!1}};static styles=n`
		:host {
			// the host IS the card surface: configurable semantic perimeter
			// (—prefer) independent of --state-color; nested children dashed.
			display: block;
			border: 1px solid
				var(--prefer, var(--state-color, var(--klh-edge-soft)));
			border-radius: 3px;
			background: var(--klh-wash);
			font: 12px/1.45 var(--klh-font-sans);
			color: var(--klh-ink);
			min-width: 0;
		}
		:host([data-nested]) {
			border-style: dashed;
		}
		:host([data-nested]) .elbow {
			position: absolute;
			left: -13px;
			top: 13px;
			color: var(--prefer, var(--klh-edge-strong));
			font: 11px var(--klh-font-mono);
		}
		.wrap {
			position: relative;
			display: flex;
			flex-direction: column;
			min-height: 100%;
			padding: 9px 12px 0;
		}
		.head {
			display: flex;
			align-items: baseline;
			gap: 6px;
			font-size: 10px;
			letter-spacing: 0.05em;
			text-transform: uppercase;
			color: var(--state-color, var(--klh-dim));
		}
		.sq {
			flex: none;
			width: 7px;
			height: 7px;
			border-radius: 1px;
			background: var(--state-color, var(--klh-dim));
			align-self: center;
		}
		.stw {
			font-weight: 600;
		}
		.age {
			margin-left: auto;
			color: var(--klh-dim);
			text-transform: none;
			letter-spacing: 0;
			font-variant-numeric: tabular-nums;
			white-space: nowrap;
		}
		.tid {
			margin: 4px 0 0;
			padding: 0;
			border: 0;
			background: none;
			color: var(--klh-ink);
			font: 600 15px var(--klh-font-mono);
			text-align: left;
			cursor: pointer;
			overflow-wrap: anywhere;
		}
		.tid:hover {
			text-decoration: underline;
		}
		.title {
			margin: 2px 0 0;
			font-weight: 650;
			font-size: 13px;
			line-height: 1.35;
			// long text truncates visually, full text stays accessible on hover
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 3;
			overflow: hidden;
		}
		.ctx {
			margin: 3px 0 0;
			color: var(--klh-dim);
			font: 10.5px var(--klh-font-mono);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.rule {
			border: 0;
			border-top: 1px solid var(--klh-edge-faint);
			margin: 7px 0 0;
		}
		.cols {
			display: flex;
			gap: 0;
			margin-top: 5px;
			font: 11px var(--klh-font-mono);
		}
		.col {
			flex: 1 1 0;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			padding: 0 10px;
		}
		.col:first-child {
			padding-left: 0;
		}
		.col:last-child {
			border-left: 1px solid var(--klh-edge-faint);
		}
		.col b {
			font-weight: 600;
			color: var(--klh-ink-2);
		}
		.lab {
			display: block;
			margin-top: 2px;
			font-size: 8.5px;
			letter-spacing: 0.07em;
			text-transform: uppercase;
			color: var(--klh-dim);
		}
		.warn {
			margin: 7px 0 0;
			border-left: 2px solid var(--work-failed, var(--klh-danger));
			background: var(--klh-danger-wash);
			padding: 4px 8px;
			font-size: 10.5px;
			color: var(--klh-danger-ink);
		}
		.warn .wl {
			font-weight: 700;
			text-transform: uppercase;
			font-size: 9px;
			letter-spacing: 0.06em;
			margin-right: 5px;
		}
		.warn .wt {
			display: block;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.metrics {
			display: flex;
			margin-top: 8px;
		}
		.m {
			flex: 1 1 0;
			min-width: 0;
			padding: 0 10px;
			text-align: right;
		}
		.m:first-child {
			padding-left: 0;
			text-align: left;
		}
		.m + .m {
			border-left: 1px solid var(--klh-edge-faint);
		}
		.mv {
			font: 600 13px var(--klh-font-mono);
			font-variant-numeric: tabular-nums;
			color: var(--klh-ink);
		}
		.ml {
			display: block;
			margin-top: 1px;
			font-size: 8.5px;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--klh-dim);
			white-space: nowrap;
		}
		.details {
			display: block;
			margin-top: 6px;
			font-size: 10.5px;
			color: var(--klh-dim);
		}
		// the activity slot sits flush at the card bottom: the strip's own
		// 1px duration rail + ~13px axis area ride the slot, no extra padding.
		.activity {
			display: block;
			margin-top: 8px;
			padding: 0;
		}
		footer {
			// neutral segmented rail, full-width flush bottom
			display: flex;
			align-items: stretch;
			margin: 8px -12px 0;
			border-top: 1px solid var(--klh-edge-faint);
			background: var(--klh-surface);
			border-radius: 0 0 2px 2px;
		}
		footer:empty {
			display: none;
		}
		.seg {
			flex: 1 1 0;
			min-height: 32px;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 5px;
			padding: 4px 8px;
			border: 0;
			background: none;
			color: var(--klh-ink-2);
			font: 11px var(--klh-font-sans);
			cursor: pointer;
			white-space: nowrap;
		}
		.seg + .seg {
			border-left: 1px solid var(--klh-edge-faint);
		}
		.seg:hover {
			background: var(--klh-surface-hi);
			color: var(--klh-ink);
		}
		.seg.retry {
			color: var(--klh-danger-ink);
		}
		.seg.recover {
			font-weight: 600;
		}
		.seg.prompt {
			color: var(--klh-accent);
		}
		.seg select {
			flex: 1 1 0;
			min-width: 0;
			height: 32px;
			background: var(--klh-field);
			color: var(--klh-ink);
			border: 1px solid var(--klh-edge-mid);
			border-radius: 2px;
			font: 10.5px var(--klh-font-mono);
			padding: 0 4px;
		}
		footer button.seg:focus-visible,
		.tid:focus-visible,
		.seg select:focus-visible {
			outline: 2px solid var(--klh-accent);
			outline-offset: -2px;
		}
	`;constructor(){super();this.card={id:"",state:"READY"}}tone(){return C(this.card.state)}open(){this.dispatchEvent(new b(this.card.id,this.card.project??null))}act(a,c){this.dispatchEvent(new k(a,this.card.id,this.card.project??null,c))}statusWord(){return this.card.state.toLowerCase()}render(){let a=this.card,c=this.tone(),m=a.metrics??null,x=a.ageS==null?w:S(a.ageS),N=a.ageS==null?"age unknown":`open ${f(a.ageS)}`,v=a.executors??[],M=a.executorPick??"",T=a.effortOptions??[],j=a.effortPick??"";return e`
			<span class="elbow" aria-hidden="true">↳</span>
			<div class="wrap">
				<div class="head">
					<span class="sq" data-tone=${c}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${N}>${x}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${a.id}
				</button>
				${a.title?e`<div class="title" title=${a.title}>${a.title}</div>`:t}
				${a.context?e`<div class="ctx" title=${a.context}>${a.context}</div>`:t}
				${a.parentRef?e`<div class="ctx" title=${`split under ${a.parentRef}`}
							>↳ ${a.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${a.model??""}>${a.model??w}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${a.host??""}>${a.host??w}</b>
					</div>
				</div>
				${a.warn?e`<div class="warn" role="note">
							<span class="wl">${c==="failed"?"blocked":"warning"}</span>
							<span class="wt" title=${a.warn}>${a.warn}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${R(m?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${A(m?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${P(m?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${L(m?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details" name="details"></slot>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${c==="failed"?e`<button
							class="seg retry"
							type="button"
							@click=${()=>this.act("retry")}
						>
							Retry
						</button>
						<button
							class="seg recover"
							type="button"
							@click=${()=>this.act("recover")}
						>
							Recover → Ready
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${()=>this.act("prompt")}
						>
							Prompt ↗
						</button>`:t}
				${c==="ready"&&v.length?e`<select
							class="seg"
							aria-label=${`executor for ${a.id}`}
							@change=${(p)=>{this.act("start",{executor:p.target.value,effort:this.effortValue()})}}
						>
							${v.map((p)=>e`<option value=${p.value} ?selected=${p.value===M}>
									${p.badge??""}${p.label}
								</option>`)}
						</select>
						${T.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${a.id}`}
									@change=${(p)=>{this.act("start",{executor:this.executorValue(),effort:p.target.value})}}
								>
									${T.map((p)=>e`<option value=${p} ?selected=${p===j}>
											${p}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							@click=${()=>this.act("start",{executor:this.executorValue(),effort:this.effortValue()})}
						>
							Start ▶
						</button>`:t}
				${c==="working"&&v.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${a.id}`}
							@change=${(p)=>{this.act("reassign",{executor:p.target.value})}}
						>
							${v.map((p)=>e`<option value=${p.value} ?selected=${p.value===M}>
									${p.badge??""}${p.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							@click=${()=>this.act("reassign",{executor:this.executorValue()})}
						>
							Reassign ↻
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							@click=${()=>this.act("release")}
						>
							Release ⏏
						</button>`:t}
				${c!=="failed"&&c!=="ready"&&c!=="working"?e`<button
							class="seg prompt"
							type="button"
							@click=${()=>this.act("prompt")}
						>
							Prompt ↗
						</button>`:t}
			</footer>
		`}executorValue(){return this.renderRoot.querySelector("select[aria-label^='executor'], select[aria-label^='reassign']")?.value??void 0}effortValue(){return this.renderRoot.querySelector("select[aria-label^='reasoning']")?.value??void 0}willUpdate(){if(this.dataset.nested=this.card.nested?"":void 0,this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}if(!customElements.get("klh-task-card"))customElements.define("klh-task-card",O);export{O as KlhTaskCard};
