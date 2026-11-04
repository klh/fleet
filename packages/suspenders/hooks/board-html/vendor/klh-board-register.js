import{h,r,e,E,t,n}from"./lit-b59bf30faa0b21f8.js";import{o,u,P,b,a,i,x,A,s,p}from"./lit-93dbc87cade91682.js";import{m,Z}from"./lit-0840573c4dba1f10.js";import{c}from"./lit-05d02c13d2fb5953.js";import{k,U,C,O,F}from"./lit-d109c83208056758.js";var Pt=new Set,Y=(l,d)=>{if(customElements.get(l))throw Error(`defineElement: <${l}> is already defined — ONE register point per workspace`);Pt.add(l),customElements.define(l,d)};var st=1.5;var J=[15000,30000,60000,120000,180000,300000,600000,900000,1800000,3600000];function ut(l,d,f,g=180000){let v=Array.from({length:f},()=>null);for(let y of l){let w=Math.floor((y[0]-d)/g);if(w>f-1)w=f-1;if(w<0)continue;let T=v[w];if(T==null)T={fresh:0,cached:0,out:0},v[w]=T;T.fresh+=y[1],T.cached+=y[2],T.out+=y[3]}return v}function ht(l){return Math.max(1,Math.floor(l/6))*180000}function Lt(l,d,f=J){let g=ht(l);for(let v of f){if(v<d)continue;if(Math.ceil(g/v)*1<=l)return v}return f[f.length-1]}var ft={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function mt(l,d,f){if(!l.length)return ft;let{POSITIVE_INFINITY:g,NEGATIVE_INFINITY:v}=Number;for(let _ of l){if(_[0]<g)g=_[0];if(_[0]>v)v=_[0]}let y=1,w=ht(d),T=Math.max(v-w,g);for(let _ of l){if(_[0]<T)continue;if(_[4]!==void 0&&_[4]>y)y=_[4]}let M=Lt(d,y),z=Math.max(1,Math.ceil(w/M)),S=f??Math.max(v-z*M,g),I=Math.ceil((v-S)/M)+1,H=Math.max(1,Math.min(z,I));return{bins:ut(l,S,H,M),firstTs:g,windowStart:S,windowEnd:S+H*M,count:H,slotMs:M,startClipped:S>g,hasData:!0}}function bt(l,d,f,g){let v=l.filter((S)=>S[0]>=d&&S[0]<=f);if(!v.length)return ft;let y=Math.max(1,f-d),w=1;for(let S of v)if(S[4]!==void 0&&S[4]>w)w=S[4];let T=J[J.length-1];for(let S of J){if(S<w)continue;if(Math.ceil(y/S)*1<=g){T=S;break}}let M=Math.max(1,Math.ceil(y/T)),z=Number.POSITIVE_INFINITY;for(let S of v)if(S[0]<z)z=S[0];return{bins:ut(v,d,M,T),firstTs:z,windowStart:d,windowEnd:d+M*T,count:M,slotMs:T,startClipped:!1,hasData:!0}}function W(l){let d=new Date(l),f=(g)=>String(g).padStart(2,"0");return`${f(d.getHours())}:${f(d.getMinutes())}`}function Q(l){if(l<60000)return`${Math.round(l/1000)}-second`;if(l<3600000)return`${Math.round(l/60000)}-minute`;return`${Math.round(l/3600000)}-hour`}function at(l,d,f=86400000){let g=d/2;if(l===null||l===void 0)return{visible:!1,center:g,half:0,start:g,end:g,saturated:!1};if(!Number.isFinite(l)||l<=0)return{visible:!1,center:g,half:0,start:g,end:g,saturated:!1};let v=Math.min(d/2,l/f*(d/2));return{visible:!0,center:g,half:v,start:g-v,end:g+v,saturated:l>=f}}function B(l){if(!Number.isFinite(l)||l<=0)return"0m";let d=Math.round(l/60000);if(d<60)return`${d}m`;return`${Math.floor(d/60)}h ${String(d%60).padStart(2,"0")}m`}function tt(l=86400000){return`${l/3600000}h`}function D(l,d,f,g){let v=Math.max(1,f-d),y=(l-d)/v*g;return Math.max(0,Math.min(g,y))}function V(l){let d=[];for(let g of l.attempt.segments){if(g.end<=g.start)continue;d.push({kind:g.kind,start:g.start,end:g.end})}let f=[];for(let g of l.milestones){if(g.ts<l.windowStart||g.ts>l.windowEnd)continue;f.push({kind:"milestone",start:g.ts,end:g.ts,commit:g.commit,stage:g.stage})}return{segs:d,milestones:f}}function gt(l,d,f,g,v){for(let y of l.milestones){let w=D(y.start,f,g,v);if(Math.abs(d-w)<=6)return y}for(let y of l.segs){let w=D(y.start,f,g,v),T=D(y.end,f,g,v);if(d>=w&&d<=Math.max(T,w+1))return y}return null}function G(l,d,f,g){if(l.kind==="milestone")return[`artifact · ${l.stage??""}`,f(l.start),`commit ${l.commit??""}`].join(`
`);let v=[`${l.kind} · ${g(l.end-l.start)}`,f(l.start,l.end)];if(l.kind==="firstbyte")v.push("first attributed ledger request — not network latency");if(l.kind==="tool")v.push("request-row minutes — not tool-call duration");if(l.kind==="unknown")v.push("no fact covers this gap");return v.push(`attempt ${d.attempt.index} · ${d.attempt.sid}`),v.join(`
`)}var ot=13,lt=14,K=5;function xt(l){let d=l.attempt.claimEnd??l.windowEnd,f=Math.min(d,l.windowEnd)-l.attempt.claimStart;return f>0?f:null}function et(l,d){return d===void 0?k(l):F(l,d).join(`
`)}function Nt(l,d){let{segs:f,milestones:g}=V(l),v=[];for(let y of f){let w=D(y.start,l.windowStart,l.windowEnd,d),T=Math.max(w+1,D(y.end,l.windowStart,l.windowEnd,d));v.push(E`<rect
				class="at-${y.kind}"
				x=${w.toFixed(1)}
				y=${ot}
				width=${(T-w).toFixed(1)}
				height=${lt}
				rx="2"
			/>`)}for(let y of g){let w=D(y.start,l.windowStart,l.windowEnd,d),T=ot+lt/2;v.push(E`<path
				class="at-ms"
				d="M ${w.toFixed(1)},${(T-K).toFixed(1)} l ${K},${K} l -${K},${K} l -${K},-${K} Z"
			/>`)}return e`${v}`}var vt=(l)=>({kind:l.kind,start:l.start});function kt(l){return{hover:(g,v)=>{let y=g.currentTarget;if(!v||!y){l.hide();return}let w=y.getBoundingClientRect();if(w.width===0)return;let T=gt(V(v),g.clientX-w.left,v.windowStart,v.windowEnd,w.width);if(!T){l.hide();return}l.setTip(G(T,v,et,B),-1,vt(T)),l.placeTip(g.clientX,g.clientY)},hide:()=>l.hide(),keydown:(g,v)=>{if(g.key==="Escape"){l.hide(),g.target.blur();return}if(g.key!=="ArrowLeft"&&g.key!=="ArrowRight")return;g.preventDefault();let y=l.slot(),{milestones:w,segs:T}=V(v),M=[...w,...T];if(!M.length)return;let z=g.key==="ArrowLeft"?-1:1,S=Math.max(0,Math.min(M.length-1,y+z)),I=M[S];if(!I)return;l.setTip(G(I,v,et,B),S,vt(I));let H=g.currentTarget;if(H){let _=H.getBoundingClientRect(),X=D(I.start,v.windowStart,v.windowEnd,_.width);l.placeTip(_.left+X,_.top+8)}},slot:()=>l.slot()}}function yt(l,d){return e`<div class="axis">
		<span>${W(l.windowStart)}</span>
		<span>${d} · ${l.binMs/60000}m/bin</span>
		<span>${W(l.windowEnd)}</span>
	</div>`}function wt(l,d,f,g){return e`<svg
		class="plot"
		viewBox="0 0 ${d} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${l.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones${g?" over real token activity":""}"
		tabindex="0"
		@pointermove=${(v)=>f.hover(v,l)}
		@pointerleave=${()=>f.hide()}
		@keydown=${(v)=>f.keydown(v,l)}
	>
		${g}${Nt(l,d)}
	</svg>`}var _t=r`
	.plot rect.at-queue {
		fill: var(--klh-chart-axis, #898781);
		fill-opacity: 0.35;
	}
	.plot rect.at-firstbyte {
		fill: var(--klh-accent, #d8900f);
		fill-opacity: 0.35;
	}
	.plot rect.at-tool {
		fill: var(--klh-ok, #5c7a35);
		fill-opacity: 0.35;
	}
	.plot rect.at-pause {
		fill: var(--klh-warn, #b8860b);
		fill-opacity: 0.35;
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
`;var Tt=r`${h(`@charset "UTF-8";
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
}`)}`;class ct extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[Tt,_t];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let d=this._plotEl()?.clientWidth??0;if(d!==this._width)this._width=d,this.requestUpdate()});let l=this._plotEl();if(l&&this._ro)this._ro.observe(l)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let l=this._plotEl();if(l&&this._ro)this._width=l.clientWidth,this._ro.observe(l)}updated(){let l=this._plotEl();if(l&&this._ro)this._ro.observe(l)}update(l){if(super.update(l),!l.has("points")&&!l.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:g,segs:v}=V(this.attempt),y=[...g,...v],w=this._tipRef,T=y.findIndex((M)=>M.kind===w.kind&&M.start===w.start);if(T<0){this._hideTip();return}this._tip=G(y[T],this.attempt,et,B),this._slot=T;return}let d=this._spec;if(!d.hasData||this._tipTs===null){if(!d.hasData)this._hideTip();return}let f=Math.floor((this._tipTs-(d.windowStart??0))/d.slotMs);if(f<0||f>=d.count){this._hideTip();return}this._slot=f,this._tip=this._tipText(d,f)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return mt(this.points,this._width||240)}_hover=(l)=>{let d=this._plotEl(),f=this._spec;if(!d||!f.hasData){this._hideTip();return}let g=d.getBoundingClientRect();if(g.width===0)return;let v=Math.max(0,Math.min(f.count-1,Math.floor((l.clientX-g.left)/g.width*f.count)));this._slot=v,this._tip=this._tipText(f,v),this._tipTs=(f.windowStart??0)+v*f.slotMs,this.requestUpdate(),this._placeTip(l.clientX,l.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(l)=>{let d=this._spec;if(l.key==="Escape"){this._hide();return}if(l.key!=="ArrowLeft"&&l.key!=="ArrowRight")return;l.preventDefault();let f=l.key==="ArrowLeft"?-1:1,g=Math.max(0,Math.min(d.count-1,this._slot+f));this._slot=g,this._tip=this._tipText(d,g),this._tipTs=(d.windowStart??0)+g*d.slotMs,this.requestUpdate();let v=this._plotEl();if(v){let y=v.getBoundingClientRect();this._placeTip(y.left+(g+0.5)/d.count*y.width,y.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(l,d){let f=l.bins[d],g=(l.windowStart??0)+d*l.slotMs,v=[k(g),`${U(g,C(g)!==O(g))} · ${Q(l.slotMs)} bin`];if(f)v.push(`Fresh input ${f.fresh.toLocaleString("en-US")}`),v.push(`Cached input ${f.cached.toLocaleString("en-US")}`),v.push(`Output ${f.out.toLocaleString("en-US")}`);else v.push("no requests in this bin");return v.join(`
`)}_barsSvg(l){let f=(this._width||240)/l.count,g=Math.max(0.5,Math.min(st,f)),v=0;for(let w of l.bins)if(w)v=Math.max(v,w.fresh+w.cached);let y=[];if(v>0)for(let w=0;w<l.count;w++){let T=l.bins[w];if(!T)continue;let M=w*f+(f-g)/2;y.push(this._barRects(T,M,v,g))}if(!y.length)return e``;return E`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${y}`}_barRects(l,d,f,g=st){let y=[],w=0,T=[[l.fresh,"spark-fresh"],[l.cached,"spark-cached"]];for(let[M,z]of T){if(M<=0)continue;let S=Math.max(0.5,M/f*38);y.push(E`<rect
					class=${z}
					x=${d.toFixed(1)}
					y=${Math.max(1,39-w-S).toFixed(1)}
					width=${g.toFixed(1)}
					height=${S.toFixed(1)}
				/>`),w+=S}return e`${y}`}_hairlineHtml(){let l=this._width||240,d=at(this._hairWallMs(),l);if(!d.visible)return null;return e`<div
			class="hairline${d.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${B(this._hairWallMs()??0)} of ${tt()} scale${d.saturated?" — saturated at full width":""}"
			title="elapsed ${B(this._hairWallMs()??0)} of ${tt()} scale${d.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${d.start.toFixed(1)}px;width:${(d.end-d.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let l=this._width||240,d=at(this._hairWallMs(),l);if(!d.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${B(this._hairWallMs()??0)} of ${tt()} scale`+(d.saturated?" — saturated at full width":""),this.requestUpdate();let f=this._plotEl()?.getBoundingClientRect();if(f)this._placeTip(f.left+d.center/Math.max(1,l)*f.width,f.bottom+2)};_hairKey=(l)=>{if(l.key==="Escape")this._hideTip(),this.requestUpdate(),l.target.blur()};_axisHtml(l){let d=this._tzLabel();return e`<div class="axis">
			<span>${l.hasData?W(l.windowStart??0):""}</span>
			<span
				>${l.hasData?`${d} · ${Q(l.slotMs)} bins`:"no activity"}</span
			>
			<span>${l.hasData?W(l.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let l=-new Date().getTimezoneOffset(),d=Math.abs(l);return`UTC${l>=0?"+":"-"}${String(Math.floor(d/60)).padStart(2,"0")}:${String(d%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(l,d){let f=()=>{let v=this.renderRoot.querySelector(".tip");if(!v)return;let y=Math.min(l+10,window.innerWidth-v.offsetWidth-8),w=d-v.offsetHeight-10;v.style.left=`${Math.max(8,y)}px`,v.style.top=`${w>=8?w:d+12}px`};if(this.renderRoot.querySelector(".tip")){f();return}this.updateComplete.then(f).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?xt(this.attempt):this.wallMs}get _stripHost(){return{setTip:(l,d,f)=>{this._tip=l,this._slot=d,this._tipRef=f??null,this.requestUpdate()},placeTip:(l,d)=>this._placeTip(l,d),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=kt(this._stripHost);_renderAttempt(){let l=this.attempt,d=this._width||240;if(!l)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${wt(l,d,this._attemptHandlers,this._barsSvg(bt(this.points,l.windowStart,l.windowEnd,d)))}
			${this._hairlineHtml()}
			${yt(l,this._tzLabel())}
			${this._tip?this._tipHtml():null}
		`}render(){if(this.mode==="attempt")return this._renderAttempt();let l=this._spec;return e`
			<svg
				class="plot"
				viewBox="0 0 ${this._width||240} 40"
				preserveAspectRatio="none"
				role="img"
				aria-label="Fresh and cached input tokens in ${Q(l.slotMs)} bins across the measured track"
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
		`}}var $t=r`${h(`@charset "UTF-8";
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
}`)}`;class nt extends c{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(l,d,f,g){super(nt.eventName);this.action=l,this.id=d,this.project=f,this.executor=g?.executor,this.effort=g?.effort}}class rt extends c{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(l,d,f){super(rt.eventName);this.id=l,this.project=d,this.executor=f?.executor,this.effort=f?.effort}}class it extends c{static eventName="task-card-open-requested";id;project;constructor(l,d){super(it.eventName);this.id=l,this.project=d}}function St(l){if(l==="CLAIMED"||l==="RUNNING")return"working";if(l==="WAITING"||l==="BLOCKED"||l==="PAUSED")return"blocked";if(l==="SHATTERED")return"split";if(l==="FAILED")return"failed";if(l==="DONE")return"done";if(l==="CANCELLED")return"cancelled";return"ready"}function Et(l){if(l==="SHATTERED")return"split";return l.toLowerCase()}function Mt(l){return/^\s*BLOCKED\b/i.test(l)?"blocked":"warning"}function At(l){return l.replace(/^\s*BLOCKED\b[\s:]+/i,"")||l}var L=s(p(o())),N=s(p(u())),Dt=i({value:o(),label:o(),badge:s(o()),reasoningEffort:s(P())}),Kt=i({tokens:N,wallMs:N,tokPerMin:N,cachePct:N}),qt=i({mode:A(["spend","attempt"]),windowStartMs:N,windowEndMs:N,binMs:N,elapsedMs:N,scaleMs:N}),zt=i({id:o(),project:L,title:L,state:o(),ageS:N,contextLines:s(a(o())),parentRef:L,model:L,host:L,warn:L,metrics:s(Kt),activity:s(qt),nested:s(P()),preferColor:L,executors:s(a(Dt)),executorPick:L,effortOptions:s(a(o())),effortPick:L,pendingAction:L});function Rt(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${Math.round(l/1000)}k`;return String(Math.round(l))}function Ct(l){if(l==null)return"—";if(l<60000)return`${Math.round(l/1000)}s`;let d=Math.round(l/60000);if(d>=60)return`${Math.floor(d/60)}h${String(d%60).padStart(2,"0")}m`;return`${d}m`}function It(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${(l/1000).toFixed(1)}k`;return String(Math.round(l))}function Ht(l){if(l==null)return"—";return`${Math.round(l)}%`}var pt="—";class dt extends n{static properties={card:{attribute:!1}};static styles=$t;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return St(this.card.state)}open(){this.dispatchEvent(new it(this.card.id,this.card.project??null))}act(l,d){this.dispatchEvent(new nt(l,this.card.id,this.card.project??null,d))}draft(l){this.dispatchEvent(new rt(this.card.id,this.card.project??null,l))}statusWord(){return Et(this.card.state)}render(){let l=this.card,d=this.tone(),f=l.metrics??null,g=l.ageS==null?pt:Z(l.ageS),v=l.ageS==null?"age unknown":`open ${m(l.ageS)}`,y=l.executors??[],w=l.executorPick??"",T=l.effortOptions??[],M=l.effortPick??"",z=l.pendingAction??"",S=(_,X)=>z===_?`${X}…`:X,I=(_)=>z===_,H=(_)=>z===_?"true":"false";return e`
			${l.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${d}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${v}>${g}</span>
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
						<b title=${l.model??""}>${l.model??pt}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${l.host??""}>${l.host??pt}</b>
					</div>
				</div>
				<hr class="rule" />
				${l.warn?e`<div class="warn" role="note">
							<span class="wl">${Mt(l.warn)}</span>
							<span class="wt" title=${l.warn}>${At(l.warn)}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${Rt(f?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${Ct(f?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${It(f?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${Ht(f?.cachePct)}</span>
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
							?disabled=${I("retry")}
							aria-busy=${H("retry")}
							@click=${()=>this.act("retry")}
						>
							${S("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${I("recover")}
							aria-busy=${H("recover")}
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
											?selected=${_===(this.draftEffort??M)}
										>
											${_}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${I("start")}
							aria-busy=${H("start")}
							@click=${()=>this.act("start",{executor:this.draftExecutor??w,effort:this.draftEffort??M})}
						>
							${S("start","Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${d==="ready"&&!y.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${d==="working"&&!y.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${I("release")}
								aria-busy=${H("release")}
								@click=${()=>this.act("release")}
							>
								${S("release","Release ⏏")}
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
							?disabled=${I("reassign")}
							aria-busy=${H("reassign")}
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??w})}
						>
							${S("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${I("release")}
							aria-busy=${H("release")}
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
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var R=s(p(o())),j=s(p(u())),Ft=i({fresh:j,cached:j,out:j,wall_ms:j,model_groups:s(x(o(),b()))}),jt=i({state:o(),observed_at:j,source:R,progress:s(p(i({stage:A(["completed","reviewed","review-blocked","landed"]),ts:j})))}),Wt=i({text:R}),Vt=i({id:o(),project:R,title:R,state:o(),age_s:j,owner_sid:R,owner_label:R,origin:R,model:R,locality:R,parent_id:R,tag_color:R,failure_note:R,wait_kind:R,wait_reason:R,requires:R,blocked_by:s(a(o())),waiting_on:s(a(o())),spend:s(p(Ft)),execution:s(p(jt)),tail:s(p(Wt))});class q extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(l){let d=l.spend?.model_groups,f="",g=-1;if(d)for(let[v,y]of Object.entries(d)){let w=typeof y==="object"&&y!==null?Number(y.requests??0):0;if(Number.isFinite(w)&&w>g)f=v,g=w}return f||l.model||void 0}static hostOf(l){let d=l.owner_label?.trim();if(d&&d!==l.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(d))return d;return l.owner_sid??void 0}static metricsOf(l){let d=l.spend;if(!d)return;let f=d.fresh??void 0,g=d.cached??void 0,v=d.out??void 0,y=d.wall_ms??void 0,w=f===void 0&&g===void 0&&v===void 0?void 0:(f??0)+(g??0)+(v??0),T=y!==void 0&&y>0?y/60000:0,M=T>0&&v!==void 0?v/T:void 0,z=(f??0)+(g??0),S=z>0&&g!==void 0?g/z*100:void 0;return{tokens:w,wallMs:y,tokPerMin:M,cachePct:S}}static parentRefOf(l){return l.parent_id??void 0}contextLinesOf(l){let d=[],f=l.execution;if(f){let w=f.progress?.stage;d.push(w?`${f.state} · ${w}`:`${f.state} · no artifact evidence in snapshot`)}if(l.state==="WAITING"&&l.wait_reason)d.push(`${l.wait_kind??"external"} · ${l.wait_reason}`);let g=l.blocked_by??[];if(g.length)d.push(`waiting on ${g.join(", ")}`);let v=l.waiting_on??[];if(v.length)d.push(`split into ${v.join(", ")}`);let y=l.tail?.text?.trim();if(y&&!d.includes(y))d.push(y);return d}modelOf(l){let d={id:l.id,project:l.project??void 0,title:l.title??void 0,state:l.state,ageS:l.age_s??void 0,contextLines:this.contextLinesOf(l),parentRef:q.parentRefOf(l),model:q.modelOf(l),host:q.hostOf(l),warn:l.failure_note??void 0,metrics:q.metricsOf(l),nested:this.hasAttribute("data-nested"),preferColor:l.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},f=zt.safeParse(d);return f.success?f.data:null}render(){let l=Vt.safeParse(this.t);if(!this.t||!l.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let d=l.data,f=this.modelOf(d);if(!f)return e``;let g=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${q.metricsOf(d)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${f}>${g}</klh-task-card>`}createRenderRoot(){return this}}var Yt=()=>{Y("klh-task-card-host",q),Y("klh-task-card",dt),Y("klh-card-activity",ct)};Yt();export{Yt as registerBoardElements};
