import{h,r,e,t,n}from"./lit-b59bf30faa0b21f8.js";import{R}from"./lit-d725e56f36fddbe4.js";import{o,d,M,b,a,i,y,z,s,p}from"./lit-307787039bd4ed43.js";import{m,D}from"./lit-b7eecf58073b7927.js";import{l}from"./lit-19130002dd3c1d75.js";var re=new Set,L=(c,f)=>{if(customElements.get(c))throw Error(`defineElement: <${c}> is already defined — ONE register point per workspace`);re.add(c),customElements.define(c,f)};var U=r`${h(`@charset "UTF-8";
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
}`)}`;class q extends l{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(c,f,g,k){super(q.eventName);this.action=c,this.id=f,this.project=g,this.executor=k?.executor,this.effort=k?.effort}}class I extends l{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(c,f,g){super(I.eventName);this.id=c,this.project=f,this.executor=g?.executor,this.effort=g?.effort}}class W extends l{static eventName="task-card-open-requested";id;project;constructor(c,f){super(W.eventName);this.id=c,this.project=f}}function V(c){if(c==="CLAIMED"||c==="RUNNING")return"working";if(c==="WAITING"||c==="BLOCKED"||c==="PAUSED")return"blocked";if(c==="SHATTERED")return"split";if(c==="FAILED")return"failed";if(c==="DONE")return"done";if(c==="CANCELLED")return"cancelled";return"ready"}function G(c){if(c==="SHATTERED")return"split";return c.toLowerCase()}function Y(c){return/^\s*BLOCKED\b/i.test(c)?"blocked":"warning"}function J(c){return c.replace(/^\s*BLOCKED\b[\s:]+/i,"")||c}var T=s(p(o())),S=s(p(d())),se=i({value:o(),label:o(),badge:s(o()),reasoningEffort:s(M())}),oe=i({tokens:S,wallMs:S,tokPerMin:S,cachePct:S}),ie=i({mode:z(["spend","attempt"]),windowStartMs:S,windowEndMs:S,binMs:S,elapsedMs:S,scaleMs:S}),Q=i({id:o(),project:T,title:T,state:o(),ageS:S,contextLines:s(a(o())),parentRef:T,model:T,host:T,warn:T,metrics:s(oe),activity:s(ie),nested:s(M()),preferColor:T,executors:s(a(se)),executorPick:T,effortOptions:s(a(o())),effortPick:T,pendingAction:T});function X(c){if(c==null)return"—";if(c>=1e6)return`${(c/1e6).toFixed(1)}M`;if(c>=1000)return`${Math.round(c/1000)}k`;return String(Math.round(c))}function Z(c){if(c==null)return"—";if(c<60000)return`${Math.round(c/1000)}s`;let f=Math.round(c/60000);if(f>=60)return`${Math.floor(f/60)}h${String(f%60).padStart(2,"0")}m`;return`${f}m`}function ee(c){if(c==null)return"—";if(c>=1e6)return`${(c/1e6).toFixed(1)}M`;if(c>=1000)return`${(c/1000).toFixed(1)}k`;return String(Math.round(c))}function te(c){if(c==null)return"—";return`${Math.round(c)}%`}var H="—";class B extends n{static properties={card:{attribute:!1}};static styles=U;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return V(this.card.state)}open(){this.dispatchEvent(new W(this.card.id,this.card.project??null))}act(c,f){this.dispatchEvent(new q(c,this.card.id,this.card.project??null,f))}draft(c){this.dispatchEvent(new I(this.card.id,this.card.project??null,c))}statusWord(){return G(this.card.state)}render(){let c=this.card,f=this.tone(),g=c.metrics??null,k=c.ageS==null?H:D(c.ageS),E=c.ageS==null?"age unknown":`open ${m(c.ageS)}`,v=c.executors??[],w=c.executorPick??"",j=c.effortOptions??[],N=c.effortPick??"",P=c.pendingAction??"",O=(u,F)=>P===u?`${F}…`:F,K=(u)=>P===u,_=(u)=>P===u?"true":"false";return e`
			${c.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${f}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${E}>${k}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${c.id}
				</button>
				${c.title?e`<div class="title" title=${c.title}>${c.title}</div>`:t}
				${(c.contextLines??[]).map((u)=>e`<div class="ctx" title=${u}>${u}</div>`)}
				${c.parentRef?e`<div class="ctx" title=${`parent ${c.parentRef}`}
							>↳ ${c.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${c.model??""}>${c.model??H}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${c.host??""}>${c.host??H}</b>
					</div>
				</div>
				<hr class="rule" />
				${c.warn?e`<div class="warn" role="note">
							<span class="wl">${Y(c.warn)}</span>
							<span class="wt" title=${c.warn}>${J(c.warn)}</span>
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
				${f==="failed"?e`<button
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
				${f==="ready"&&v.length?e`<select
							class="seg"
							aria-label=${`executor for ${c.id}`}
							@change=${(u)=>{this.draftExecutor=u.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${v.map((u)=>e`<option
									value=${u.value}
									?selected=${u.value===(this.draftExecutor??w)}
								>
									${u.badge??""}${u.label}
								</option>`)}
						</select>
						${j.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${c.id}`}
									@change=${(u)=>{this.draftEffort=u.target.value,this.draft({effort:this.draftEffort})}}
								>
									${j.map((u)=>e`<option
											value=${u}
											?selected=${u===(this.draftEffort??N)}
										>
											${u}
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
				${f==="ready"&&!v.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${f==="working"&&!v.length?e`<button
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
				${f==="working"&&v.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${c.id}`}
							@change=${(u)=>{this.draftExecutor=u.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${v.map((u)=>e`<option
									value=${u.value}
									?selected=${u.value===(this.draftExecutor??w)}
								>
									${u.badge??""}${u.label}
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
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var x=s(p(o())),A=s(p(d())),le=i({fresh:A,cached:A,out:A,wall_ms:A,model_groups:s(y(o(),b()))}),ce=i({state:o(),observed_at:A,source:x,progress:s(p(i({stage:z(["completed","reviewed","review-blocked","landed"]),ts:A})))}),de=i({text:x}),pe=i({id:o(),project:x,title:x,state:o(),age_s:A,owner_sid:x,owner_label:x,origin:x,model:x,locality:x,parent_id:x,tag_color:x,failure_note:x,wait_kind:x,wait_reason:x,requires:x,blocked_by:s(a(o())),waiting_on:s(a(o())),spend:s(p(le)),execution:s(p(ce)),tail:s(p(de))});class C extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(c){let f=c.spend?.model_groups,g="",k=-1;if(f)for(let[E,v]of Object.entries(f)){let w=typeof v==="object"&&v!==null?Number(v.requests??0):0;if(Number.isFinite(w)&&w>k)g=E,k=w}return g||c.model||void 0}static hostOf(c){let f=c.owner_label?.trim();if(f&&f!==c.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(f))return f;return c.owner_sid??void 0}static metricsOf(c){let f=c.spend;if(!f)return;let g=f.fresh??void 0,k=f.cached??void 0,E=f.out??void 0,v=f.wall_ms??void 0,w=g===void 0&&k===void 0&&E===void 0?void 0:(g??0)+(k??0)+(E??0),j=v!==void 0&&v>0?v/60000:0,N=j>0&&E!==void 0?E/j:void 0,P=(g??0)+(k??0),O=P>0&&k!==void 0?k/P*100:void 0;return{tokens:w,wallMs:v,tokPerMin:N,cachePct:O}}static parentRefOf(c){return c.parent_id??void 0}contextLinesOf(c){let f=[],g=c.execution;if(g){let w=g.progress?.stage;f.push(w?`${g.state} · ${w}`:`${g.state} · no artifact evidence in snapshot`)}if(c.state==="WAITING"&&c.wait_reason)f.push(`${c.wait_kind??"external"} · ${c.wait_reason}`);let k=c.blocked_by??[];if(k.length)f.push(`waiting on ${k.join(", ")}`);let E=c.waiting_on??[];if(E.length)f.push(`split into ${E.join(", ")}`);if(f.length)return f;let v=c.tail?.text?.trim();return v?[v]:[]}modelOf(c){let f={id:c.id,project:c.project??void 0,title:c.title??void 0,state:c.state,ageS:c.age_s??void 0,contextLines:this.contextLinesOf(c),parentRef:C.parentRefOf(c),model:C.modelOf(c),host:C.hostOf(c),warn:c.failure_note??void 0,metrics:C.metricsOf(c),nested:this.hasAttribute("data-nested"),preferColor:c.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},g=Q.safeParse(f);return g.success?g.data:null}render(){let c=pe.safeParse(this.t);if(!this.t||!c.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let f=c.data,g=this.modelOf(f);if(!g)return e``;let k=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${C.metricsOf(f)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${g}>${k}</klh-task-card>`}createRenderRoot(){return this}}var fe=()=>{L("klh-task-card-host",C),L("klh-task-card",B),L("klh-card-activity",R)};fe();export{fe as registerBoardElements};
