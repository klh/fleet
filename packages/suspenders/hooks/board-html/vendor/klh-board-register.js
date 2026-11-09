import{g,r,e,t,n}from"./lit-f18bcbfe556b7350.js";import{M}from"./lit-bdbe25a9bb288c58.js";import{o,d,Z,b,l,i,E,P,s,h}from"./lit-b661955c28476729.js";import{c,N}from"./lit-88ce58085f9deb62.js";import{a}from"./lit-71b20d68dd352113.js";var re=new Set,L=(p,f)=>{if(customElements.get(p))throw Error(`defineElement: <${p}> is already defined — ONE register point per workspace`);re.add(p),customElements.define(p,f)};var F=r`${g(`@charset "UTF-8";
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
}`)}`;class q extends a{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(p,f,m,v){super(q.eventName);this.action=p,this.id=f,this.project=m,this.executor=v?.executor,this.effort=v?.effort}}class W extends a{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(p,f,m){super(W.eventName);this.id=p,this.project=f,this.executor=m?.executor,this.effort=m?.effort}}class I extends a{static eventName="task-card-open-requested";id;project;constructor(p,f){super(I.eventName);this.id=p,this.project=f}}function V(p){if(p==="CLAIMED"||p==="RUNNING")return"working";if(p==="WAITING"||p==="BLOCKED"||p==="PAUSED")return"blocked";if(p==="SHATTERED")return"split";if(p==="FAILED")return"failed";if(p==="DONE")return"done";if(p==="CANCELLED")return"cancelled";return"ready"}function U(p){if(p==="SHATTERED")return"split";return p.toLowerCase()}function G(p){return/^\s*BLOCKED\b/i.test(p)?"blocked":"warning"}function Y(p){return p.replace(/^\s*BLOCKED\b[\s:]+/i,"")||p}var z=s(h(o())),T=s(h(d())),se=i({value:o(),label:o(),badge:s(o()),reasoningEffort:s(Z())}),oe=i({tokens:T,wallMs:T,tokPerMin:T,cachePct:T}),ie=i({mode:P(["spend","attempt"]),windowStartMs:T,windowEndMs:T,binMs:T,elapsedMs:T,scaleMs:T}),J=i({id:o(),project:z,title:z,state:o(),ageS:T,contextLines:s(l(o())),parentRef:z,model:z,host:z,warn:z,metrics:s(oe),activity:s(ie),nested:s(Z()),preferColor:z,executors:s(l(se)),executorPick:z,effortOptions:s(l(o())),effortPick:z,pendingAction:z});function Q(p){if(p==null)return"—";if(p>=1e6)return`${(p/1e6).toFixed(1)}M`;if(p>=1000)return`${Math.round(p/1000)}k`;return String(Math.round(p))}function X(p){if(p==null)return"—";if(p<60000)return`${Math.round(p/1000)}s`;let f=Math.round(p/60000);if(f>=60)return`${Math.floor(f/60)}h${String(f%60).padStart(2,"0")}m`;return`${f}m`}function ee(p){if(p==null)return"—";if(p>=1e6)return`${(p/1e6).toFixed(1)}M`;if(p>=1000)return`${(p/1000).toFixed(1)}k`;return String(Math.round(p))}function te(p){if(p==null)return"—";return`${Math.round(p)}%`}var D="—";class H extends n{static properties={card:{attribute:!1}};static styles=F;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return V(this.card.state)}open(){this.dispatchEvent(new I(this.card.id,this.card.project??null))}act(p,f){this.dispatchEvent(new q(p,this.card.id,this.card.project??null,f))}draft(p){this.dispatchEvent(new W(this.card.id,this.card.project??null,p))}statusWord(){return U(this.card.state)}render(){let p=this.card,f=this.tone(),m=p.metrics??null,v=p.ageS==null?D:N(p.ageS),w=p.ageS==null?"age unknown":`open ${c(p.ageS)}`,k=p.executors??[],y=p.executorPick??"",_=p.effortOptions??[],j=p.effortPick??"",A=p.pendingAction??"",S=(u,B)=>A===u?`${B}…`:B,K=(u)=>A===u,R=(u)=>A===u?"true":"false";return e`
			${p.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${f}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${w}>${v}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${p.id}
				</button>
				${p.title?e`<div class="title" title=${p.title}>${p.title}</div>`:t}
				${(p.contextLines??[]).map((u)=>e`<div class="ctx" title=${u}>${u}</div>`)}
				${p.parentRef?e`<div class="ctx" title=${`parent ${p.parentRef}`}
							>↳ ${p.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${p.model??""}>${p.model??D}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${p.host??""}>${p.host??D}</b>
					</div>
				</div>
				<hr class="rule" />
				${p.warn?e`<div class="warn" role="note">
							<span class="wl">${G(p.warn)}</span>
							<span class="wt" title=${p.warn}>${Y(p.warn)}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${Q(m?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${X(m?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${ee(m?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${te(m?.cachePct)}</span>
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
							aria-busy=${R("retry")}
							@click=${()=>this.act("retry")}
						>
							${S("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${K("recover")}
							aria-busy=${R("recover")}
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
				${f==="ready"&&k.length?e`<select
							class="seg"
							aria-label=${`executor for ${p.id}`}
							@change=${(u)=>{this.draftExecutor=u.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${k.map((u)=>e`<option
									value=${u.value}
									?selected=${u.value===(this.draftExecutor??y)}
								>
									${u.badge??""}${u.label}
								</option>`)}
						</select>
						${_.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${p.id}`}
									@change=${(u)=>{this.draftEffort=u.target.value,this.draft({effort:this.draftEffort})}}
								>
									${_.map((u)=>e`<option
											value=${u}
											?selected=${u===(this.draftEffort??j)}
										>
											${u}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${K("start")}
							aria-busy=${R("start")}
							@click=${()=>this.act("start",{executor:this.draftExecutor??y,effort:this.draftEffort??j})}
						>
							${S("start","Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${f==="ready"&&!k.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${f==="working"&&!k.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${K("release")}
								aria-busy=${R("release")}
								@click=${()=>this.act("release")}
							>
								${S("release","Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`:t}
				${f==="working"&&k.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${p.id}`}
							@change=${(u)=>{this.draftExecutor=u.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${k.map((u)=>e`<option
									value=${u.value}
									?selected=${u.value===(this.draftExecutor??y)}
								>
									${u.badge??""}${u.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							?disabled=${K("reassign")}
							aria-busy=${R("reassign")}
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??y})}
						>
							${S("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${K("release")}
							aria-busy=${R("release")}
							@click=${()=>this.act("release")}
						>
							${S("release","Release ⏏")}
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
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var x=s(h(o())),C=s(h(d())),le=i({fresh:C,cached:C,out:C,wall_ms:C,model_groups:s(E(o(),b()))}),ce=i({state:o(),observed_at:C,source:x,progress:s(h(i({stage:P(["completed","reviewed","review-blocked","landed"]),ts:C})))}),de=i({text:x}),pe=i({id:o(),project:x,title:x,state:o(),age_s:C,owner_sid:x,owner_label:x,origin:x,model:x,locality:x,parent_id:x,tag_color:x,failure_note:x,wait_kind:x,wait_reason:x,requires:x,blocked_by:s(l(o())),waiting_on:s(l(o())),spend:s(h(le)),execution:s(h(ce)),tail:s(h(de))});class O extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(p){let f=p.spend?.model_groups,m="",v=-1;if(f)for(let[w,k]of Object.entries(f)){let y=typeof k==="object"&&k!==null?Number(k.requests??0):0;if(Number.isFinite(y)&&y>v)m=w,v=y}return m||p.model||void 0}static hostOf(p){let f=p.owner_label?.trim();if(f&&f!==p.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(f))return f;return p.owner_sid??void 0}static metricsOf(p){let f=p.spend;if(!f)return;let m=f.fresh??void 0,v=f.cached??void 0,w=f.out??void 0,k=f.wall_ms??void 0,y=m===void 0&&v===void 0&&w===void 0?void 0:(m??0)+(v??0)+(w??0),_=k!==void 0&&k>0?k/60000:0,j=_>0&&w!==void 0?w/_:void 0,A=(m??0)+(v??0),S=A>0&&v!==void 0?v/A*100:void 0;return{tokens:y,wallMs:k,tokPerMin:j,cachePct:S}}static parentRefOf(p){return p.parent_id??void 0}contextLinesOf(p){let f=[],m=p.execution;if(m){let y=m.progress?.stage;f.push(y?`${m.state} · ${y}`:`${m.state} · no artifact evidence in snapshot`)}if(p.state==="WAITING"&&p.wait_reason)f.push(`${p.wait_kind??"external"} · ${p.wait_reason}`);let v=p.blocked_by??[];if(v.length)f.push(`waiting on ${v.join(", ")}`);let w=p.waiting_on??[];if(w.length)f.push(`split into ${w.join(", ")}`);let k=p.tail?.text?.trim();if(k&&!f.includes(k))f.push(k);return f}modelOf(p){let f={id:p.id,project:p.project??void 0,title:p.title??void 0,state:p.state,ageS:p.age_s??void 0,contextLines:this.contextLinesOf(p),parentRef:O.parentRefOf(p),model:O.modelOf(p),host:O.hostOf(p),warn:p.failure_note??void 0,metrics:O.metricsOf(p),nested:this.hasAttribute("data-nested"),preferColor:p.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},m=J.safeParse(f);return m.success?m.data:null}render(){let p=pe.safeParse(this.t);if(!this.t||!p.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let f=p.data,m=this.modelOf(f);if(!m)return e``;let v=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${O.metricsOf(f)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${m}>${v}</klh-task-card>`}createRenderRoot(){return this}}var fe=()=>{L("klh-task-card-host",O),L("klh-task-card",H),L("klh-card-activity",M)};fe();export{fe as registerBoardElements};
