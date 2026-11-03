import{h,r,e,E,n}from"./lit-b59bf30faa0b21f8.js";import{D,A}from"./lit-0b5ca7a5ab2a8466.js";import{o,c,b,a,i,y,T,s,d}from"./lit-2f69bfe86efc9f7c.js";import{k,N,O,Z,j}from"./lit-70c8b7a6a0a2f23a.js";var ct=new Set,P=(t,l)=>{if(customElements.get(t))throw Error(`defineElement: <${t}> is already defined — ONE register point per workspace`);ct.add(t),customElements.define(t,l)};var G=1.5;function dt(t,l,u,p=180000){let m=Array.from({length:u},()=>null);for(let f of t){let _=Math.floor((f[0]-l)/p);if(_>u-1)_=u-1;if(_<0)continue;let g=m[_];if(g==null)g={fresh:0,cached:0,out:0},m[_]=g;g.fresh+=f[1],g.cached+=f[2],g.out+=f[3]}return m}function ut(t,l,u=6,p=180000){let m=Math.max(1,Math.floor(l/u)),f=t;return{count:m,slotMs:p,start:f-m*p,end:f}}var mt={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function Q(t,l,u){if(!t.length)return mt;let{POSITIVE_INFINITY:p,NEGATIVE_INFINITY:m}=Number;for(let w of t){if(w[0]<p)p=w[0];if(w[0]>m)m=w[0]}let f=ut(m,l),_=u??Math.max(f.start,p),g=Math.ceil((m-_)/f.slotMs)+1,x=Math.max(1,Math.min(f.count,g));return{bins:dt(t,_,x),firstTs:p,windowStart:_,windowEnd:_+x*f.slotMs,count:x,slotMs:f.slotMs,startClipped:_>p,hasData:!0}}function I(t){let l=new Date(t),u=(p)=>String(p).padStart(2,"0");return`${u(l.getHours())}:${u(l.getMinutes())}`}function W(t,l,u=86400000){let p=l/2;if(t===null||t===void 0)return{visible:!1,center:p,half:0,start:p,end:p,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:p,half:0,start:p,end:p,saturated:!1};let m=Math.min(l/2,t/u*(l/2));return{visible:!0,center:p,half:m,start:p-m,end:p+m,saturated:t>=u}}function S(t){if(!Number.isFinite(t)||t<=0)return"0m";let l=Math.round(t/60000);if(l<60)return`${l}m`;return`${Math.floor(l/60)}h ${String(l%60).padStart(2,"0")}m`}function F(t=86400000){return`${t/3600000}h`}function M(t,l,u,p){let m=Math.max(1,u-l),f=(t-l)/m*p;return Math.max(0,Math.min(p,f))}function C(t){let l=[];for(let p of t.attempt.segments){if(p.end<=p.start)continue;l.push({kind:p.kind,start:p.start,end:p.end})}let u=[];for(let p of t.milestones){if(p.ts<t.windowStart||p.ts>t.windowEnd)continue;u.push({kind:"milestone",start:p.ts,end:p.ts,commit:p.commit,stage:p.stage})}return{segs:l,milestones:u}}function tt(t,l,u,p,m){for(let f of t.milestones){let _=M(f.start,u,p,m);if(Math.abs(l-_)<=6)return f}for(let f of t.segs){let _=M(f.start,u,p,m),g=M(f.end,u,p,m);if(l>=_&&l<=Math.max(g,_+1))return f}return null}function L(t,l,u,p){if(t.kind==="milestone")return[`artifact · ${t.stage??""}`,u(t.start),`commit ${t.commit??""}`].join(`
`);let m=[`${t.kind} · ${p(t.end-t.start)}`,u(t.start,t.end)];if(t.kind==="firstbyte")m.push("first attributed ledger request — not network latency");if(t.kind==="tool")m.push("request-row minutes — not tool-call duration");if(t.kind==="unknown")m.push("no fact covers this gap");return m.push(`attempt ${l.attempt.index} · ${l.attempt.sid}`),m.join(`
`)}var Y=13,U=14,R=5;function nt(t){let l=t.attempt.claimEnd??t.windowEnd,u=Math.min(l,t.windowEnd)-t.attempt.claimStart;return u>0?u:null}function q(t,l){return l===void 0?k(t):j(t,l).join(`
`)}function ht(t,l){let{segs:u,milestones:p}=C(t),m=[];for(let f of u){let _=M(f.start,t.windowStart,t.windowEnd,l),g=Math.max(_+1,M(f.end,t.windowStart,t.windowEnd,l));m.push(E`<rect
				class="at-${f.kind}"
				x=${_.toFixed(1)}
				y=${Y}
				width=${(g-_).toFixed(1)}
				height=${U}
				rx="2"
			/>`)}for(let f of p){let _=M(f.start,t.windowStart,t.windowEnd,l),g=Y+U/2;m.push(E`<path
				class="at-ms"
				d="M ${_.toFixed(1)},${(g-R).toFixed(1)} l ${R},${R} l -${R},${R} l -${R},-${R} Z"
			/>`)}return e`${m}`}var et=(t)=>({kind:t.kind,start:t.start});function it(t){return{hover:(p,m)=>{let f=p.currentTarget;if(!m||!f){t.hide();return}let _=f.getBoundingClientRect();if(_.width===0)return;let g=tt(C(m),p.clientX-_.left,m.windowStart,m.windowEnd,_.width);if(!g){t.hide();return}t.setTip(L(g,m,q,S),-1,et(g)),t.placeTip(p.clientX,p.clientY)},hide:()=>t.hide(),keydown:(p,m)=>{if(p.key==="Escape"){t.hide(),p.target.blur();return}if(p.key!=="ArrowLeft"&&p.key!=="ArrowRight")return;p.preventDefault();let f=t.slot(),{milestones:_,segs:g}=C(m),x=[..._,...g];if(!x.length)return;let w=p.key==="ArrowLeft"?-1:1,B=Math.max(0,Math.min(x.length-1,f+w)),K=x[B];if(!K)return;t.setTip(L(K,m,q,S),B,et(K));let J=p.currentTarget;if(J){let V=J.getBoundingClientRect(),lt=M(K.start,m.windowStart,m.windowEnd,V.width);t.placeTip(V.left+lt,V.top+8)}},slot:()=>t.slot()}}function st(t,l){return e`<div class="axis">
		<span>${I(t.windowStart)}</span>
		<span>${l} · ${t.binMs/60000}m/bin</span>
		<span>${I(t.windowEnd)}</span>
	</div>`}function rt(t,l,u){return e`<svg
		class="plot"
		viewBox="0 0 ${l} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${t.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(p)=>u.hover(p,t)}
		@pointerleave=${()=>u.hide()}
		@keydown=${(p)=>u.keydown(p,t)}
	>
		${ht(t,l)}
	</svg>`}var ot=r`
	.plot rect.at-queue {
		fill: var(--klh-chart-axis, #898781);
	}
	.plot rect.at-firstbyte {
		fill: var(--klh-accent, #d8900f);
	}
	.plot rect.at-tool {
		fill: var(--klh-ok, #5c7a35);
	}
	.plot rect.at-pause {
		fill: var(--klh-warn, #b8860b);
	}
	.plot rect.at-unknown {
		fill: var(--klh-edge, rgba(128, 128, 128, 0.35));
	}
	.plot path.at-ms {
		fill: var(--klh-ink, #e8e6e1);
		stroke: var(--klh-edge, rgba(255, 255, 255, 0.4));
		stroke-width: 0.5;
	}
	.attempt-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 40px;
		font: 400 11px/1.5 ui-monospace, SFMono-Regular, monospace;
		color: var(--klh-chart-axis, #898781);
	}
`;var at=r`${h(`@charset "UTF-8";
:host {
  display: block;
  font: 11px/1.5 ui-sans-serif, system-ui;
}

.plot {
  display: block;
  width: 100%;
  height: 40px;
}

.plot:focus-visible {
  outline: 2px solid var(--klh-accent, #d8900f);
  outline-offset: 1px;
}

/* W2267.4.2.2 spectral treatment (owner-approved 09 spec): thin
   crisp real-bin marks, green/teal spectrum, low-opacity upward
   fade — semantic chart tokens, honest bins only. */
/* W2267.4.2.2 spectral treatment (owner-approved 09 spec): thin crisp
   real-bin strokes, teal fresh over green cached, fading upward via
   ONE shared linearGradient per role (objectBoundingBox: each bar
   fades along its own height) — semantic chart tokens, honest bins
   only, no fake upsampling. Identical defs across strips make the
   duplicate-id resolution benign (first match wins, all equal). */
.plot rect.spark-fresh {
  fill: url(#klh-spec-fresh);
}

.plot rect.spark-cached {
  fill: url(#klh-spec-cached);
}

.axis {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 0;
  font: 400 10px/12px ui-monospace, SFMono-Regular, monospace;
  color: var(--klh-chart-axis, #898781);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
}

/* the duration hairline: exactly 1 CSS px, zero own margin/padding,
   flush under the plot's bottom edge (owner tight-rail contract). */
.hairline {
  display: block;
  height: 1px;
  margin: 0;
  padding: 0;
  background: transparent;
  position: relative;
}

.hairline .span {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--klh-accent, #d8900f);
}

.hairline.saturated .span {
  background: var(--klh-danger, #af2f12);
}

/* B2 (W2514): the hairline carries exact duration text — keyboard
   focus must be visible, same ring as the plot. */
.hairline:focus-visible {
  outline: 2px solid var(--klh-accent, #d8900f);
  outline-offset: 1px;
}

.tip {
  position: fixed;
  z-index: 1000;
  max-width: 260px;
  padding: 6px 8px;
  border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  background: var(--klh-surface, #1c1b19);
  color: var(--klh-ink, #e8e6e1);
  font: 11px/1.5 ui-monospace, SFMono-Regular, monospace;
  white-space: pre-line;
  pointer-events: none;
}`)}`;class X extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[at,ot];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let l=this._plotEl()?.clientWidth??0;if(l!==this._width)this._width=l,this.requestUpdate()});let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}updated(){let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}update(t){if(super.update(t),!t.has("points")&&!t.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:p,segs:m}=C(this.attempt),f=[...p,...m],_=this._tipRef,g=f.findIndex((x)=>x.kind===_.kind&&x.start===_.start);if(g<0){this._hideTip();return}this._tip=L(f[g],this.attempt,q,S),this._slot=g;return}let l=this._spec;if(!l.hasData||this._tipTs===null){if(!l.hasData)this._hideTip();return}let u=Math.floor((this._tipTs-(l.windowStart??0))/l.slotMs);if(u<0||u>=l.count){this._hideTip();return}this._slot=u,this._tip=this._tipText(l,u)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return Q(this.points,this._width||240)}_hover=(t)=>{let l=this._plotEl(),u=this._spec;if(!l||!u.hasData){this._hideTip();return}let p=l.getBoundingClientRect();if(p.width===0)return;let m=Math.max(0,Math.min(u.count-1,Math.floor((t.clientX-p.left)/p.width*u.count)));this._slot=m,this._tip=this._tipText(u,m),this._tipTs=(u.windowStart??0)+m*u.slotMs,this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let l=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let u=t.key==="ArrowLeft"?-1:1,p=Math.max(0,Math.min(l.count-1,this._slot+u));this._slot=p,this._tip=this._tipText(l,p),this._tipTs=(l.windowStart??0)+p*l.slotMs,this.requestUpdate();let m=this._plotEl();if(m){let f=m.getBoundingClientRect();this._placeTip(f.left+(p+0.5)/l.count*f.width,f.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(t,l){let u=t.bins[l],p=(t.windowStart??0)+l*t.slotMs,m=[k(p),`${N(p,O(p)!==Z(p))} · ${t.slotMs/60000}-minute bin`];if(u)m.push(`Fresh input ${u.fresh.toLocaleString("en-US")}`),m.push(`Cached input ${u.cached.toLocaleString("en-US")}`),m.push(`Output ${u.out.toLocaleString("en-US")}`);else m.push("no requests in this bin");return m.join(`
`)}_barsSvg(t){let u=(this._width||240)/t.count,p=0;for(let f of t.bins)if(f)p=Math.max(p,f.fresh+f.cached);let m=[];if(p>0)for(let f=0;f<t.count;f++){let _=t.bins[f];if(!_)continue;let g=f*u+(u-G)/2;m.push(this._barRects(_,g,p))}if(!m.length)return e``;return E`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${m}`}_barRects(t,l,u){let m=[],f=0,_=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[g,x]of _){if(g<=0)continue;let w=Math.max(0.5,g/u*38);m.push(E`<rect
					class=${x}
					x=${l.toFixed(1)}
					y=${Math.max(1,39-f-w).toFixed(1)}
					width=${G}
					height=${w.toFixed(1)}
				/>`),f+=w}return e`${m}`}_hairlineHtml(){let t=this._width||240,l=W(this._hairWallMs(),t);if(!l.visible)return null;return e`<div
			class="hairline${l.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${S(this._hairWallMs()??0)} of ${F()} scale${l.saturated?" — saturated at full width":""}"
			title="elapsed ${S(this._hairWallMs()??0)} of ${F()} scale${l.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${l.start.toFixed(1)}px;width:${(l.end-l.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let t=this._width||240,l=W(this._hairWallMs(),t);if(!l.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${S(this._hairWallMs()??0)} of ${F()} scale`+(l.saturated?" — saturated at full width":""),this.requestUpdate();let u=this._plotEl()?.getBoundingClientRect();if(u)this._placeTip(u.left+l.center/Math.max(1,t)*u.width,u.bottom+2)};_hairKey=(t)=>{if(t.key==="Escape")this._hideTip(),this.requestUpdate(),t.target.blur()};_axisHtml(t){let l=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?I(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${l} · ${t.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${t.hasData?I(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),l=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(l/60)).padStart(2,"0")}:${String(l%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,l){let u=()=>{let m=this.renderRoot.querySelector(".tip");if(!m)return;let f=Math.min(t+10,window.innerWidth-m.offsetWidth-8),_=l-m.offsetHeight-10;m.style.left=`${Math.max(8,f)}px`,m.style.top=`${_>=8?_:l+12}px`};if(this.renderRoot.querySelector(".tip")){u();return}this.updateComplete.then(u).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?nt(this.attempt):this.wallMs}get _stripHost(){return{setTip:(t,l,u)=>{this._tip=t,this._slot=l,this._tipRef=u??null,this.requestUpdate()},placeTip:(t,l)=>this._placeTip(t,l),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=it(this._stripHost);_renderAttempt(){let t=this.attempt,l=this._width||240;if(!t)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${rt(t,l,this._attemptHandlers)}
			${this._hairlineHtml()}
			${st(t,this._tzLabel())}
			${this._tip?this._tipHtml():null}
		`}render(){if(this.mode==="attempt")return this._renderAttempt();let t=this._spec;return e`
			<svg
				class="plot"
				viewBox="0 0 ${this._width||240} 40"
				preserveAspectRatio="none"
				role="img"
				aria-label="Fresh and cached input tokens in ${t.slotMs/60000}-minute bins across the measured track"
				tabindex="0"
				@pointermove=${this._hover}
				@pointerleave=${this._hide}
				@keydown=${this._keyNav}
			>
				${this._barsSvg(t)}
			</svg>
			${this._hairlineHtml()}
			${this._axisHtml(t)}
			${this._tip?this._tipHtml():null}
		`}}var v=s(d(o())),z=s(d(c())),ft=i({fresh:z,cached:z,out:z,wall_ms:z,model_groups:s(y(o(),b()))}),bt=i({state:o(),observed_at:z,source:v,progress:s(d(i({stage:T(["completed","reviewed","review-blocked","landed"]),ts:z})))}),_t=i({text:v}),gt=i({id:o(),project:v,title:v,state:o(),age_s:z,owner_sid:v,owner_label:v,origin:v,model:v,locality:v,parent_id:v,tag_color:v,failure_note:v,wait_kind:v,wait_reason:v,requires:v,blocked_by:s(a(o())),waiting_on:s(a(o())),spend:s(d(ft)),execution:s(d(bt)),tail:s(d(_t))});class H extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(t){let l=t.spend?.model_groups,u="",p=-1;if(l)for(let[m,f]of Object.entries(l)){let _=typeof f==="object"&&f!==null?Number(f.requests??0):0;if(Number.isFinite(_)&&_>p)u=m,p=_}return u||t.model||void 0}static hostOf(t){let l=t.owner_label?.trim();if(l&&l!==t.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(l))return l;return t.owner_sid??void 0}static metricsOf(t){let l=t.spend;if(!l)return;let u=l.fresh??void 0,p=l.cached??void 0,m=l.out??void 0,f=l.wall_ms??void 0,_=u===void 0&&p===void 0&&m===void 0?void 0:(u??0)+(p??0)+(m??0),g=f!==void 0&&f>0?f/60000:0,x=g>0&&m!==void 0?m/g:void 0,w=(u??0)+(p??0),B=w>0&&p!==void 0?p/w*100:void 0;return{tokens:_,wallMs:f,tokPerMin:x,cachePct:B}}static parentRefOf(t){return t.parent_id??void 0}contextLinesOf(t){let l=[],u=t.execution;if(u){let _=u.progress?.stage;l.push(_?`${u.state} · ${_}`:`${u.state} · no artifact evidence in snapshot`)}if(t.state==="WAITING"&&t.wait_reason)l.push(`${t.wait_kind??"external"} · ${t.wait_reason}`);let p=t.blocked_by??[];if(p.length)l.push(`waiting on ${p.join(", ")}`);let m=t.waiting_on??[];if(m.length)l.push(`split into ${m.join(", ")}`);if(l.length)return l;let f=t.tail?.text?.trim();return f?[f]:[]}modelOf(t){let l={id:t.id,project:t.project??void 0,title:t.title??void 0,state:t.state,ageS:t.age_s??void 0,contextLines:this.contextLinesOf(t),parentRef:H.parentRefOf(t),model:H.modelOf(t),host:H.hostOf(t),warn:t.failure_note??void 0,metrics:H.metricsOf(t),nested:this.hasAttribute("data-nested"),preferColor:t.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},u=D.safeParse(l);return u.success?u.data:null}render(){let t=gt.safeParse(this.t);if(!this.t||!t.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let l=t.data,u=this.modelOf(l);if(!u)return e``;let p=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${H.metricsOf(l)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${u}>${p}</klh-task-card>`}createRenderRoot(){return this}}var vt=()=>{P("klh-task-card-host",H),P("klh-task-card",A),P("klh-card-activity",X)};vt();export{vt as registerBoardElements};
