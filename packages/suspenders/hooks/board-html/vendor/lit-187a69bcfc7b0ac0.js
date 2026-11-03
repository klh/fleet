// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
import{h,r,e,t,n}from"./lit-b59bf30faa0b21f8.js";import{o,c,M,a,i,T,s,d}from"./lit-2f69bfe86efc9f7c.js";import{m,I}from"./lit-bee36ad19b3b0155.js";import{u}from"./lit-e1fc19979af013f3.js";class S extends u{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(l,f,k,z){super(S.eventName);this.action=l,this.id=f,this.project=k,this.executor=z?.executor,this.effort=z?.effort}}class C extends u{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(l,f,k){super(C.eventName);this.id=l,this.project=f,this.executor=k?.executor,this.effort=k?.effort}}class R extends u{static eventName="task-card-open-requested";id;project;constructor(l,f){super(R.eventName);this.id=l,this.project=f}}var K=r`${h(`@charset "UTF-8";
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
}`)}`;function q(l){if(l==="CLAIMED"||l==="RUNNING")return"working";if(l==="WAITING"||l==="BLOCKED"||l==="PAUSED")return"blocked";if(l==="SHATTERED")return"split";if(l==="FAILED")return"failed";if(l==="DONE")return"done";if(l==="CANCELLED")return"cancelled";return"ready"}function W(l){if(l==="SHATTERED")return"split";return l.toLowerCase()}function H(l){return/^\s*BLOCKED\b/i.test(l)?"blocked":"warning"}function B(l){return l.replace(/^\s*BLOCKED\b[\s:]+/i,"")||l}var g=s(d(o())),v=s(d(c())),J=i({value:o(),label:o(),badge:s(o()),reasoningEffort:s(M())}),Q=i({tokens:v,wallMs:v,tokPerMin:v,cachePct:v}),V=i({mode:T(["spend","attempt"]),windowStartMs:v,windowEndMs:v,binMs:v,elapsedMs:v,scaleMs:v}),D=i({id:o(),project:g,title:g,state:o(),ageS:v,contextLines:s(a(o())),parentRef:g,model:g,host:g,warn:g,metrics:s(Q),activity:s(V),nested:s(M()),preferColor:g,executors:s(a(J)),executorPick:g,effortOptions:s(a(o())),effortPick:g,pendingAction:g});function F(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${Math.round(l/1000)}k`;return String(Math.round(l))}function _(l){if(l==null)return"—";if(l<60000)return`${Math.round(l/1000)}s`;let f=Math.round(l/60000);if(f>=60)return`${Math.floor(f/60)}h${String(f%60).padStart(2,"0")}m`;return`${f}m`}function U(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${(l/1000).toFixed(1)}k`;return String(Math.round(l))}function Y(l){if(l==null)return"—";return`${Math.round(l)}%`}var P="—";class A extends n{static properties={card:{attribute:!1}};static styles=K;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return q(this.card.state)}open(){this.dispatchEvent(new R(this.card.id,this.card.project??null))}act(l,f){this.dispatchEvent(new S(l,this.card.id,this.card.project??null,f))}draft(l){this.dispatchEvent(new C(this.card.id,this.card.project??null,l))}statusWord(){return W(this.card.state)}render(){let l=this.card,f=this.tone(),k=l.metrics??null,z=l.ageS==null?P:I(l.ageS),G=l.ageS==null?"age unknown":`open ${m(l.ageS)}`,x=l.executors??[],E=l.executorPick??"",O=l.effortOptions??[],j=l.effortPick??"",L=l.pendingAction??"",b=(p,N)=>L===p?`${N}…`:N,y=(p)=>L===p,w=(p)=>L===p?"true":"false";return e`
			${l.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${f}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${G}>${z}</span>
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
						<b title=${l.model??""}>${l.model??P}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${l.host??""}>${l.host??P}</b>
					</div>
				</div>
				<hr class="rule" />
				${l.warn?e`<div class="warn" role="note">
							<span class="wl">${H(l.warn)}</span>
							<span class="wt" title=${l.warn}>${B(l.warn)}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${F(k?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${_(k?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${U(k?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${Y(k?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details" name="details"></slot>
				</div>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${f==="failed"?e`<button
							class="seg retry"
							type="button"
							?disabled=${y("retry")}
							aria-busy=${w("retry")}
							@click=${()=>this.act("retry")}
						>
							${b("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${y("recover")}
							aria-busy=${w("recover")}
							@click=${()=>this.act("recover")}
						>
							${b("recover","Recover → Ready")}
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${()=>this.act("prompt")}
						>
							Prompt ↗
						</button>`:t}
				${f==="ready"&&x.length?e`<select
							class="seg"
							aria-label=${`executor for ${l.id}`}
							@change=${(p)=>{this.draftExecutor=p.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${x.map((p)=>e`<option
									value=${p.value}
									?selected=${p.value===(this.draftExecutor??E)}
								>
									${p.badge??""}${p.label}
								</option>`)}
						</select>
						${O.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${l.id}`}
									@change=${(p)=>{this.draftEffort=p.target.value,this.draft({effort:this.draftEffort})}}
								>
									${O.map((p)=>e`<option
											value=${p}
											?selected=${p===(this.draftEffort??j)}
										>
											${p}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${y("start")}
							aria-busy=${w("start")}
							@click=${()=>this.act("start",{executor:this.draftExecutor??E,effort:this.draftEffort??j})}
						>
							${b("start","Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${f==="ready"&&!x.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${f==="working"&&!x.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${y("release")}
								aria-busy=${w("release")}
								@click=${()=>this.act("release")}
							>
								${b("release","Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`:t}
				${f==="working"&&x.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${l.id}`}
							@change=${(p)=>{this.draftExecutor=p.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${x.map((p)=>e`<option
									value=${p.value}
									?selected=${p.value===(this.draftExecutor??E)}
								>
									${p.badge??""}${p.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							?disabled=${y("reassign")}
							aria-busy=${w("reassign")}
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??E})}
						>
							${b("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${y("release")}
							aria-busy=${w("release")}
							@click=${()=>this.act("release")}
						>
							${b("release","Release ⏏")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${f==="done"?e`<span class="spacer"></span>
						<button
							class="seg tail report"
							type="button"
							title="open this item's report view"
							@click=${()=>this.act("report")}
						>
							Report ▸
						</button>
						${this.promptSeg()}`:t}
				${f!=="failed"&&f!=="ready"&&f!=="working"&&f!=="done"?e`<span class="spacer"></span>${this.promptSeg()}`:t}
			</footer>
		`}promptSeg(){return e`<button
			class="seg tail prompt"
			type="button"
			@click=${()=>this.act("prompt")}
		>
			Prompt ↗
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}
export{D,A};
