import{h,r,e,E,t,n}from"./lit-b59bf30faa0b21f8.js";import{o,u,P,b,a,i,y,z,s,p}from"./lit-b9e6dc75d3d0960d.js";import{m,Z}from"./lit-fa2d59eb76085ea2.js";import{l}from"./lit-19130002dd3c1d75.js";import{k,U,C,O,F}from"./lit-d109c83208056758.js";var zt=new Set,Y=(c,d)=>{if(customElements.get(c))throw Error(`defineElement: <${c}> is already defined — ONE register point per workspace`);zt.add(c),customElements.define(c,d)};var rt=1.5;function Rt(c,d,g,f=180000){let v=Array.from({length:g},()=>null);for(let x of c){let w=Math.floor((x[0]-d)/f);if(w>g-1)w=g-1;if(w<0)continue;let T=v[w];if(T==null)T={fresh:0,cached:0,out:0},v[w]=T;T.fresh+=x[1],T.cached+=x[2],T.out+=x[3]}return v}function Ct(c,d,g=6,f=180000){let v=Math.max(1,Math.floor(d/g)),x=c;return{count:v,slotMs:f,start:x-v*f,end:x}}var Ht={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function pt(c,d,g){if(!c.length)return Ht;let{POSITIVE_INFINITY:f,NEGATIVE_INFINITY:v}=Number;for(let M of c){if(M[0]<f)f=M[0];if(M[0]>v)v=M[0]}let x=Ct(v,d),w=g??Math.max(x.start,f),T=Math.ceil((v-w)/x.slotMs)+1,S=Math.max(1,Math.min(x.count,T));return{bins:Rt(c,w,S),firstTs:f,windowStart:w,windowEnd:w+S*x.slotMs,count:S,slotMs:x.slotMs,startClipped:w>f,hasData:!0}}function W(c){let d=new Date(c),g=(f)=>String(f).padStart(2,"0");return`${g(d.getHours())}:${g(d.getMinutes())}`}function st(c,d,g=86400000){let f=d/2;if(c===null||c===void 0)return{visible:!1,center:f,half:0,start:f,end:f,saturated:!1};if(!Number.isFinite(c)||c<=0)return{visible:!1,center:f,half:0,start:f,end:f,saturated:!1};let v=Math.min(d/2,c/g*(d/2));return{visible:!0,center:f,half:v,start:f-v,end:f+v,saturated:c>=g}}function K(c){if(!Number.isFinite(c)||c<=0)return"0m";let d=Math.round(c/60000);if(d<60)return`${d}m`;return`${Math.floor(d/60)}h ${String(d%60).padStart(2,"0")}m`}function J(c=86400000){return`${c/3600000}h`}function D(c,d,g,f){let v=Math.max(1,g-d),x=(c-d)/v*f;return Math.max(0,Math.min(f,x))}function V(c){let d=[];for(let f of c.attempt.segments){if(f.end<=f.start)continue;d.push({kind:f.kind,start:f.start,end:f.end})}let g=[];for(let f of c.milestones){if(f.ts<c.windowStart||f.ts>c.windowEnd)continue;g.push({kind:"milestone",start:f.ts,end:f.ts,commit:f.commit,stage:f.stage})}return{segs:d,milestones:g}}function dt(c,d,g,f,v){for(let x of c.milestones){let w=D(x.start,g,f,v);if(Math.abs(d-w)<=6)return x}for(let x of c.segs){let w=D(x.start,g,f,v),T=D(x.end,g,f,v);if(d>=w&&d<=Math.max(T,w+1))return x}return null}function G(c,d,g,f){if(c.kind==="milestone")return[`artifact · ${c.stage??""}`,g(c.start),`commit ${c.commit??""}`].join(`
`);let v=[`${c.kind} · ${f(c.end-c.start)}`,g(c.start,c.end)];if(c.kind==="firstbyte")v.push("first attributed ledger request — not network latency");if(c.kind==="tool")v.push("request-row minutes — not tool-call duration");if(c.kind==="unknown")v.push("no fact covers this gap");return v.push(`attempt ${d.attempt.index} · ${d.attempt.sid}`),v.join(`
`)}var it=13,at=14,B=5;function ht(c){let d=c.attempt.claimEnd??c.windowEnd,g=Math.min(d,c.windowEnd)-c.attempt.claimStart;return g>0?g:null}function Q(c,d){return d===void 0?k(c):F(c,d).join(`
`)}function Ot(c,d){let{segs:g,milestones:f}=V(c),v=[];for(let x of g){let w=D(x.start,c.windowStart,c.windowEnd,d),T=Math.max(w+1,D(x.end,c.windowStart,c.windowEnd,d));v.push(E`<rect
				class="at-${x.kind}"
				x=${w.toFixed(1)}
				y=${it}
				width=${(T-w).toFixed(1)}
				height=${at}
				rx="2"
			/>`)}for(let x of f){let w=D(x.start,c.windowStart,c.windowEnd,d),T=it+at/2;v.push(E`<path
				class="at-ms"
				d="M ${w.toFixed(1)},${(T-B).toFixed(1)} l ${B},${B} l -${B},${B} l -${B},-${B} Z"
			/>`)}return e`${v}`}var ut=(c)=>({kind:c.kind,start:c.start});function ft(c){return{hover:(f,v)=>{let x=f.currentTarget;if(!v||!x){c.hide();return}let w=x.getBoundingClientRect();if(w.width===0)return;let T=dt(V(v),f.clientX-w.left,v.windowStart,v.windowEnd,w.width);if(!T){c.hide();return}c.setTip(G(T,v,Q,K),-1,ut(T)),c.placeTip(f.clientX,f.clientY)},hide:()=>c.hide(),keydown:(f,v)=>{if(f.key==="Escape"){c.hide(),f.target.blur();return}if(f.key!=="ArrowLeft"&&f.key!=="ArrowRight")return;f.preventDefault();let x=c.slot(),{milestones:w,segs:T}=V(v),S=[...w,...T];if(!S.length)return;let M=f.key==="ArrowLeft"?-1:1,R=Math.max(0,Math.min(S.length-1,x+M)),H=S[R];if(!H)return;c.setTip(G(H,v,Q,K),R,ut(H));let N=f.currentTarget;if(N){let _=N.getBoundingClientRect(),X=D(H.start,v.windowStart,v.windowEnd,_.width);c.placeTip(_.left+X,_.top+8)}},slot:()=>c.slot()}}function mt(c,d){return e`<div class="axis">
		<span>${W(c.windowStart)}</span>
		<span>${d} · ${c.binMs/60000}m/bin</span>
		<span>${W(c.windowEnd)}</span>
	</div>`}function gt(c,d,g){return e`<svg
		class="plot"
		viewBox="0 0 ${d} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${c.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(f)=>g.hover(f,c)}
		@pointerleave=${()=>g.hide()}
		@keydown=${(f)=>g.keydown(f,c)}
	>
		${Ot(c,d)}
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
}`)}`;class ot extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[vt,bt];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let d=this._plotEl()?.clientWidth??0;if(d!==this._width)this._width=d,this.requestUpdate()});let c=this._plotEl();if(c&&this._ro)this._ro.observe(c)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let c=this._plotEl();if(c&&this._ro)this._width=c.clientWidth,this._ro.observe(c)}updated(){let c=this._plotEl();if(c&&this._ro)this._ro.observe(c)}update(c){if(super.update(c),!c.has("points")&&!c.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:f,segs:v}=V(this.attempt),x=[...f,...v],w=this._tipRef,T=x.findIndex((S)=>S.kind===w.kind&&S.start===w.start);if(T<0){this._hideTip();return}this._tip=G(x[T],this.attempt,Q,K),this._slot=T;return}let d=this._spec;if(!d.hasData||this._tipTs===null){if(!d.hasData)this._hideTip();return}let g=Math.floor((this._tipTs-(d.windowStart??0))/d.slotMs);if(g<0||g>=d.count){this._hideTip();return}this._slot=g,this._tip=this._tipText(d,g)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return pt(this.points,this._width||240)}_hover=(c)=>{let d=this._plotEl(),g=this._spec;if(!d||!g.hasData){this._hideTip();return}let f=d.getBoundingClientRect();if(f.width===0)return;let v=Math.max(0,Math.min(g.count-1,Math.floor((c.clientX-f.left)/f.width*g.count)));this._slot=v,this._tip=this._tipText(g,v),this._tipTs=(g.windowStart??0)+v*g.slotMs,this.requestUpdate(),this._placeTip(c.clientX,c.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(c)=>{let d=this._spec;if(c.key==="Escape"){this._hide();return}if(c.key!=="ArrowLeft"&&c.key!=="ArrowRight")return;c.preventDefault();let g=c.key==="ArrowLeft"?-1:1,f=Math.max(0,Math.min(d.count-1,this._slot+g));this._slot=f,this._tip=this._tipText(d,f),this._tipTs=(d.windowStart??0)+f*d.slotMs,this.requestUpdate();let v=this._plotEl();if(v){let x=v.getBoundingClientRect();this._placeTip(x.left+(f+0.5)/d.count*x.width,x.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(c,d){let g=c.bins[d],f=(c.windowStart??0)+d*c.slotMs,v=[k(f),`${U(f,C(f)!==O(f))} · ${c.slotMs/60000}-minute bin`];if(g)v.push(`Fresh input ${g.fresh.toLocaleString("en-US")}`),v.push(`Cached input ${g.cached.toLocaleString("en-US")}`),v.push(`Output ${g.out.toLocaleString("en-US")}`);else v.push("no requests in this bin");return v.join(`
`)}_barsSvg(c){let g=(this._width||240)/c.count,f=0;for(let x of c.bins)if(x)f=Math.max(f,x.fresh+x.cached);let v=[];if(f>0)for(let x=0;x<c.count;x++){let w=c.bins[x];if(!w)continue;let T=x*g+(g-rt)/2;v.push(this._barRects(w,T,f))}if(!v.length)return e``;return E`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${v}`}_barRects(c,d,g){let v=[],x=0,w=[[c.fresh,"spark-fresh"],[c.cached,"spark-cached"]];for(let[T,S]of w){if(T<=0)continue;let M=Math.max(0.5,T/g*38);v.push(E`<rect
					class=${S}
					x=${d.toFixed(1)}
					y=${Math.max(1,39-x-M).toFixed(1)}
					width=${rt}
					height=${M.toFixed(1)}
				/>`),x+=M}return e`${v}`}_hairlineHtml(){let c=this._width||240,d=st(this._hairWallMs(),c);if(!d.visible)return null;return e`<div
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
		</div>`}_hairFocus=()=>{let c=this._width||240,d=st(this._hairWallMs(),c);if(!d.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${K(this._hairWallMs()??0)} of ${J()} scale`+(d.saturated?" — saturated at full width":""),this.requestUpdate();let g=this._plotEl()?.getBoundingClientRect();if(g)this._placeTip(g.left+d.center/Math.max(1,c)*g.width,g.bottom+2)};_hairKey=(c)=>{if(c.key==="Escape")this._hideTip(),this.requestUpdate(),c.target.blur()};_axisHtml(c){let d=this._tzLabel();return e`<div class="axis">
			<span>${c.hasData?W(c.windowStart??0):""}</span>
			<span
				>${c.hasData?`${d} · ${c.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${c.hasData?W(c.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let c=-new Date().getTimezoneOffset(),d=Math.abs(c);return`UTC${c>=0?"+":"-"}${String(Math.floor(d/60)).padStart(2,"0")}:${String(d%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(c,d){let g=()=>{let v=this.renderRoot.querySelector(".tip");if(!v)return;let x=Math.min(c+10,window.innerWidth-v.offsetWidth-8),w=d-v.offsetHeight-10;v.style.left=`${Math.max(8,x)}px`,v.style.top=`${w>=8?w:d+12}px`};if(this.renderRoot.querySelector(".tip")){g();return}this.updateComplete.then(g).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?ht(this.attempt):this.wallMs}get _stripHost(){return{setTip:(c,d,g)=>{this._tip=c,this._slot=d,this._tipRef=g??null,this.requestUpdate()},placeTip:(c,d)=>this._placeTip(c,d),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=ft(this._stripHost);_renderAttempt(){let c=this.attempt,d=this._width||240;if(!c)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${gt(c,d,this._attemptHandlers)}
			${this._hairlineHtml()}
			${mt(c,this._tzLabel())}
			${this._tip?this._tipHtml():null}
		`}render(){if(this.mode==="attempt")return this._renderAttempt();let c=this._spec;return e`
			<svg
				class="plot"
				viewBox="0 0 ${this._width||240} 40"
				preserveAspectRatio="none"
				role="img"
				aria-label="Fresh and cached input tokens in ${c.slotMs/60000}-minute bins across the measured track"
				tabindex="0"
				@pointermove=${this._hover}
				@pointerleave=${this._hide}
				@keydown=${this._keyNav}
			>
				${this._barsSvg(c)}
			</svg>
			${this._hairlineHtml()}
			${this._axisHtml(c)}
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
}`)}`;class tt extends l{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(c,d,g,f){super(tt.eventName);this.action=c,this.id=d,this.project=g,this.executor=f?.executor,this.effort=f?.effort}}class et extends l{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(c,d,g){super(et.eventName);this.id=c,this.project=d,this.executor=g?.executor,this.effort=g?.effort}}class nt extends l{static eventName="task-card-open-requested";id;project;constructor(c,d){super(nt.eventName);this.id=c,this.project=d}}function xt(c){if(c==="CLAIMED"||c==="RUNNING")return"working";if(c==="WAITING"||c==="BLOCKED"||c==="PAUSED")return"blocked";if(c==="SHATTERED")return"split";if(c==="FAILED")return"failed";if(c==="DONE")return"done";if(c==="CANCELLED")return"cancelled";return"ready"}function yt(c){if(c==="SHATTERED")return"split";return c.toLowerCase()}function wt(c){return/^\s*BLOCKED\b/i.test(c)?"blocked":"warning"}function Tt(c){return c.replace(/^\s*BLOCKED\b[\s:]+/i,"")||c}var I=s(p(o())),L=s(p(u())),Pt=i({value:o(),label:o(),badge:s(o()),reasoningEffort:s(P())}),Lt=i({tokens:L,wallMs:L,tokPerMin:L,cachePct:L}),Nt=i({mode:z(["spend","attempt"]),windowStartMs:L,windowEndMs:L,binMs:L,elapsedMs:L,scaleMs:L}),_t=i({id:o(),project:I,title:I,state:o(),ageS:L,contextLines:s(a(o())),parentRef:I,model:I,host:I,warn:I,metrics:s(Lt),activity:s(Nt),nested:s(P()),preferColor:I,executors:s(a(Pt)),executorPick:I,effortOptions:s(a(o())),effortPick:I,pendingAction:I});function $t(c){if(c==null)return"—";if(c>=1e6)return`${(c/1e6).toFixed(1)}M`;if(c>=1000)return`${Math.round(c/1000)}k`;return String(Math.round(c))}function St(c){if(c==null)return"—";if(c<60000)return`${Math.round(c/1000)}s`;let d=Math.round(c/60000);if(d>=60)return`${Math.floor(d/60)}h${String(d%60).padStart(2,"0")}m`;return`${d}m`}function Et(c){if(c==null)return"—";if(c>=1e6)return`${(c/1e6).toFixed(1)}M`;if(c>=1000)return`${(c/1000).toFixed(1)}k`;return String(Math.round(c))}function Mt(c){if(c==null)return"—";return`${Math.round(c)}%`}var lt="—";class ct extends n{static properties={card:{attribute:!1}};static styles=kt;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return xt(this.card.state)}open(){this.dispatchEvent(new nt(this.card.id,this.card.project??null))}act(c,d){this.dispatchEvent(new tt(c,this.card.id,this.card.project??null,d))}draft(c){this.dispatchEvent(new et(this.card.id,this.card.project??null,c))}statusWord(){return yt(this.card.state)}render(){let c=this.card,d=this.tone(),g=c.metrics??null,f=c.ageS==null?lt:Z(c.ageS),v=c.ageS==null?"age unknown":`open ${m(c.ageS)}`,x=c.executors??[],w=c.executorPick??"",T=c.effortOptions??[],S=c.effortPick??"",M=c.pendingAction??"",R=(_,X)=>M===_?`${X}…`:X,H=(_)=>M===_,N=(_)=>M===_?"true":"false";return e`
			${c.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${d}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${v}>${f}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${c.id}
				</button>
				${c.title?e`<div class="title" title=${c.title}>${c.title}</div>`:t}
				${(c.contextLines??[]).map((_)=>e`<div class="ctx" title=${_}>${_}</div>`)}
				${c.parentRef?e`<div class="ctx" title=${`parent ${c.parentRef}`}
							>↳ ${c.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${c.model??""}>${c.model??lt}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${c.host??""}>${c.host??lt}</b>
					</div>
				</div>
				<hr class="rule" />
				${c.warn?e`<div class="warn" role="note">
							<span class="wl">${wt(c.warn)}</span>
							<span class="wt" title=${c.warn}>${Tt(c.warn)}</span>
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
				${d==="ready"&&x.length?e`<select
							class="seg"
							aria-label=${`executor for ${c.id}`}
							@change=${(_)=>{this.draftExecutor=_.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${x.map((_)=>e`<option
									value=${_.value}
									?selected=${_.value===(this.draftExecutor??w)}
								>
									${_.badge??""}${_.label}
								</option>`)}
						</select>
						${T.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${c.id}`}
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
				${d==="ready"&&!x.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${d==="working"&&!x.length?e`<button
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
				${d==="working"&&x.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${c.id}`}
							@change=${(_)=>{this.draftExecutor=_.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${x.map((_)=>e`<option
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
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var A=s(p(o())),j=s(p(u())),Kt=i({fresh:j,cached:j,out:j,wall_ms:j,model_groups:s(y(o(),b()))}),Dt=i({state:o(),observed_at:j,source:A,progress:s(p(i({stage:z(["completed","reviewed","review-blocked","landed"]),ts:j})))}),Bt=i({text:A}),qt=i({id:o(),project:A,title:A,state:o(),age_s:j,owner_sid:A,owner_label:A,origin:A,model:A,locality:A,parent_id:A,tag_color:A,failure_note:A,wait_kind:A,wait_reason:A,requires:A,blocked_by:s(a(o())),waiting_on:s(a(o())),spend:s(p(Kt)),execution:s(p(Dt)),tail:s(p(Bt))});class q extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(c){let d=c.spend?.model_groups,g="",f=-1;if(d)for(let[v,x]of Object.entries(d)){let w=typeof x==="object"&&x!==null?Number(x.requests??0):0;if(Number.isFinite(w)&&w>f)g=v,f=w}return g||c.model||void 0}static hostOf(c){let d=c.owner_label?.trim();if(d&&d!==c.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(d))return d;return c.owner_sid??void 0}static metricsOf(c){let d=c.spend;if(!d)return;let g=d.fresh??void 0,f=d.cached??void 0,v=d.out??void 0,x=d.wall_ms??void 0,w=g===void 0&&f===void 0&&v===void 0?void 0:(g??0)+(f??0)+(v??0),T=x!==void 0&&x>0?x/60000:0,S=T>0&&v!==void 0?v/T:void 0,M=(g??0)+(f??0),R=M>0&&f!==void 0?f/M*100:void 0;return{tokens:w,wallMs:x,tokPerMin:S,cachePct:R}}static parentRefOf(c){return c.parent_id??void 0}contextLinesOf(c){let d=[],g=c.execution;if(g){let w=g.progress?.stage;d.push(w?`${g.state} · ${w}`:`${g.state} · no artifact evidence in snapshot`)}if(c.state==="WAITING"&&c.wait_reason)d.push(`${c.wait_kind??"external"} · ${c.wait_reason}`);let f=c.blocked_by??[];if(f.length)d.push(`waiting on ${f.join(", ")}`);let v=c.waiting_on??[];if(v.length)d.push(`split into ${v.join(", ")}`);let x=c.tail?.text?.trim();if(x&&!d.includes(x))d.push(x);return d}modelOf(c){let d={id:c.id,project:c.project??void 0,title:c.title??void 0,state:c.state,ageS:c.age_s??void 0,contextLines:this.contextLinesOf(c),parentRef:q.parentRefOf(c),model:q.modelOf(c),host:q.hostOf(c),warn:c.failure_note??void 0,metrics:q.metricsOf(c),nested:this.hasAttribute("data-nested"),preferColor:c.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},g=_t.safeParse(d);return g.success?g.data:null}render(){let c=qt.safeParse(this.t);if(!this.t||!c.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let d=c.data,g=this.modelOf(d);if(!g)return e``;let f=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${q.metricsOf(d)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${g}>${f}</klh-task-card>`}createRenderRoot(){return this}}var jt=()=>{Y("klh-task-card-host",q),Y("klh-task-card",ct),Y("klh-card-activity",ot)};jt();export{jt as registerBoardElements};
