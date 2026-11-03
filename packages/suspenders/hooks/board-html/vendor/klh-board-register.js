import{d,r,e,x,n}from"./lit-9ab93f5debb235da.js";import{R,S}from"./lit-f41e4e68109f9bf1.js";import{s,c,m,a,i,g,w,o,u}from"./lit-42c6a144d6343828.js";import{f,O,M,P,Z}from"./lit-9fc84bcd57e604e3.js";var ct=new Set,N=(t,l)=>{if(customElements.get(t))throw Error(`defineElement: <${t}> is already defined — ONE register point per workspace`);ct.add(t),customElements.define(t,l)};var W=1.5;function dt(t,l,h,p=180000){let b=Array.from({length:h},()=>null);for(let _ of t){let v=Math.floor((_[0]-l)/p);if(v>h-1)v=h-1;if(v<0)continue;let k=b[v];if(k==null)k={fresh:0,cached:0,out:0},b[v]=k;k.fresh+=_[1],k.cached+=_[2],k.out+=_[3]}return b}function ut(t,l,h=6,p=180000){let b=Math.max(1,Math.floor(l/h)),_=t;return{count:b,slotMs:p,start:_-b*p,end:_}}var mt={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function Q(t,l,h){if(!t.length)return mt;let{POSITIVE_INFINITY:p,NEGATIVE_INFINITY:b}=Number;for(let E of t){if(E[0]<p)p=E[0];if(E[0]>b)b=E[0]}let _=ut(b,l),v=h??Math.max(_.start,p),k=Math.ceil((b-v)/_.slotMs)+1,y=Math.max(1,Math.min(_.count,k));return{bins:dt(t,v,y),firstTs:p,windowStart:v,windowEnd:v+y*_.slotMs,count:y,slotMs:_.slotMs,startClipped:v>p,hasData:!0}}function L(t){let l=new Date(t),h=(p)=>String(p).padStart(2,"0");return`${h(l.getHours())}:${h(l.getMinutes())}`}function Y(t,l,h=86400000){let p=l/2;if(t===null||t===void 0)return{visible:!1,center:p,half:0,start:p,end:p,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:p,half:0,start:p,end:p,saturated:!1};let b=Math.min(l/2,t/h*(l/2));return{visible:!0,center:p,half:b,start:p-b,end:p+b,saturated:t>=h}}function A(t){if(!Number.isFinite(t)||t<=0)return"0m";let l=Math.round(t/60000);if(l<60)return`${l}m`;return`${Math.floor(l/60)}h ${String(l%60).padStart(2,"0")}m`}function D(t=86400000){return`${t/3600000}h`}function H(t,l,h,p){let b=Math.max(1,h-l),_=(t-l)/b*p;return Math.max(0,Math.min(p,_))}function B(t){let l=[];for(let p of t.attempt.segments){if(p.end<=p.start)continue;l.push({kind:p.kind,start:p.start,end:p.end})}let h=[];for(let p of t.milestones){if(p.ts<t.windowStart||p.ts>t.windowEnd)continue;h.push({kind:"milestone",start:p.ts,end:p.ts,commit:p.commit,stage:p.stage})}return{segs:l,milestones:h}}function tt(t,l,h,p,b){for(let _ of t.milestones){let v=H(_.start,h,p,b);if(Math.abs(l-v)<=6)return _}for(let _ of t.segs){let v=H(_.start,h,p,b),k=H(_.end,h,p,b);if(l>=v&&l<=Math.max(k,v+1))return _}return null}function K(t,l,h,p){if(t.kind==="milestone")return[`artifact · ${t.stage??""}`,h(t.start),`commit ${t.commit??""}`].join(`
`);let b=[`${t.kind} · ${p(t.end-t.start)}`,h(t.start,t.end)];if(t.kind==="firstbyte")b.push("first attributed ledger request — not network latency");if(t.kind==="tool")b.push("request-row minutes — not tool-call duration");if(t.kind==="unknown")b.push("no fact covers this gap");return b.push(`attempt ${l.attempt.index} · ${l.attempt.sid}`),b.join(`
`)}var j=13,U=14,z=5;function nt(t){let l=t.attempt.claimEnd??t.windowEnd,h=Math.min(l,t.windowEnd)-t.attempt.claimStart;return h>0?h:null}function V(t,l){return l===void 0?f(t):Z(t,l).join(`
`)}function ht(t,l){let{segs:h,milestones:p}=B(t),b=[];for(let _ of h){let v=H(_.start,t.windowStart,t.windowEnd,l),k=Math.max(v+1,H(_.end,t.windowStart,t.windowEnd,l));b.push(x`<rect
				class="at-${_.kind}"
				x=${v.toFixed(1)}
				y=${j}
				width=${(k-v).toFixed(1)}
				height=${U}
				rx="2"
			/>`)}for(let _ of p){let v=H(_.start,t.windowStart,t.windowEnd,l),k=j+U/2;b.push(x`<path
				class="at-ms"
				d="M ${v.toFixed(1)},${(k-z).toFixed(1)} l ${z},${z} l -${z},${z} l -${z},-${z} Z"
			/>`)}return e`${b}`}var et=(t)=>({kind:t.kind,start:t.start});function it(t){return{hover:(p,b)=>{let _=p.currentTarget;if(!b||!_){t.hide();return}let v=_.getBoundingClientRect();if(v.width===0)return;let k=tt(B(b),p.clientX-v.left,b.windowStart,b.windowEnd,v.width);if(!k){t.hide();return}t.setTip(K(k,b,V,A),-1,et(k)),t.placeTip(p.clientX,p.clientY)},hide:()=>t.hide(),keydown:(p,b)=>{if(p.key==="Escape"){t.hide(),p.target.blur();return}if(p.key!=="ArrowLeft"&&p.key!=="ArrowRight")return;p.preventDefault();let _=t.slot(),{milestones:v,segs:k}=B(b),y=[...v,...k];if(!y.length)return;let E=p.key==="ArrowLeft"?-1:1,F=Math.max(0,Math.min(y.length-1,_+E)),q=y[F];if(!q)return;t.setTip(K(q,b,V,A),F,et(q));let J=p.currentTarget;if(J){let G=J.getBoundingClientRect(),lt=H(q.start,b.windowStart,b.windowEnd,G.width);t.placeTip(G.left+lt,G.top+8)}},slot:()=>t.slot()}}function st(t,l){return e`<div class="axis">
		<span>${L(t.windowStart)}</span>
		<span>${l} · ${t.binMs/60000}m/bin</span>
		<span>${L(t.windowEnd)}</span>
	</div>`}function rt(t,l,h){return e`<svg
		class="plot"
		viewBox="0 0 ${l} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${t.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(p)=>h.hover(p,t)}
		@pointerleave=${()=>h.hide()}
		@keydown=${(p)=>h.keydown(p,t)}
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
`;var at=r`${d(`@charset "UTF-8";
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
}`)}`;class X extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[at,ot];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let l=this._plotEl()?.clientWidth??0;if(l!==this._width)this._width=l,this.requestUpdate()});let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}updated(){let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}update(t){if(super.update(t),!t.has("points")&&!t.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:p,segs:b}=B(this.attempt),_=[...p,...b],v=this._tipRef,k=_.findIndex((y)=>y.kind===v.kind&&y.start===v.start);if(k<0){this._hideTip();return}this._tip=K(_[k],this.attempt,V,A),this._slot=k;return}let l=this._spec;if(!l.hasData||this._tipTs===null){if(!l.hasData)this._hideTip();return}let h=Math.floor((this._tipTs-(l.windowStart??0))/l.slotMs);if(h<0||h>=l.count){this._hideTip();return}this._slot=h,this._tip=this._tipText(l,h)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return Q(this.points,this._width||240)}_hover=(t)=>{let l=this._plotEl(),h=this._spec;if(!l||!h.hasData){this._hideTip();return}let p=l.getBoundingClientRect();if(p.width===0)return;let b=Math.max(0,Math.min(h.count-1,Math.floor((t.clientX-p.left)/p.width*h.count)));this._slot=b,this._tip=this._tipText(h,b),this._tipTs=(h.windowStart??0)+b*h.slotMs,this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let l=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let h=t.key==="ArrowLeft"?-1:1,p=Math.max(0,Math.min(l.count-1,this._slot+h));this._slot=p,this._tip=this._tipText(l,p),this._tipTs=(l.windowStart??0)+p*l.slotMs,this.requestUpdate();let b=this._plotEl();if(b){let _=b.getBoundingClientRect();this._placeTip(_.left+(p+0.5)/l.count*_.width,_.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(t,l){let h=t.bins[l],p=(t.windowStart??0)+l*t.slotMs,b=[f(p),`${O(p,M(p)!==P(p))} · ${t.slotMs/60000}-minute bin`];if(h)b.push(`Fresh input ${h.fresh.toLocaleString("en-US")}`),b.push(`Cached input ${h.cached.toLocaleString("en-US")}`),b.push(`Output ${h.out.toLocaleString("en-US")}`);else b.push("no requests in this bin");return b.join(`
`)}_barsSvg(t){let h=(this._width||240)/t.count,p=0;for(let _ of t.bins)if(_)p=Math.max(p,_.fresh+_.cached);let b=[];if(p>0)for(let _=0;_<t.count;_++){let v=t.bins[_];if(!v)continue;let k=_*h+(h-W)/2;b.push(this._barRects(v,k,p))}if(!b.length)return e``;return x`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${b}`}_barRects(t,l,h){let b=[],_=0,v=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[k,y]of v){if(k<=0)continue;let E=Math.max(0.5,k/h*38);b.push(x`<rect
					class=${y}
					x=${l.toFixed(1)}
					y=${Math.max(1,39-_-E).toFixed(1)}
					width=${W}
					height=${E.toFixed(1)}
				/>`),_+=E}return e`${b}`}_hairlineHtml(){let t=this._width||240,l=Y(this._hairWallMs(),t);if(!l.visible)return null;return e`<div
			class="hairline${l.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${A(this._hairWallMs()??0)} of ${D()} scale${l.saturated?" — saturated at full width":""}"
			title="elapsed ${A(this._hairWallMs()??0)} of ${D()} scale${l.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${l.start.toFixed(1)}px;width:${(l.end-l.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let t=this._width||240,l=Y(this._hairWallMs(),t);if(!l.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${A(this._hairWallMs()??0)} of ${D()} scale`+(l.saturated?" — saturated at full width":""),this.requestUpdate();let h=this._plotEl()?.getBoundingClientRect();if(h)this._placeTip(h.left+l.center/Math.max(1,t)*h.width,h.bottom+2)};_hairKey=(t)=>{if(t.key==="Escape")this._hideTip(),this.requestUpdate(),t.target.blur()};_axisHtml(t){let l=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?L(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${l} · ${t.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${t.hasData?L(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),l=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(l/60)).padStart(2,"0")}:${String(l%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,l){let h=()=>{let b=this.renderRoot.querySelector(".tip");if(!b)return;let _=Math.min(t+10,window.innerWidth-b.offsetWidth-8),v=l-b.offsetHeight-10;b.style.left=`${Math.max(8,_)}px`,b.style.top=`${v>=8?v:l+12}px`};if(this.renderRoot.querySelector(".tip")){h();return}this.updateComplete.then(h).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?nt(this.attempt):this.wallMs}get _stripHost(){return{setTip:(t,l,h)=>{this._tip=t,this._slot=l,this._tipRef=h??null,this.requestUpdate()},placeTip:(t,l)=>this._placeTip(t,l),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=it(this._stripHost);_renderAttempt(){let t=this.attempt,l=this._width||240;if(!t)return e`<div class="attempt-empty" role="img">
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
		`}}var T=o(u(s())),C=o(u(c())),ft=i({fresh:C,cached:C,out:C,wall_ms:C,model_groups:o(g(s(),m()))}),bt=i({state:s(),observed_at:C,source:T,progress:o(u(i({stage:w(["completed","reviewed","review-blocked","landed"]),ts:C})))}),_t=i({text:T}),gt=i({id:s(),project:T,title:T,state:s(),age_s:C,owner_sid:T,owner_label:T,origin:T,model:T,locality:T,parent_id:T,tag_color:T,failure_note:T,wait_kind:T,wait_reason:T,requires:T,blocked_by:o(a(s())),waiting_on:o(a(s())),spend:o(u(ft)),execution:o(u(bt)),tail:o(u(_t))});class I extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(t){let l=t.spend?.model_groups,h="",p=-1;if(l)for(let[b,_]of Object.entries(l)){let v=typeof _==="object"&&_!==null?Number(_.requests??0):0;if(Number.isFinite(v)&&v>p)h=b,p=v}return h||t.model||void 0}static hostOf(t){let l=t.owner_label?.trim();if(l&&l!==t.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(l))return l;return t.owner_sid??void 0}static metricsOf(t){let l=t.spend;if(!l)return;let h=l.fresh??void 0,p=l.cached??void 0,b=l.out??void 0,_=l.wall_ms??void 0,v=h===void 0&&p===void 0&&b===void 0?void 0:(h??0)+(p??0)+(b??0),k=_!==void 0&&_>0?_/60000:0,y=k>0&&b!==void 0?b/k:void 0,E=(h??0)+(p??0),F=E>0&&p!==void 0?p/E*100:void 0;return{tokens:v,wallMs:_,tokPerMin:y,cachePct:F}}static parentRefOf(t){return t.parent_id??void 0}contextLinesOf(t){let l=[],h=t.execution;if(h){let v=h.progress?.stage;l.push(v?`${h.state} · ${v}`:`${h.state} · no artifact evidence in snapshot`)}if(t.state==="WAITING"&&t.wait_reason)l.push(`${t.wait_kind??"external"} · ${t.wait_reason}`);let p=t.blocked_by??[];if(p.length)l.push(`waiting on ${p.join(", ")}`);let b=t.waiting_on??[];if(b.length)l.push(`split into ${b.join(", ")}`);if(l.length)return l;let _=t.tail?.text?.trim();return _?[_]:[]}modelOf(t){let l={id:t.id,project:t.project??void 0,title:t.title??void 0,state:t.state,ageS:t.age_s??void 0,contextLines:this.contextLinesOf(t),parentRef:I.parentRefOf(t),model:I.modelOf(t),host:I.hostOf(t),warn:t.failure_note??void 0,metrics:I.metricsOf(t),nested:this.hasAttribute("data-nested"),preferColor:t.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},h=R.safeParse(l);return h.success?h.data:null}render(){let t=gt.safeParse(this.t);if(!this.t||!t.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let l=t.data,h=this.modelOf(l);if(!h)return e``;let p=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${I.metricsOf(l)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${h}>${p}</klh-task-card>`}createRenderRoot(){return this}}var vt=()=>{N("klh-task-card-host",I),N("klh-task-card",S),N("klh-card-activity",X)};vt();export{vt as registerBoardElements};
