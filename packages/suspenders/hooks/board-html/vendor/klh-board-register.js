import{_,n,e,t,o}from"./lit-ac8284bbd881cce8.js";import{ue}from"./lit-7b8f9fc495cf0962.js";import{a,k,Se,A,d,u,C,ce,i,x}from"./lit-ea314af12110b1c3.js";import{S,et}from"./lit-0faf10e1680224f0.js";import{v}from"./lit-8a3f11727be01257.js";var Z=new Set,K=(r,s)=>{if(customElements.get(r))throw Error(`defineElement: <${r}> is already defined — ONE register point per workspace`);Z.add(r),customElements.define(r,s)};var D=n`${_(`@charset "UTF-8";
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
}`)}`;class L extends v{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(r,s,c,f){super(L.eventName);this.action=r,this.id=s,this.project=c,this.executor=f?.executor,this.effort=f?.effort}}class j extends v{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(r,s,c){super(j.eventName);this.id=r,this.project=s,this.executor=c?.executor,this.effort=c?.effort}}class N extends v{static eventName="task-card-open-requested";id;project;constructor(r,s){super(N.eventName);this.id=r,this.project=s}}function H(r){if(r==="CLAIMED"||r==="RUNNING")return"working";if(r==="WAITING"||r==="BLOCKED"||r==="PAUSED")return"blocked";if(r==="SHATTERED")return"split";if(r==="FAILED")return"failed";if(r==="DONE")return"done";if(r==="CANCELLED")return"cancelled";return"ready"}function B(r){if(r==="SHATTERED")return"split";return r.toLowerCase()}function F(r){return/^\s*BLOCKED\b/i.test(r)?"blocked":"warning"}function V(r){return r.replace(/^\s*BLOCKED\b[\s:]+/i,"")||r}var b=i(x(a())),y=i(x(k())),te=u({value:a(),label:a(),badge:i(a()),reasoningEffort:i(Se())}),ne=u({tokens:y,wallMs:y,tokPerMin:y,cachePct:y}),re=u({mode:ce(["spend","attempt"]),windowStartMs:y,windowEndMs:y,binMs:y,elapsedMs:y,scaleMs:y}),U=u({id:a(),project:b,title:b,state:a(),ageS:y,contextLines:i(d(a())),parentRef:b,model:b,host:b,warn:b,metrics:i(ne),activity:i(re),nested:i(Se()),preferColor:b,executors:i(d(te)),executorPick:b,effortOptions:i(d(a())),effortPick:b,pendingAction:b});function G(r){if(r==null)return"—";if(r>=1e6)return`${(r/1e6).toFixed(1)}M`;if(r>=1000)return`${Math.round(r/1000)}k`;return String(Math.round(r))}function Y(r){if(r==null)return"—";if(r<60000)return`${Math.round(r/1000)}s`;let s=Math.round(r/60000);if(s>=60)return`${Math.floor(s/60)}h${String(s%60).padStart(2,"0")}m`;return`${s}m`}function J(r){if(r==null)return"—";if(r>=1e6)return`${(r/1e6).toFixed(1)}M`;if(r>=1000)return`${(r/1000).toFixed(1)}k`;return String(Math.round(r))}function Q(r){if(r==null)return"—";return`${Math.round(r)}%`}var q="—";class W extends o{static properties={card:{attribute:!1}};static styles=D;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return H(this.card.state)}open(){this.dispatchEvent(new N(this.card.id,this.card.project??null))}act(r,s){this.dispatchEvent(new L(r,this.card.id,this.card.project??null,s))}draft(r){this.dispatchEvent(new j(this.card.id,this.card.project??null,r))}statusWord(){return B(this.card.state)}render(){let r=this.card,s=this.tone(),c=r.metrics??null,f=r.ageS==null?q:et(r.ageS),g=r.ageS==null?"age unknown":`open ${S(r.ageS)}`,p=r.executors??[],m=r.executorPick??"",P=r.effortOptions??[],R=r.effortPick??"",T=r.pendingAction??"",w=(l,I)=>T===l?`${I}…`:I,M=(l)=>T===l,O=(l)=>T===l?"true":"false";return e`
			${r.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${s}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${g}>${f}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${r.id}
				</button>
				${r.title?e`<div class="title" title=${r.title}>${r.title}</div>`:t}
				${(r.contextLines??[]).map((l)=>e`<div class="ctx" title=${l}>${l}</div>`)}
				${r.parentRef?e`<div class="ctx" title=${`parent ${r.parentRef}`}
							>↳ ${r.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${r.model??""}>${r.model??q}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${r.host??""}>${r.host??q}</b>
					</div>
				</div>
				<hr class="rule" />
				${r.warn?e`<div class="warn" role="note">
							<span class="wl">${F(r.warn)}</span>
							<span class="wt" title=${r.warn}>${V(r.warn)}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${G(c?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${Y(c?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${J(c?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${Q(c?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details" name="details"></slot>
				</div>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${s==="failed"?e`<button
							class="seg retry"
							type="button"
							?disabled=${M("retry")}
							aria-busy=${O("retry")}
							@click=${()=>this.act("retry")}
						>
							${w("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${M("recover")}
							aria-busy=${O("recover")}
							@click=${()=>this.act("recover")}
						>
							${w("recover","Recover → Ready")}
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${()=>this.act("prompt")}
						>
							Prompt ↗
						</button>`:t}
				${s==="ready"&&p.length?e`<select
							class="seg"
							aria-label=${`executor for ${r.id}`}
							@change=${(l)=>{this.draftExecutor=l.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${p.map((l)=>e`<option
									value=${l.value}
									?selected=${l.value===(this.draftExecutor??m)}
								>
									${l.badge??""}${l.label}
								</option>`)}
						</select>
						${P.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${r.id}`}
									@change=${(l)=>{this.draftEffort=l.target.value,this.draft({effort:this.draftEffort})}}
								>
									${P.map((l)=>e`<option
											value=${l}
											?selected=${l===(this.draftEffort??R)}
										>
											${l}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${M("start")}
							aria-busy=${O("start")}
							@click=${()=>this.act("start",{executor:this.draftExecutor??m,effort:this.draftEffort??R})}
						>
							${w("start","Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${s==="ready"&&!p.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${s==="working"&&!p.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${M("release")}
								aria-busy=${O("release")}
								@click=${()=>this.act("release")}
							>
								${w("release","Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`:t}
				${s==="working"&&p.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${r.id}`}
							@change=${(l)=>{this.draftExecutor=l.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${p.map((l)=>e`<option
									value=${l.value}
									?selected=${l.value===(this.draftExecutor??m)}
								>
									${l.badge??""}${l.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							?disabled=${M("reassign")}
							aria-busy=${O("reassign")}
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??m})}
						>
							${w("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${M("release")}
							aria-busy=${O("release")}
							@click=${()=>this.act("release")}
						>
							${w("release","Release ⏏")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${s==="done"?e`<span class="spacer"></span>
						<button
							class="seg tail report"
							type="button"
							title="open this item's report view"
							@click=${()=>this.act("report")}
						>
							Report ▸
						</button>
						${this.promptSeg()}`:t}
				${s!=="failed"&&s!=="ready"&&s!=="working"&&s!=="done"?e`<span class="spacer"></span>${this.promptSeg()}`:t}
			</footer>
		`}promptSeg(){return e`<button
			class="seg tail prompt"
			type="button"
			@click=${()=>this.act("prompt")}
		>
			Prompt ↗
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var h=i(x(a())),E=i(x(k())),ae=u({fresh:E,cached:E,out:E,wall_ms:E,model_groups:i(C(a(),A()))}),se=u({state:a(),observed_at:E,source:h,progress:i(x(u({stage:ce(["completed","reviewed","review-blocked","landed"]),ts:E})))}),oe=u({text:h}),ie=u({id:a(),project:h,title:h,state:a(),age_s:E,owner_sid:h,owner_label:h,origin:h,model:h,locality:h,parent_id:h,tag_color:h,failure_note:h,wait_kind:h,wait_reason:h,requires:h,blocked_by:i(d(a())),waiting_on:i(d(a())),spend:i(x(ae)),execution:i(x(se)),tail:i(x(oe))});class z extends o{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=n``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(r){let s=r.spend?.model_groups,c="",f=-1;if(s)for(let[g,p]of Object.entries(s)){let m=typeof p==="object"&&p!==null?Number(p.requests??0):0;if(Number.isFinite(m)&&m>f)c=g,f=m}return c||r.model||void 0}static hostOf(r){let s=r.owner_label?.trim();if(s&&s!==r.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s))return s;return r.owner_sid??void 0}static metricsOf(r){let s=r.spend;if(!s)return;let c=s.fresh??void 0,f=s.cached??void 0,g=s.out??void 0,p=s.wall_ms??void 0,m=c===void 0&&f===void 0&&g===void 0?void 0:(c??0)+(f??0)+(g??0),P=p!==void 0&&p>0?p/60000:0,R=P>0&&g!==void 0?g/P:void 0,T=(c??0)+(f??0),w=T>0&&f!==void 0?f/T*100:void 0;return{tokens:m,wallMs:p,tokPerMin:R,cachePct:w}}static parentRefOf(r){return r.parent_id??void 0}contextLinesOf(r){let s=[],c=r.execution;if(c){let m=c.progress?.stage;s.push(m?`${c.state} · ${m}`:`${c.state} · no artifact evidence in snapshot`)}if(r.state==="WAITING"&&r.wait_reason)s.push(`${r.wait_kind??"external"} · ${r.wait_reason}`);let f=r.blocked_by??[];if(f.length)s.push(`waiting on ${f.join(", ")}`);let g=r.waiting_on??[];if(g.length)s.push(`split into ${g.join(", ")}`);let p=r.tail?.text?.trim();if(p&&!s.includes(p))s.push(p);return s}modelOf(r){let s={id:r.id,project:r.project??void 0,title:r.title??void 0,state:r.state,ageS:r.age_s??void 0,contextLines:this.contextLinesOf(r),parentRef:z.parentRefOf(r),model:z.modelOf(r),host:z.hostOf(r),warn:r.failure_note??void 0,metrics:z.metricsOf(r),nested:this.hasAttribute("data-nested"),preferColor:r.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},c=U.safeParse(s);return c.success?c.data:null}render(){let r=ie.safeParse(this.t);if(!this.t||!r.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let s=r.data,c=this.modelOf(s);if(!c)return e``;let f=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${z.metricsOf(s)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${c}>${f}</klh-task-card>`}createRenderRoot(){return this}}var le=()=>{K("klh-task-card-host",z),K("klh-task-card",W),K("klh-card-activity",ue)};le();export{le as registerBoardElements};
