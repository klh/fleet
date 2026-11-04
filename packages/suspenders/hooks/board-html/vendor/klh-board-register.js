import{h,r,e,E,t,n}from"./lit-b59bf30faa0b21f8.js";import{o,u,P,b,a,i,x,z,s,p}from"./lit-dbb2e415bb54e58a.js";import{m,Z}from"./lit-fa2d59eb76085ea2.js";import{c}from"./lit-d4f1cb4c1f513c55.js";import{k,U,C,O,F}from"./lit-d109c83208056758.js";var zt=new Set,Y=(l,d)=>{if(customElements.get(l))throw Error(`defineElement: <${l}> is already defined — ONE register point per workspace`);zt.add(l),customElements.define(l,d)};var rt=1.5;function Rt(l,d,g,f=180000){let v=Array.from({length:g},()=>null);for(let y of l){let w=Math.floor((y[0]-d)/f);if(w>g-1)w=g-1;if(w<0)continue;let T=v[w];if(T==null)T={fresh:0,cached:0,out:0},v[w]=T;T.fresh+=y[1],T.cached+=y[2],T.out+=y[3]}return v}function Ct(l,d,g=6,f=180000){let v=Math.max(1,Math.floor(d/g)),y=l;return{count:v,slotMs:f,start:y-v*f,end:y}}var Ht={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function pt(l,d,g){if(!l.length)return Ht;let{POSITIVE_INFINITY:f,NEGATIVE_INFINITY:v}=Number;for(let M of l){if(M[0]<f)f=M[0];if(M[0]>v)v=M[0]}let y=Ct(v,d),w=g??Math.max(y.start,f),T=Math.ceil((v-w)/y.slotMs)+1,S=Math.max(1,Math.min(y.count,T));return{bins:Rt(l,w,S),firstTs:f,windowStart:w,windowEnd:w+S*y.slotMs,count:S,slotMs:y.slotMs,startClipped:w>f,hasData:!0}}function W(l){let d=new Date(l),g=(f)=>String(f).padStart(2,"0");return`${g(d.getHours())}:${g(d.getMinutes())}`}function st(l,d,g=86400000){let f=d/2;if(l===null||l===void 0)return{visible:!1,center:f,half:0,start:f,end:f,saturated:!1};if(!Number.isFinite(l)||l<=0)return{visible:!1,center:f,half:0,start:f,end:f,saturated:!1};let v=Math.min(d/2,l/g*(d/2));return{visible:!0,center:f,half:v,start:f-v,end:f+v,saturated:l>=g}}function K(l){if(!Number.isFinite(l)||l<=0)return"0m";let d=Math.round(l/60000);if(d<60)return`${d}m`;return`${Math.floor(d/60)}h ${String(d%60).padStart(2,"0")}m`}function J(l=86400000){return`${l/3600000}h`}function D(l,d,g,f){let v=Math.max(1,g-d),y=(l-d)/v*f;return Math.max(0,Math.min(f,y))}function V(l){let d=[];for(let f of l.attempt.segments){if(f.end<=f.start)continue;d.push({kind:f.kind,start:f.start,end:f.end})}let g=[];for(let f of l.milestones){if(f.ts<l.windowStart||f.ts>l.windowEnd)continue;g.push({kind:"milestone",start:f.ts,end:f.ts,commit:f.commit,stage:f.stage})}return{segs:d,milestones:g}}function dt(l,d,g,f,v){for(let y of l.milestones){let w=D(y.start,g,f,v);if(Math.abs(d-w)<=6)return y}for(let y of l.segs){let w=D(y.start,g,f,v),T=D(y.end,g,f,v);if(d>=w&&d<=Math.max(T,w+1))return y}return null}function G(l,d,g,f){if(l.kind==="milestone")return[`artifact · ${l.stage??""}`,g(l.start),`commit ${l.commit??""}`].join(`
`);let v=[`${l.kind} · ${f(l.end-l.start)}`,g(l.start,l.end)];if(l.kind==="firstbyte")v.push("first attributed ledger request — not network latency");if(l.kind==="tool")v.push("request-row minutes — not tool-call duration");if(l.kind==="unknown")v.push("no fact covers this gap");return v.push(`attempt ${d.attempt.index} · ${d.attempt.sid}`),v.join(`
`)}var it=13,at=14,B=5;function ht(l){let d=l.attempt.claimEnd??l.windowEnd,g=Math.min(d,l.windowEnd)-l.attempt.claimStart;return g>0?g:null}function Q(l,d){return d===void 0?k(l):F(l,d).join(`
`)}function Ot(l,d){let{segs:g,milestones:f}=V(l),v=[];for(let y of g){let w=D(y.start,l.windowStart,l.windowEnd,d),T=Math.max(w+1,D(y.end,l.windowStart,l.windowEnd,d));v.push(E`<rect
				class="at-${y.kind}"
				x=${w.toFixed(1)}
				y=${it}
				width=${(T-w).toFixed(1)}
				height=${at}
				rx="2"
			/>`)}for(let y of f){let w=D(y.start,l.windowStart,l.windowEnd,d),T=it+at/2;v.push(E`<path
				class="at-ms"
				d="M ${w.toFixed(1)},${(T-B).toFixed(1)} l ${B},${B} l -${B},${B} l -${B},-${B} Z"
			/>`)}return e`${v}`}var ut=(l)=>({kind:l.kind,start:l.start});function ft(l){return{hover:(f,v)=>{let y=f.currentTarget;if(!v||!y){l.hide();return}let w=y.getBoundingClientRect();if(w.width===0)return;let T=dt(V(v),f.clientX-w.left,v.windowStart,v.windowEnd,w.width);if(!T){l.hide();return}l.setTip(G(T,v,Q,K),-1,ut(T)),l.placeTip(f.clientX,f.clientY)},hide:()=>l.hide(),keydown:(f,v)=>{if(f.key==="Escape"){l.hide(),f.target.blur();return}if(f.key!=="ArrowLeft"&&f.key!=="ArrowRight")return;f.preventDefault();let y=l.slot(),{milestones:w,segs:T}=V(v),S=[...w,...T];if(!S.length)return;let M=f.key==="ArrowLeft"?-1:1,R=Math.max(0,Math.min(S.length-1,y+M)),H=S[R];if(!H)return;l.setTip(G(H,v,Q,K),R,ut(H));let N=f.currentTarget;if(N){let _=N.getBoundingClientRect(),X=D(H.start,v.windowStart,v.windowEnd,_.width);l.placeTip(_.left+X,_.top+8)}},slot:()=>l.slot()}}function mt(l,d){return e`<div class="axis">
		<span>${W(l.windowStart)}</span>
		<span>${d} · ${l.binMs/60000}m/bin</span>
		<span>${W(l.windowEnd)}</span>
	</div>`}function gt(l,d,g){return e`<svg
		class="plot"
		viewBox="0 0 ${d} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${l.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(f)=>g.hover(f,l)}
		@pointerleave=${()=>g.hide()}
		@keydown=${(f)=>g.keydown(f,l)}
	>
		${Ot(l,d)}
	</svg>`}var bt=r`
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
`;var vt=r`${h(`@charset "UTF-8";
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
}`)}`;class ot extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[vt,bt];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let d=this._plotEl()?.clientWidth??0;if(d!==this._width)this._width=d,this.requestUpdate()});let l=this._plotEl();if(l&&this._ro)this._ro.observe(l)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let l=this._plotEl();if(l&&this._ro)this._width=l.clientWidth,this._ro.observe(l)}updated(){let l=this._plotEl();if(l&&this._ro)this._ro.observe(l)}update(l){if(super.update(l),!l.has("points")&&!l.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:f,segs:v}=V(this.attempt),y=[...f,...v],w=this._tipRef,T=y.findIndex((S)=>S.kind===w.kind&&S.start===w.start);if(T<0){this._hideTip();return}this._tip=G(y[T],this.attempt,Q,K),this._slot=T;return}let d=this._spec;if(!d.hasData||this._tipTs===null){if(!d.hasData)this._hideTip();return}let g=Math.floor((this._tipTs-(d.windowStart??0))/d.slotMs);if(g<0||g>=d.count){this._hideTip();return}this._slot=g,this._tip=this._tipText(d,g)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return pt(this.points,this._width||240)}_hover=(l)=>{let d=this._plotEl(),g=this._spec;if(!d||!g.hasData){this._hideTip();return}let f=d.getBoundingClientRect();if(f.width===0)return;let v=Math.max(0,Math.min(g.count-1,Math.floor((l.clientX-f.left)/f.width*g.count)));this._slot=v,this._tip=this._tipText(g,v),this._tipTs=(g.windowStart??0)+v*g.slotMs,this.requestUpdate(),this._placeTip(l.clientX,l.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(l)=>{let d=this._spec;if(l.key==="Escape"){this._hide();return}if(l.key!=="ArrowLeft"&&l.key!=="ArrowRight")return;l.preventDefault();let g=l.key==="ArrowLeft"?-1:1,f=Math.max(0,Math.min(d.count-1,this._slot+g));this._slot=f,this._tip=this._tipText(d,f),this._tipTs=(d.windowStart??0)+f*d.slotMs,this.requestUpdate();let v=this._plotEl();if(v){let y=v.getBoundingClientRect();this._placeTip(y.left+(f+0.5)/d.count*y.width,y.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(l,d){let g=l.bins[d],f=(l.windowStart??0)+d*l.slotMs,v=[k(f),`${U(f,C(f)!==O(f))} · ${l.slotMs/60000}-minute bin`];if(g)v.push(`Fresh input ${g.fresh.toLocaleString("en-US")}`),v.push(`Cached input ${g.cached.toLocaleString("en-US")}`),v.push(`Output ${g.out.toLocaleString("en-US")}`);else v.push("no requests in this bin");return v.join(`
`)}_barsSvg(l){let g=(this._width||240)/l.count,f=0;for(let y of l.bins)if(y)f=Math.max(f,y.fresh+y.cached);let v=[];if(f>0)for(let y=0;y<l.count;y++){let w=l.bins[y];if(!w)continue;let T=y*g+(g-rt)/2;v.push(this._barRects(w,T,f))}if(!v.length)return e``;return E`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${v}`}_barRects(l,d,g){let v=[],y=0,w=[[l.fresh,"spark-fresh"],[l.cached,"spark-cached"]];for(let[T,S]of w){if(T<=0)continue;let M=Math.max(0.5,T/g*38);v.push(E`<rect
					class=${S}
					x=${d.toFixed(1)}
					y=${Math.max(1,39-y-M).toFixed(1)}
					width=${rt}
					height=${M.toFixed(1)}
				/>`),y+=M}return e`${v}`}_hairlineHtml(){let l=this._width||240,d=st(this._hairWallMs(),l);if(!d.visible)return null;return e`<div
			class="hairline${d.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${K(this._hairWallMs()??0)} of ${J()} scale${d.saturated?" — saturated at full width":""}"
			title="elapsed ${K(this._hairWallMs()??0)} of ${J()} scale${d.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${d.start.toFixed(1)}px;width:${(d.end-d.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let l=this._width||240,d=st(this._hairWallMs(),l);if(!d.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${K(this._hairWallMs()??0)} of ${J()} scale`+(d.saturated?" — saturated at full width":""),this.requestUpdate();let g=this._plotEl()?.getBoundingClientRect();if(g)this._placeTip(g.left+d.center/Math.max(1,l)*g.width,g.bottom+2)};_hairKey=(l)=>{if(l.key==="Escape")this._hideTip(),this.requestUpdate(),l.target.blur()};_axisHtml(l){let d=this._tzLabel();return e`<div class="axis">
			<span>${l.hasData?W(l.windowStart??0):""}</span>
			<span
				>${l.hasData?`${d} · ${l.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${l.hasData?W(l.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let l=-new Date().getTimezoneOffset(),d=Math.abs(l);return`UTC${l>=0?"+":"-"}${String(Math.floor(d/60)).padStart(2,"0")}:${String(d%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(l,d){let g=()=>{let v=this.renderRoot.querySelector(".tip");if(!v)return;let y=Math.min(l+10,window.innerWidth-v.offsetWidth-8),w=d-v.offsetHeight-10;v.style.left=`${Math.max(8,y)}px`,v.style.top=`${w>=8?w:d+12}px`};if(this.renderRoot.querySelector(".tip")){g();return}this.updateComplete.then(g).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?ht(this.attempt):this.wallMs}get _stripHost(){return{setTip:(l,d,g)=>{this._tip=l,this._slot=d,this._tipRef=g??null,this.requestUpdate()},placeTip:(l,d)=>this._placeTip(l,d),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=ft(this._stripHost);_renderAttempt(){let l=this.attempt,d=this._width||240;if(!l)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${gt(l,d,this._attemptHandlers)}
			${this._hairlineHtml()}
			${mt(l,this._tzLabel())}
			${this._tip?this._tipHtml():null}
		`}render(){if(this.mode==="attempt")return this._renderAttempt();let l=this._spec;return e`
			<svg
				class="plot"
				viewBox="0 0 ${this._width||240} 40"
				preserveAspectRatio="none"
				role="img"
				aria-label="Fresh and cached input tokens in ${l.slotMs/60000}-minute bins across the measured track"
				tabindex="0"
				@pointermove=${this._hover}
				@pointerleave=${this._hide}
				@keydown=${this._keyNav}
			>
				${this._barsSvg(l)}
			</svg>
			${this._hairlineHtml()}
			${this._axisHtml(l)}
			${this._tip?this._tipHtml():null}
		`}}var kt=r`${h(`@charset "UTF-8";
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
}`)}`;class tt extends c{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(l,d,g,f){super(tt.eventName);this.action=l,this.id=d,this.project=g,this.executor=f?.executor,this.effort=f?.effort}}class et extends c{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(l,d,g){super(et.eventName);this.id=l,this.project=d,this.executor=g?.executor,this.effort=g?.effort}}class nt extends c{static eventName="task-card-open-requested";id;project;constructor(l,d){super(nt.eventName);this.id=l,this.project=d}}function xt(l){if(l==="CLAIMED"||l==="RUNNING")return"working";if(l==="WAITING"||l==="BLOCKED"||l==="PAUSED")return"blocked";if(l==="SHATTERED")return"split";if(l==="FAILED")return"failed";if(l==="DONE")return"done";if(l==="CANCELLED")return"cancelled";return"ready"}function yt(l){if(l==="SHATTERED")return"split";return l.toLowerCase()}function wt(l){return/^\s*BLOCKED\b/i.test(l)?"blocked":"warning"}function Tt(l){return l.replace(/^\s*BLOCKED\b[\s:]+/i,"")||l}var I=s(p(o())),L=s(p(u())),Pt=i({value:o(),label:o(),badge:s(o()),reasoningEffort:s(P())}),Lt=i({tokens:L,wallMs:L,tokPerMin:L,cachePct:L}),Nt=i({mode:z(["spend","attempt"]),windowStartMs:L,windowEndMs:L,binMs:L,elapsedMs:L,scaleMs:L}),_t=i({id:o(),project:I,title:I,state:o(),ageS:L,contextLines:s(a(o())),parentRef:I,model:I,host:I,warn:I,metrics:s(Lt),activity:s(Nt),nested:s(P()),preferColor:I,executors:s(a(Pt)),executorPick:I,effortOptions:s(a(o())),effortPick:I,pendingAction:I});function $t(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${Math.round(l/1000)}k`;return String(Math.round(l))}function St(l){if(l==null)return"—";if(l<60000)return`${Math.round(l/1000)}s`;let d=Math.round(l/60000);if(d>=60)return`${Math.floor(d/60)}h${String(d%60).padStart(2,"0")}m`;return`${d}m`}function Et(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${(l/1000).toFixed(1)}k`;return String(Math.round(l))}function Mt(l){if(l==null)return"—";return`${Math.round(l)}%`}var lt="—";class ct extends n{static properties={card:{attribute:!1}};static styles=kt;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return xt(this.card.state)}open(){this.dispatchEvent(new nt(this.card.id,this.card.project??null))}act(l,d){this.dispatchEvent(new tt(l,this.card.id,this.card.project??null,d))}draft(l){this.dispatchEvent(new et(this.card.id,this.card.project??null,l))}statusWord(){return yt(this.card.state)}render(){let l=this.card,d=this.tone(),g=l.metrics??null,f=l.ageS==null?lt:Z(l.ageS),v=l.ageS==null?"age unknown":`open ${m(l.ageS)}`,y=l.executors??[],w=l.executorPick??"",T=l.effortOptions??[],S=l.effortPick??"",M=l.pendingAction??"",R=(_,X)=>M===_?`${X}…`:X,H=(_)=>M===_,N=(_)=>M===_?"true":"false";return e`
			${l.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${d}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${v}>${f}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${l.id}
				</button>
				${l.title?e`<div class="title" title=${l.title}>${l.title}</div>`:t}
				${(l.contextLines??[]).map((_)=>e`<div class="ctx" title=${_}>${_}</div>`)}
				${l.parentRef?e`<div class="ctx" title=${`parent ${l.parentRef}`}
							>↳ ${l.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${l.model??""}>${l.model??lt}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${l.host??""}>${l.host??lt}</b>
					</div>
				</div>
				<hr class="rule" />
				${l.warn?e`<div class="warn" role="note">
							<span class="wl">${wt(l.warn)}</span>
							<span class="wt" title=${l.warn}>${Tt(l.warn)}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${$t(g?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${St(g?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${Et(g?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${Mt(g?.cachePct)}</span>
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
							?disabled=${H("retry")}
							aria-busy=${N("retry")}
							@click=${()=>this.act("retry")}
						>
							${R("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${H("recover")}
							aria-busy=${N("recover")}
							@click=${()=>this.act("recover")}
						>
							${R("recover","Recover → Ready")}
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${()=>this.act("prompt")}
						>
							Prompt ↗
						</button>`:t}
				${d==="ready"&&y.length?e`<select
							class="seg"
							aria-label=${`executor for ${l.id}`}
							@change=${(_)=>{this.draftExecutor=_.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${y.map((_)=>e`<option
									value=${_.value}
									?selected=${_.value===(this.draftExecutor??w)}
								>
									${_.badge??""}${_.label}
								</option>`)}
						</select>
						${T.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${l.id}`}
									@change=${(_)=>{this.draftEffort=_.target.value,this.draft({effort:this.draftEffort})}}
								>
									${T.map((_)=>e`<option
											value=${_}
											?selected=${_===(this.draftEffort??S)}
										>
											${_}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${H("start")}
							aria-busy=${N("start")}
							@click=${()=>this.act("start",{executor:this.draftExecutor??w,effort:this.draftEffort??S})}
						>
							${R("start","Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${d==="ready"&&!y.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${d==="working"&&!y.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${H("release")}
								aria-busy=${N("release")}
								@click=${()=>this.act("release")}
							>
								${R("release","Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`:t}
				${d==="working"&&y.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${l.id}`}
							@change=${(_)=>{this.draftExecutor=_.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${y.map((_)=>e`<option
									value=${_.value}
									?selected=${_.value===(this.draftExecutor??w)}
								>
									${_.badge??""}${_.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							?disabled=${H("reassign")}
							aria-busy=${N("reassign")}
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??w})}
						>
							${R("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${H("release")}
							aria-busy=${N("release")}
							@click=${()=>this.act("release")}
						>
							${R("release","Release ⏏")}
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
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var A=s(p(o())),j=s(p(u())),Kt=i({fresh:j,cached:j,out:j,wall_ms:j,model_groups:s(x(o(),b()))}),Dt=i({state:o(),observed_at:j,source:A,progress:s(p(i({stage:z(["completed","reviewed","review-blocked","landed"]),ts:j})))}),Bt=i({text:A}),qt=i({id:o(),project:A,title:A,state:o(),age_s:j,owner_sid:A,owner_label:A,origin:A,model:A,locality:A,parent_id:A,tag_color:A,failure_note:A,wait_kind:A,wait_reason:A,requires:A,blocked_by:s(a(o())),waiting_on:s(a(o())),spend:s(p(Kt)),execution:s(p(Dt)),tail:s(p(Bt))});class q extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(l){let d=l.spend?.model_groups,g="",f=-1;if(d)for(let[v,y]of Object.entries(d)){let w=typeof y==="object"&&y!==null?Number(y.requests??0):0;if(Number.isFinite(w)&&w>f)g=v,f=w}return g||l.model||void 0}static hostOf(l){let d=l.owner_label?.trim();if(d&&d!==l.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(d))return d;return l.owner_sid??void 0}static metricsOf(l){let d=l.spend;if(!d)return;let g=d.fresh??void 0,f=d.cached??void 0,v=d.out??void 0,y=d.wall_ms??void 0,w=g===void 0&&f===void 0&&v===void 0?void 0:(g??0)+(f??0)+(v??0),T=y!==void 0&&y>0?y/60000:0,S=T>0&&v!==void 0?v/T:void 0,M=(g??0)+(f??0),R=M>0&&f!==void 0?f/M*100:void 0;return{tokens:w,wallMs:y,tokPerMin:S,cachePct:R}}static parentRefOf(l){return l.parent_id??void 0}contextLinesOf(l){let d=[],g=l.execution;if(g){let w=g.progress?.stage;d.push(w?`${g.state} · ${w}`:`${g.state} · no artifact evidence in snapshot`)}if(l.state==="WAITING"&&l.wait_reason)d.push(`${l.wait_kind??"external"} · ${l.wait_reason}`);let f=l.blocked_by??[];if(f.length)d.push(`waiting on ${f.join(", ")}`);let v=l.waiting_on??[];if(v.length)d.push(`split into ${v.join(", ")}`);let y=l.tail?.text?.trim();if(y&&!d.includes(y))d.push(y);return d}modelOf(l){let d={id:l.id,project:l.project??void 0,title:l.title??void 0,state:l.state,ageS:l.age_s??void 0,contextLines:this.contextLinesOf(l),parentRef:q.parentRefOf(l),model:q.modelOf(l),host:q.hostOf(l),warn:l.failure_note??void 0,metrics:q.metricsOf(l),nested:this.hasAttribute("data-nested"),preferColor:l.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},g=_t.safeParse(d);return g.success?g.data:null}render(){let l=qt.safeParse(this.t);if(!this.t||!l.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let d=l.data,g=this.modelOf(d);if(!g)return e``;let f=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${q.metricsOf(d)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${g}>${f}</klh-task-card>`}createRenderRoot(){return this}}var jt=()=>{Y("klh-task-card-host",q),Y("klh-task-card",ct),Y("klh-card-activity",ot)};jt();export{jt as registerBoardElements};
