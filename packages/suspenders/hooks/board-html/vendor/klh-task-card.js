import{n,e,t,r}from"./lit-96e87015cf7d620b.js";import{f,S,d,s,u,y,l,i,z,o,E}from"./lit-5ab415d586a6f867.js";class b extends d{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(a,c,k,m){super(b.eventName);this.action=a,this.id=c,this.project=k,this.executor=m?.executor,this.effort=m?.effort}}class w extends d{static eventName="task-card-open-requested";id;project;constructor(a,c){super(w.eventName);this.id=a,this.project=c}}function R(a){if(a==="CLAIMED"||a==="RUNNING")return"working";if(a==="WAITING"||a==="BLOCKED"||a==="PAUSED")return"blocked";if(a==="SHATTERED")return"split";if(a==="FAILED")return"failed";if(a==="DONE")return"done";if(a==="CANCELLED")return"cancelled";return"ready"}function A(a){if(a==="SHATTERED")return"split";return a.toLowerCase()}var h=o(E(s())),g=o(E(u())),I=i({value:s(),label:s(),badge:o(s()),reasoningEffort:o(y())}),D=i({tokens:g,wallMs:g,tokPerMin:g,cachePct:g}),K=i({mode:z(["spend","attempt"]),windowStartMs:g,windowEndMs:g,binMs:g,elapsedMs:g,scaleMs:g}),U=i({id:s(),project:h,title:h,state:s(),ageS:g,context:h,parentRef:h,model:h,host:h,warn:h,metrics:o(D),activity:o(K),nested:o(y()),preferColor:h,executors:o(l(I)),executorPick:h,effortOptions:o(l(s())),effortPick:h});function P(a){if(a==null)return"—";if(a>=1e6)return`${(a/1e6).toFixed(1)}M`;if(a>=1000)return`${Math.round(a/1000)}k`;return String(Math.round(a))}function O(a){if(a==null)return"—";if(a<60000)return`${Math.round(a/1000)}s`;let c=Math.round(a/60000);if(c>=60)return`${Math.floor(c/60)}h${String(c%60).padStart(2,"0")}m`;return`${c}m`}function N(a){if(a==null)return"—";if(a>=1e6)return`${(a/1e6).toFixed(1)}M`;if(a>=1000)return`${(a/1000).toFixed(1)}k`;return String(Math.round(a))}function j(a){if(a==null)return"—";return`${Math.round(a)}%`}var T="—";class L extends r{static properties={card:{attribute:!1}};static styles=n`
		/* tone → color, self-contained: the page maps data-tone on .kcard/
		   .kcol only, so the card owns its own --state-color token map. */
		:host([data-tone="ready"]) { --state-color: var(--work-ready); }
		:host([data-tone="working"]) { --state-color: var(--work-working); }
		:host([data-tone="blocked"]) { --state-color: var(--work-blocked); }
		:host([data-tone="failed"]) { --state-color: var(--work-failed); }
		:host([data-tone="done"]) { --state-color: var(--work-done); }
		:host([data-tone="split"]) { --state-color: var(--work-split); }
		:host([data-tone="cancelled"]) { --state-color: var(--work-cancelled); }
		:host {
			/* the host IS the card surface: configurable semantic perimeter
			   (—prefer) independent of --state-color; nested children dashed.
			   position:relative anchors the nested elbow (absolute, hung into
			   the indent gutter) to THIS card, not an unrelated ancestor. */
			display: flex;
			flex-direction: column;
			position: relative;
			border: 1px solid
				var(--prefer, var(--state-color, var(--klh-edge-soft)));
			border-radius: 3px;
			background: var(--klh-wash);
			font: var(--klh-text-md, var(--klh-typo-size-m, 12px))/1.45
				var(--klh-font-sans, var(--klh-typo-sans-stack));
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
			font: var(--klh-typo-size-s, 11px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
		}
		.wrap {
			position: relative;
			display: flex;
			flex-direction: column;
			min-height: 100%;
			padding: 9px 0 0;
		}
		.pad {
			padding: 0 12px;
		}
		.head {
			display: flex;
			align-items: baseline;
			gap: 6px;
			/* #101242: the readable 12px band — 10px stays axis/units only */
			font-size: var(--klh-typo-size-m, 12px);
			letter-spacing: var(--klh-typo-track-label, 0.09em);
			text-transform: uppercase;
			color: var(--state-color, var(--klh-dim));
		}
		.sq {
			flex: none;
			width: 10px;
			height: 10px;
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
			/* #101242: prominent own-line mono ID — 20px readable at 380 too */
			font: 600 var(--klh-typo-size-3xl, 20px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
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
			font-size: var(--klh-typo-size-2xl, 16px);
			line-height: 1.35;
			/* long text truncates visually, full text stays accessible on hover */
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 3;
			overflow: hidden;
		}
		.ctx {
			margin: 3px 0 0;
			color: var(--klh-dim);
			font: var(--klh-typo-size-m, 12px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
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
			/* model/host values sit in the spec's 12–13px band (#100618) */
			font: var(--klh-typo-size-m, 12px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
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
			font-size: var(--klh-typo-size-2xs, 10px);
			letter-spacing: var(--klh-typo-track-label, 0.09em);
			text-transform: uppercase;
			color: var(--klh-dim);
		}
		.warn {
			margin: 7px 0 0;
			border-left: 2px solid var(--work-failed, var(--klh-danger));
			background: var(--klh-danger-wash);
			padding: 4px 8px;
			font-size: var(--klh-typo-size-m, 12px);
			color: var(--klh-danger-ink);
		}
		.warn .wl {
			font-weight: 700;
			text-transform: uppercase;
			font-size: var(--klh-typo-size-2xs, 10px);
			letter-spacing: var(--klh-typo-track-label, 0.09em);
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
			font: 600 var(--klh-typo-size-2xl, 16px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
			font-variant-numeric: tabular-nums;
			color: var(--klh-ink);
		}
		.ml {
			display: block;
			margin-top: 1px;
			font-size: var(--klh-typo-size-2xs, 10px);
			letter-spacing: var(--klh-typo-track-label, 0.09em);
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
		/* the activity slot sits flush at the card bottom: the strip's own
		   1px duration rail + ~13px axis area ride the slot, no extra padding. */
		.activity {
			display: block;
			margin-top: 8px;
			padding: 0;
		}
		footer {
			/* neutral segmented rail, full-width flush bottom — zero margin so
			   the axis area of the slotted strip abuts it exactly (#100618) */
			display: flex;
			align-items: stretch;
			width: 100%;
			margin: 0;
			border-top: 1px solid var(--klh-edge-faint);
			background: var(--klh-surface);
			border-radius: 0 0 2px 2px;
		}
		footer:empty {
			display: none;
		}
		.spacer {
			/* the lone Prompt/Report sits rightmost; the rail's empty left
			   half stays bare surface with the segment dividers at the right */
			flex: 1 1 auto;
		}
		.seg.tail {
			/* bounded (not equal-share): the rightmost affordance keeps its
			   own width, divider at its left edge, rail bare before it */
			flex: 0 1 auto;
			padding-inline: 14px;
			border-left: 1px solid var(--klh-edge-faint);
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
			font: var(--klh-typo-size-s, 11px)
				var(--klh-font-sans, var(--klh-typo-sans-stack));
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
			font: var(--klh-typo-size-xs, 10.5px)
				var(--klh-font-mono, var(--klh-typo-mono-stack));
			padding: 0 4px;
		}
		footer button.seg:focus-visible,
		.tid:focus-visible,
		.seg select:focus-visible {
			outline: 2px solid var(--klh-accent);
			outline-offset: -2px;
		}
	`;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return R(this.card.state)}open(){this.dispatchEvent(new w(this.card.id,this.card.project??null))}act(a,c){this.dispatchEvent(new b(a,this.card.id,this.card.project??null,c))}statusWord(){return A(this.card.state)}render(){let a=this.card,c=this.tone(),k=a.metrics??null,m=a.ageS==null?T:S(a.ageS),q=a.ageS==null?"age unknown":`open ${f(a.ageS)}`,v=a.executors??[],x=a.executorPick??"",M=a.effortOptions??[],C=a.effortPick??"";return e`
			${a.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${c}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${q}>${m}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${a.id}
				</button>
				${a.title?e`<div class="title" title=${a.title}>${a.title}</div>`:t}
				${a.context?e`<div class="ctx" title=${a.context}>${a.context}</div>`:t}
				${a.parentRef?e`<div class="ctx" title=${`parent ${a.parentRef}`}
							>↳ ${a.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${a.model??""}>${a.model??T}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${a.host??""}>${a.host??T}</b>
					</div>
				</div>
				${a.warn?e`<div class="warn" role="note">
							<span class="wl">${c==="failed"?"blocked":"warning"}</span>
							<span class="wt" title=${a.warn}>${a.warn}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${P(k?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${O(k?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${N(k?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${j(k?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details" name="details"></slot>
				</div>
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
							@change=${(p)=>{this.draftExecutor=p.target.value}}
						>
							${v.map((p)=>e`<option
									value=${p.value}
									?selected=${p.value===(this.draftExecutor??x)}
								>
									${p.badge??""}${p.label}
								</option>`)}
						</select>
						${M.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${a.id}`}
									@change=${(p)=>{this.draftEffort=p.target.value}}
								>
									${M.map((p)=>e`<option
											value=${p}
											?selected=${p===(this.draftEffort??C)}
										>
											${p}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							@click=${()=>this.act("start",{executor:this.draftExecutor??x,effort:this.draftEffort??C})}
						>
							Start ▶
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${c==="ready"&&!v.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${c==="working"&&!v.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								@click=${()=>this.act("release")}
							>
								Release ⏏
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`:t}
				${c==="working"&&v.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${a.id}`}
							@change=${(p)=>{this.draftExecutor=p.target.value}}
						>
							${v.map((p)=>e`<option
									value=${p.value}
									?selected=${p.value===(this.draftExecutor??x)}
								>
									${p.badge??""}${p.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??x})}
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
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${c==="done"?e`<span class="spacer"></span>
						<button
							class="seg tail report"
							type="button"
							title="open this item's report view"
							@click=${()=>this.act("report")}
						>
							Report ▸
						</button>
						${this.promptSeg()}`:t}
				${c!=="failed"&&c!=="ready"&&c!=="working"&&c!=="done"?e`<span class="spacer"></span>${this.promptSeg()}`:t}
			</footer>
		`}promptSeg(){return e`<button
			class="seg tail prompt"
			type="button"
			@click=${()=>this.act("prompt")}
		>
			Prompt ↗
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}if(!customElements.get("klh-task-card"))customElements.define("klh-task-card",L);export{L as KlhTaskCard};
