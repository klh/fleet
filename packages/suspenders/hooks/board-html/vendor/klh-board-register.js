import{h,r,e,t,n}from"./lit-b59bf30faa0b21f8.js";import{R}from"./lit-b1895177b7fe27ad.js";import{o,u,M,b,a,i,x,z,s,p}from"./lit-d1335ced603fe410.js";import{m,D}from"./lit-b7eecf58073b7927.js";import{c}from"./lit-d4f1cb4c1f513c55.js";var re=new Set,L=(l,d)=>{if(customElements.get(l))throw Error(`defineElement: <${l}> is already defined — ONE register point per workspace`);re.add(l),customElements.define(l,d)};var U=r`${h(`@charset "UTF-8";
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
}`)}`;class q extends c{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(l,d,g,v){super(q.eventName);this.action=l,this.id=d,this.project=g,this.executor=v?.executor,this.effort=v?.effort}}class I extends c{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(l,d,g){super(I.eventName);this.id=l,this.project=d,this.executor=g?.executor,this.effort=g?.effort}}class W extends c{static eventName="task-card-open-requested";id;project;constructor(l,d){super(W.eventName);this.id=l,this.project=d}}function V(l){if(l==="CLAIMED"||l==="RUNNING")return"working";if(l==="WAITING"||l==="BLOCKED"||l==="PAUSED")return"blocked";if(l==="SHATTERED")return"split";if(l==="FAILED")return"failed";if(l==="DONE")return"done";if(l==="CANCELLED")return"cancelled";return"ready"}function G(l){if(l==="SHATTERED")return"split";return l.toLowerCase()}function Y(l){return/^\s*BLOCKED\b/i.test(l)?"blocked":"warning"}function J(l){return l.replace(/^\s*BLOCKED\b[\s:]+/i,"")||l}var T=s(p(o())),S=s(p(u())),se=i({value:o(),label:o(),badge:s(o()),reasoningEffort:s(M())}),oe=i({tokens:S,wallMs:S,tokPerMin:S,cachePct:S}),ie=i({mode:z(["spend","attempt"]),windowStartMs:S,windowEndMs:S,binMs:S,elapsedMs:S,scaleMs:S}),Q=i({id:o(),project:T,title:T,state:o(),ageS:S,contextLines:s(a(o())),parentRef:T,model:T,host:T,warn:T,metrics:s(oe),activity:s(ie),nested:s(M()),preferColor:T,executors:s(a(se)),executorPick:T,effortOptions:s(a(o())),effortPick:T,pendingAction:T});function X(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${Math.round(l/1000)}k`;return String(Math.round(l))}function Z(l){if(l==null)return"—";if(l<60000)return`${Math.round(l/1000)}s`;let d=Math.round(l/60000);if(d>=60)return`${Math.floor(d/60)}h${String(d%60).padStart(2,"0")}m`;return`${d}m`}function ee(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${(l/1000).toFixed(1)}k`;return String(Math.round(l))}function te(l){if(l==null)return"—";return`${Math.round(l)}%`}var H="—";class B extends n{static properties={card:{attribute:!1}};static styles=U;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return V(this.card.state)}open(){this.dispatchEvent(new W(this.card.id,this.card.project??null))}act(l,d){this.dispatchEvent(new q(l,this.card.id,this.card.project??null,d))}draft(l){this.dispatchEvent(new I(this.card.id,this.card.project??null,l))}statusWord(){return G(this.card.state)}render(){let l=this.card,d=this.tone(),g=l.metrics??null,v=l.ageS==null?H:D(l.ageS),E=l.ageS==null?"age unknown":`open ${m(l.ageS)}`,k=l.executors??[],w=l.executorPick??"",j=l.effortOptions??[],N=l.effortPick??"",P=l.pendingAction??"",O=(f,F)=>P===f?`${F}…`:F,K=(f)=>P===f,_=(f)=>P===f?"true":"false";return e`
			${l.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${d}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${E}>${v}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${l.id}
				</button>
				${l.title?e`<div class="title" title=${l.title}>${l.title}</div>`:t}
				${(l.contextLines??[]).map((f)=>e`<div class="ctx" title=${f}>${f}</div>`)}
				${l.parentRef?e`<div class="ctx" title=${`parent ${l.parentRef}`}
							>↳ ${l.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${l.model??""}>${l.model??H}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${l.host??""}>${l.host??H}</b>
					</div>
				</div>
				<hr class="rule" />
				${l.warn?e`<div class="warn" role="note">
							<span class="wl">${Y(l.warn)}</span>
							<span class="wt" title=${l.warn}>${J(l.warn)}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${X(g?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${Z(g?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${ee(g?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${te(g?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details" name="details"></slot>
				</div>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${d==="failed"?e`<button
							class="seg retry"
							type="button"
							?disabled=${K("retry")}
							aria-busy=${_("retry")}
							@click=${()=>this.act("retry")}
						>
							${O("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${K("recover")}
							aria-busy=${_("recover")}
							@click=${()=>this.act("recover")}
						>
							${O("recover","Recover → Ready")}
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${()=>this.act("prompt")}
						>
							Prompt ↗
						</button>`:t}
				${d==="ready"&&k.length?e`<select
							class="seg"
							aria-label=${`executor for ${l.id}`}
							@change=${(f)=>{this.draftExecutor=f.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${k.map((f)=>e`<option
									value=${f.value}
									?selected=${f.value===(this.draftExecutor??w)}
								>
									${f.badge??""}${f.label}
								</option>`)}
						</select>
						${j.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${l.id}`}
									@change=${(f)=>{this.draftEffort=f.target.value,this.draft({effort:this.draftEffort})}}
								>
									${j.map((f)=>e`<option
											value=${f}
											?selected=${f===(this.draftEffort??N)}
										>
											${f}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${K("start")}
							aria-busy=${_("start")}
							@click=${()=>this.act("start",{executor:this.draftExecutor??w,effort:this.draftEffort??N})}
						>
							${O("start","Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${d==="ready"&&!k.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${d==="working"&&!k.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${K("release")}
								aria-busy=${_("release")}
								@click=${()=>this.act("release")}
							>
								${O("release","Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`:t}
				${d==="working"&&k.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${l.id}`}
							@change=${(f)=>{this.draftExecutor=f.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${k.map((f)=>e`<option
									value=${f.value}
									?selected=${f.value===(this.draftExecutor??w)}
								>
									${f.badge??""}${f.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							?disabled=${K("reassign")}
							aria-busy=${_("reassign")}
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??w})}
						>
							${O("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${K("release")}
							aria-busy=${_("release")}
							@click=${()=>this.act("release")}
						>
							${O("release","Release ⏏")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${d==="done"?e`<span class="spacer"></span>
						<button
							class="seg tail report"
							type="button"
							title="open this item's report view"
							@click=${()=>this.act("report")}
						>
							Report ▸
						</button>
						${this.promptSeg()}`:t}
				${d!=="failed"&&d!=="ready"&&d!=="working"&&d!=="done"?e`<span class="spacer"></span>${this.promptSeg()}`:t}
			</footer>
		`}promptSeg(){return e`<button
			class="seg tail prompt"
			type="button"
			@click=${()=>this.act("prompt")}
		>
			Prompt ↗
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var y=s(p(o())),A=s(p(u())),le=i({fresh:A,cached:A,out:A,wall_ms:A,model_groups:s(x(o(),b()))}),ce=i({state:o(),observed_at:A,source:y,progress:s(p(i({stage:z(["completed","reviewed","review-blocked","landed"]),ts:A})))}),de=i({text:y}),pe=i({id:o(),project:y,title:y,state:o(),age_s:A,owner_sid:y,owner_label:y,origin:y,model:y,locality:y,parent_id:y,tag_color:y,failure_note:y,wait_kind:y,wait_reason:y,requires:y,blocked_by:s(a(o())),waiting_on:s(a(o())),spend:s(p(le)),execution:s(p(ce)),tail:s(p(de))});class C extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(l){let d=l.spend?.model_groups,g="",v=-1;if(d)for(let[E,k]of Object.entries(d)){let w=typeof k==="object"&&k!==null?Number(k.requests??0):0;if(Number.isFinite(w)&&w>v)g=E,v=w}return g||l.model||void 0}static hostOf(l){let d=l.owner_label?.trim();if(d&&d!==l.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(d))return d;return l.owner_sid??void 0}static metricsOf(l){let d=l.spend;if(!d)return;let g=d.fresh??void 0,v=d.cached??void 0,E=d.out??void 0,k=d.wall_ms??void 0,w=g===void 0&&v===void 0&&E===void 0?void 0:(g??0)+(v??0)+(E??0),j=k!==void 0&&k>0?k/60000:0,N=j>0&&E!==void 0?E/j:void 0,P=(g??0)+(v??0),O=P>0&&v!==void 0?v/P*100:void 0;return{tokens:w,wallMs:k,tokPerMin:N,cachePct:O}}static parentRefOf(l){return l.parent_id??void 0}contextLinesOf(l){let d=[],g=l.execution;if(g){let w=g.progress?.stage;d.push(w?`${g.state} · ${w}`:`${g.state} · no artifact evidence in snapshot`)}if(l.state==="WAITING"&&l.wait_reason)d.push(`${l.wait_kind??"external"} · ${l.wait_reason}`);let v=l.blocked_by??[];if(v.length)d.push(`waiting on ${v.join(", ")}`);let E=l.waiting_on??[];if(E.length)d.push(`split into ${E.join(", ")}`);let k=l.tail?.text?.trim();if(k&&!d.includes(k))d.push(k);return d}modelOf(l){let d={id:l.id,project:l.project??void 0,title:l.title??void 0,state:l.state,ageS:l.age_s??void 0,contextLines:this.contextLinesOf(l),parentRef:C.parentRefOf(l),model:C.modelOf(l),host:C.hostOf(l),warn:l.failure_note??void 0,metrics:C.metricsOf(l),nested:this.hasAttribute("data-nested"),preferColor:l.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},g=Q.safeParse(d);return g.success?g.data:null}render(){let l=pe.safeParse(this.t);if(!this.t||!l.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let d=l.data,g=this.modelOf(d);if(!g)return e``;let v=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${C.metricsOf(d)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${g}>${v}</klh-task-card>`}createRenderRoot(){return this}}var fe=()=>{L("klh-task-card-host",C),L("klh-task-card",B),L("klh-card-activity",R)};fe();export{fe as registerBoardElements};
