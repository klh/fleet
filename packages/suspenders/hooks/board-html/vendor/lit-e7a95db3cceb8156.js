// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
import{d,r,e,t,n}from"./lit-9ab93f5debb235da.js";import{y,C,f,s,c,z,a,i,w,o,u}from"./lit-f50b6eddc98e66cc.js";class A extends f{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(l,h,k,T){super(A.eventName);this.action=l,this.id=h,this.project=k,this.executor=T?.executor,this.effort=T?.effort}}class L extends f{static eventName="task-card-open-requested";id;project;constructor(l,h){super(L.eventName);this.id=l,this.project=h}}var j=r`${d(`@charset "UTF-8";
/* tone → color, self-contained: the page maps data-tone on .kcard/
   .kcol only, so the card owns its own --state-color token map. */
:host([data-tone=ready]) {
  --state-color: var(--work-ready);
}

:host([data-tone=working]) {
  --state-color: var(--work-working);
}

:host([data-tone=blocked]) {
  --state-color: var(--work-blocked);
}

:host([data-tone=failed]) {
  --state-color: var(--work-failed);
}

:host([data-tone=done]) {
  --state-color: var(--work-done);
}

:host([data-tone=split]) {
  --state-color: var(--work-split);
}

:host([data-tone=cancelled]) {
  --state-color: var(--work-cancelled);
}

:host {
  /* the host IS the card surface: configurable semantic perimeter
     (—prefer) independent of --state-color; nested children dashed.
     position:relative anchors the nested elbow (absolute, hung into
     the indent gutter) to THIS card, not an unrelated ancestor. */
  display: flex;
  flex-direction: column;
  position: relative;
  border: 1px solid var(--prefer, var(--state-color, var(--klh-edge-soft)));
  border-radius: 3px;
  background: var(--klh-wash);
  font: var(--klh-text-md, var(--klh-typo-size-m, 12px))/1.45 var(--klh-font-sans, var(--klh-typo-sans-stack));
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
  font: var(--klh-typo-size-s, 11px) var(--klh-font-mono, var(--klh-typo-mono-stack));
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
  font: 600 var(--klh-typo-size-3xl, 20px) var(--klh-font-mono, var(--klh-typo-mono-stack));
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
  font: var(--klh-typo-size-m, 12px) var(--klh-font-mono, var(--klh-typo-mono-stack));
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
  font: var(--klh-typo-size-m, 12px) var(--klh-font-mono, var(--klh-typo-mono-stack));
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
  /* #103117: reference 09 card left-aligns every metric cell */
  text-align: left;
}

.m:first-child {
  padding-left: 0;
}

.m + .m {
  border-left: 1px solid var(--klh-edge-faint);
}

.mv {
  font: 600 var(--klh-typo-size-2xl, 16px) var(--klh-font-mono, var(--klh-typo-mono-stack));
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
  font: var(--klh-typo-size-s, 11px) var(--klh-font-sans, var(--klh-typo-sans-stack));
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
  font: var(--klh-typo-size-xs, 10.5px) var(--klh-font-mono, var(--klh-typo-mono-stack));
  padding: 0 4px;
}

footer button.seg:focus-visible,
.tid:focus-visible,
.seg select:focus-visible {
  outline: 2px solid var(--klh-accent);
  outline-offset: -2px;
}`)}`;function q(l){if(l==="CLAIMED"||l==="RUNNING")return"working";if(l==="WAITING"||l==="BLOCKED"||l==="PAUSED")return"blocked";if(l==="SHATTERED")return"split";if(l==="FAILED")return"failed";if(l==="DONE")return"done";if(l==="CANCELLED")return"cancelled";return"ready"}function I(l){if(l==="SHATTERED")return"split";return l.toLowerCase()}function W(l){return/^\s*BLOCKED\b/i.test(l)?"blocked":"warning"}function H(l){return l.replace(/^\s*BLOCKED\b[\s:]+/i,"")||l}var g=o(u(s())),v=o(u(c())),G=i({value:s(),label:s(),badge:o(s()),reasoningEffort:o(z())}),J=i({tokens:v,wallMs:v,tokPerMin:v,cachePct:v}),Q=i({mode:w(["spend","attempt"]),windowStartMs:v,windowEndMs:v,binMs:v,elapsedMs:v,scaleMs:v}),R=i({id:s(),project:g,title:g,state:s(),ageS:v,contextLines:o(a(s())),parentRef:g,model:g,host:g,warn:g,metrics:o(J),activity:o(Q),nested:o(z()),preferColor:g,executors:o(a(G)),executorPick:g,effortOptions:o(a(s())),effortPick:g,pendingAction:g});function B(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${Math.round(l/1000)}k`;return String(Math.round(l))}function F(l){if(l==null)return"—";if(l<60000)return`${Math.round(l/1000)}s`;let h=Math.round(l/60000);if(h>=60)return`${Math.floor(h/60)}h${String(h%60).padStart(2,"0")}m`;return`${h}m`}function _(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${(l/1000).toFixed(1)}k`;return String(Math.round(l))}function U(l){if(l==null)return"—";return`${Math.round(l)}%`}var O="—";class S extends n{static properties={card:{attribute:!1}};static styles=j;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return q(this.card.state)}open(){this.dispatchEvent(new L(this.card.id,this.card.project??null))}act(l,h){this.dispatchEvent(new A(l,this.card.id,this.card.project??null,h))}statusWord(){return I(this.card.state)}render(){let l=this.card,h=this.tone(),k=l.metrics??null,T=l.ageS==null?O:C(l.ageS),Y=l.ageS==null?"age unknown":`open ${y(l.ageS)}`,m=l.executors??[],M=l.executorPick??"",D=l.effortOptions??[],K=l.effortPick??"",P=l.pendingAction??"",x=(p,N)=>P===p?`${N}…`:N,b=(p)=>P===p,E=(p)=>P===p?"true":"false";return e`
			${l.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${h}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${Y}>${T}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${l.id}
				</button>
				${l.title?e`<div class="title" title=${l.title}>${l.title}</div>`:t}
				${(l.contextLines??[]).map((p)=>e`<div class="ctx" title=${p}>${p}</div>`)}
				${l.parentRef?e`<div class="ctx" title=${`parent ${l.parentRef}`}
							>↳ ${l.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${l.model??""}>${l.model??O}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${l.host??""}>${l.host??O}</b>
					</div>
				</div>
				<hr class="rule" />
				${l.warn?e`<div class="warn" role="note">
							<span class="wl">${W(l.warn)}</span>
							<span class="wt" title=${l.warn}>${H(l.warn)}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${B(k?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${F(k?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${_(k?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${U(k?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details" name="details"></slot>
				</div>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${h==="failed"?e`<button
							class="seg retry"
							type="button"
							?disabled=${b("retry")}
							aria-busy=${E("retry")}
							@click=${()=>this.act("retry")}
						>
							${x("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${b("recover")}
							aria-busy=${E("recover")}
							@click=${()=>this.act("recover")}
						>
							${x("recover","Recover → Ready")}
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${()=>this.act("prompt")}
						>
							Prompt ↗
						</button>`:t}
				${h==="ready"&&m.length?e`<select
							class="seg"
							aria-label=${`executor for ${l.id}`}
							@change=${(p)=>{this.draftExecutor=p.target.value}}
						>
							${m.map((p)=>e`<option
									value=${p.value}
									?selected=${p.value===(this.draftExecutor??M)}
								>
									${p.badge??""}${p.label}
								</option>`)}
						</select>
						${D.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${l.id}`}
									@change=${(p)=>{this.draftEffort=p.target.value}}
								>
									${D.map((p)=>e`<option
											value=${p}
											?selected=${p===(this.draftEffort??K)}
										>
											${p}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${b("start")}
							aria-busy=${E("start")}
							@click=${()=>this.act("start",{executor:this.draftExecutor??M,effort:this.draftEffort??K})}
						>
							${x("start","Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${h==="ready"&&!m.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${h==="working"&&!m.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${b("release")}
								aria-busy=${E("release")}
								@click=${()=>this.act("release")}
							>
								${x("release","Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`:t}
				${h==="working"&&m.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${l.id}`}
							@change=${(p)=>{this.draftExecutor=p.target.value}}
						>
							${m.map((p)=>e`<option
									value=${p.value}
									?selected=${p.value===(this.draftExecutor??M)}
								>
									${p.badge??""}${p.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							?disabled=${b("reassign")}
							aria-busy=${E("reassign")}
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??M})}
						>
							${x("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${b("release")}
							aria-busy=${E("release")}
							@click=${()=>this.act("release")}
						>
							${x("release","Release ⏏")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${h==="done"?e`<span class="spacer"></span>
						<button
							class="seg tail report"
							type="button"
							title="open this item's report view"
							@click=${()=>this.act("report")}
						>
							Report ▸
						</button>
						${this.promptSeg()}`:t}
				${h!=="failed"&&h!=="ready"&&h!=="working"&&h!=="done"?e`<span class="spacer"></span>${this.promptSeg()}`:t}
			</footer>
		`}promptSeg(){return e`<button
			class="seg tail prompt"
			type="button"
			@click=${()=>this.act("prompt")}
		>
			Prompt ↗
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}
export{R,S};
