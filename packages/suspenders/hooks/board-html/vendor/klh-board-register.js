import{h,r,e,t,n}from"./lit-b59bf30faa0b21f8.js";import{R}from"./lit-2a58fe1efc89d77c.js";import{o,u,M,b,a,i,x,A,s,p}from"./lit-41f576601b74fc5b.js";import{m,I}from"./lit-abee8ae562874fb2.js";import{c}from"./lit-05d02c13d2fb5953.js";var re=new Set,j=(l,d)=>{if(customElements.get(l))throw Error(`defineElement: <${l}> is already defined — ONE register point per workspace`);re.add(l),customElements.define(l,d)};var V=r`${h(`@charset "UTF-8";
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
  margin: 3px 0 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--klh-ink);
  /* W2267.5 owner density correction: prominent own-line mono ID —
     3xl (18px in the canonical scale) reads at the compact column */
  font: 600 var(--klh-typo-size-3xl, 18px) var(--klh-font-mono, var(--klh-typo-mono-stack));
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
  /* W2267.5: 14px readable title at compact density */
  font-size: var(--klh-typo-size-xl, 14px);
  line-height: 1.32;
  /* long text truncates visually, full text stays accessible on hover */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.ctx {
  margin: 2px 0 0;
  color: var(--klh-dim);
  /* W2267.5: 11px context at compact density */
  font: var(--klh-typo-size-s, 11px) var(--klh-font-mono, var(--klh-typo-mono-stack));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rule {
  border: 0;
  border-top: 1px solid var(--klh-edge-faint);
  margin: 6px 0 0;
}

.cols {
  display: flex;
  gap: 0;
  margin-top: 4px;
  /* model/host values sit in the spec's 12–13px band (#100618) */
  font: var(--klh-typo-size-m, 12px) var(--klh-font-mono, var(--klh-typo-mono-stack));
}

.col {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* W2267.5: 8px gutters fit the compact column */
  padding: 0 8px;
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
  margin-top: 6px;
}

.m {
  flex: 1 1 0;
  min-width: 0;
  padding: 0 8px;
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
  /* W2267.5: compact metrics value — 13px keeps 4 cells in ~300px */
  font: 600 var(--klh-typo-size-l, 13px) var(--klh-font-mono, var(--klh-typo-mono-stack));
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
  padding-inline: 8px;
  border-left: 1px solid var(--klh-edge-faint);
}

.seg {
  flex: 1 1 0;
  /* W2267.5: flex children must shrink inside the ~300px card —
     min-width:auto (the default) let long labels overflow the rail */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  background: none;
  color: var(--klh-ink-2);
  font: var(--klh-typo-size-xs, 10.5px) var(--klh-font-sans, var(--klh-typo-sans-stack));
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

.seg.reassign,
.seg.release {
  flex: 0 0 auto;
}

.seg.prompt {
  color: var(--klh-accent);
}

select.seg {
  /* W2267.5: the selects carry .seg THEMSELVES (direct rail
     children) — \`.seg select\` matched nothing, so they rendered
     unbounded and pushed the rail past the ~300px card. Equal-share
     flex + min-width:0 bounds them; the visible label truncates,
     options keep their full text. */
  flex: 1 1 0;
  min-width: 0;
  height: 28px;
  background: transparent;
  color: var(--klh-ink);
  border: 0;
  border-radius: 0;
  font: var(--klh-typo-size-xs, 10.5px) var(--klh-font-mono, var(--klh-typo-mono-stack));
  padding: 4px 8px;
}

footer button.seg:focus-visible,
.tid:focus-visible,
select.seg:focus-visible {
  outline: 2px solid var(--klh-accent);
  outline-offset: -2px;
}`)}`;class q extends c{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(l,d,g,v){super(q.eventName);this.action=l,this.id=d,this.project=g,this.executor=v?.executor,this.effort=v?.effort}}class W extends c{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(l,d,g){super(W.eventName);this.id=l,this.project=d,this.executor=g?.executor,this.effort=g?.effort}}class D extends c{static eventName="task-card-open-requested";id;project;constructor(l,d){super(D.eventName);this.id=l,this.project=d}}function U(l){if(l==="CLAIMED"||l==="RUNNING")return"working";if(l==="WAITING"||l==="BLOCKED"||l==="PAUSED")return"blocked";if(l==="SHATTERED")return"split";if(l==="FAILED")return"failed";if(l==="DONE")return"done";if(l==="CANCELLED")return"cancelled";return"ready"}function G(l){if(l==="SHATTERED")return"split";return l.toLowerCase()}function Y(l){return/^\s*BLOCKED\b/i.test(l)?"blocked":"warning"}function J(l){return l.replace(/^\s*BLOCKED\b[\s:]+/i,"")||l}var E=s(p(o())),T=s(p(u())),se=i({value:o(),label:o(),badge:s(o()),reasoningEffort:s(M())}),oe=i({tokens:T,wallMs:T,tokPerMin:T,cachePct:T}),ie=i({mode:A(["spend","attempt"]),windowStartMs:T,windowEndMs:T,binMs:T,elapsedMs:T,scaleMs:T}),Q=i({id:o(),project:E,title:E,state:o(),ageS:T,contextLines:s(a(o())),parentRef:E,model:E,host:E,warn:E,metrics:s(oe),activity:s(ie),nested:s(M()),preferColor:E,executors:s(a(se)),executorPick:E,effortOptions:s(a(o())),effortPick:E,pendingAction:E});function X(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${Math.round(l/1000)}k`;return String(Math.round(l))}function Z(l){if(l==null)return"—";if(l<60000)return`${Math.round(l/1000)}s`;let d=Math.round(l/60000);if(d>=60)return`${Math.floor(d/60)}h${String(d%60).padStart(2,"0")}m`;return`${d}m`}function ee(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${(l/1000).toFixed(1)}k`;return String(Math.round(l))}function te(l){if(l==null)return"—";return`${Math.round(l)}%`}var H="—";class B extends n{static properties={card:{attribute:!1}};static styles=V;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return U(this.card.state)}open(){this.dispatchEvent(new D(this.card.id,this.card.project??null))}act(l,d){this.dispatchEvent(new q(l,this.card.id,this.card.project??null,d))}draft(l){this.dispatchEvent(new W(this.card.id,this.card.project??null,l))}statusWord(){return G(this.card.state)}render(){let l=this.card,d=this.tone(),g=l.metrics??null,v=l.ageS==null?H:I(l.ageS),z=l.ageS==null?"age unknown":`open ${m(l.ageS)}`,k=l.executors??[],w=l.executorPick??"",L=l.effortOptions??[],N=l.effortPick??"",P=l.pendingAction??"",S=(f,F)=>P===f?`${F}…`:F,K=(f)=>P===f,_=(f)=>P===f?"true":"false";return e`
			${l.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${d}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${z}>${v}</span>
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
							${S("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${K("recover")}
							aria-busy=${_("recover")}
							@click=${()=>this.act("recover")}
						>
							${S("recover","Recover → Ready")}
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
						${L.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${l.id}`}
									@change=${(f)=>{this.draftEffort=f.target.value,this.draft({effort:this.draftEffort})}}
								>
									${L.map((f)=>e`<option
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
							${S("start","Start ▶")}
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
								${S("release","Release ⏏")}
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
							${S("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${K("release")}
							aria-busy=${_("release")}
							@click=${()=>this.act("release")}
						>
							${S("release","Release ⏏")}
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
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var y=s(p(o())),C=s(p(u())),le=i({fresh:C,cached:C,out:C,wall_ms:C,model_groups:s(x(o(),b()))}),ce=i({state:o(),observed_at:C,source:y,progress:s(p(i({stage:A(["completed","reviewed","review-blocked","landed"]),ts:C})))}),de=i({text:y}),pe=i({id:o(),project:y,title:y,state:o(),age_s:C,owner_sid:y,owner_label:y,origin:y,model:y,locality:y,parent_id:y,tag_color:y,failure_note:y,wait_kind:y,wait_reason:y,requires:y,blocked_by:s(a(o())),waiting_on:s(a(o())),spend:s(p(le)),execution:s(p(ce)),tail:s(p(de))});class O extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(l){let d=l.spend?.model_groups,g="",v=-1;if(d)for(let[z,k]of Object.entries(d)){let w=typeof k==="object"&&k!==null?Number(k.requests??0):0;if(Number.isFinite(w)&&w>v)g=z,v=w}return g||l.model||void 0}static hostOf(l){let d=l.owner_label?.trim();if(d&&d!==l.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(d))return d;return l.owner_sid??void 0}static metricsOf(l){let d=l.spend;if(!d)return;let g=d.fresh??void 0,v=d.cached??void 0,z=d.out??void 0,k=d.wall_ms??void 0,w=g===void 0&&v===void 0&&z===void 0?void 0:(g??0)+(v??0)+(z??0),L=k!==void 0&&k>0?k/60000:0,N=L>0&&z!==void 0?z/L:void 0,P=(g??0)+(v??0),S=P>0&&v!==void 0?v/P*100:void 0;return{tokens:w,wallMs:k,tokPerMin:N,cachePct:S}}static parentRefOf(l){return l.parent_id??void 0}contextLinesOf(l){let d=[],g=l.execution;if(g){let w=g.progress?.stage;d.push(w?`${g.state} · ${w}`:`${g.state} · no artifact evidence in snapshot`)}if(l.state==="WAITING"&&l.wait_reason)d.push(`${l.wait_kind??"external"} · ${l.wait_reason}`);let v=l.blocked_by??[];if(v.length)d.push(`waiting on ${v.join(", ")}`);let z=l.waiting_on??[];if(z.length)d.push(`split into ${z.join(", ")}`);let k=l.tail?.text?.trim();if(k&&!d.includes(k))d.push(k);return d}modelOf(l){let d={id:l.id,project:l.project??void 0,title:l.title??void 0,state:l.state,ageS:l.age_s??void 0,contextLines:this.contextLinesOf(l),parentRef:O.parentRefOf(l),model:O.modelOf(l),host:O.hostOf(l),warn:l.failure_note??void 0,metrics:O.metricsOf(l),nested:this.hasAttribute("data-nested"),preferColor:l.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},g=Q.safeParse(d);return g.success?g.data:null}render(){let l=pe.safeParse(this.t);if(!this.t||!l.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let d=l.data,g=this.modelOf(d);if(!g)return e``;let v=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${O.metricsOf(d)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${g}>${v}</klh-task-card>`}createRenderRoot(){return this}}var fe=()=>{j("klh-task-card-host",O),j("klh-task-card",B),j("klh-card-activity",R)};fe();export{fe as registerBoardElements};
