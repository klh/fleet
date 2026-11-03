import{d,r,e,x,t,n}from"./lit-9ab93f5debb235da.js";import{h,y,P,s,c,T,m,a,i,g,S,o,u}from"./lit-0a9982d0e15be9ce.js";import{f,I,A,M,L}from"./lit-bbcd2c46a367dbcd.js";var Ct=new Set,U=(l,p)=>{if(customElements.get(l))throw Error(`defineElement: <${l}> is already defined — ONE register point per workspace`);Ct.add(l),customElements.define(l,p)};var st=1.5;var It=[15000,30000,60000,120000,180000,300000,600000,900000,1800000,3600000];function Ht(l,p,v,b=180000){let k=Array.from({length:v},()=>null);for(let w of l){let _=Math.floor((w[0]-p)/b);if(_>v-1)_=v-1;if(_<0)continue;let z=k[_];if(z==null)z={fresh:0,cached:0,out:0},k[_]=z;z.fresh+=w[1],z.cached+=w[2],z.out+=w[3]}return k}function dt(l){return Math.max(1,Math.floor(l/6))*180000}function Ot(l,p,v=It){let b=dt(l);for(let k of v){if(k<p)continue;if(Math.ceil(b/k)*1<=l)return k}return v[v.length-1]}var Pt={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function ut(l,p,v){if(!l.length)return Pt;let{POSITIVE_INFINITY:b,NEGATIVE_INFINITY:k}=Number;for(let E of l){if(E[0]<b)b=E[0];if(E[0]>k)k=E[0]}let w=1,_=dt(p),z=Math.max(k-_,b);for(let E of l){if(E[0]<z)continue;if(E[4]!==void 0&&E[4]>w)w=E[4]}let R=Ot(p,w),O=Math.max(1,Math.ceil(_/R)),C=v??Math.max(k-O*R,b),N=Math.ceil((k-C)/R)+1,B=Math.max(1,Math.min(O,N));return{bins:Ht(l,C,B,R),firstTs:b,windowStart:C,windowEnd:C+B*R,count:B,slotMs:R,startClipped:C>b,hasData:!0}}function Y(l){let p=new Date(l),v=(b)=>String(b).padStart(2,"0");return`${v(p.getHours())}:${v(p.getMinutes())}`}function J(l){if(l<60000)return`${Math.round(l/1000)}-second`;if(l<3600000)return`${Math.round(l/60000)}-minute`;return`${Math.round(l/3600000)}-hour`}function it(l,p,v=86400000){let b=p/2;if(l===null||l===void 0)return{visible:!1,center:b,half:0,start:b,end:b,saturated:!1};if(!Number.isFinite(l)||l<=0)return{visible:!1,center:b,half:0,start:b,end:b,saturated:!1};let k=Math.min(p/2,l/v*(p/2));return{visible:!0,center:b,half:k,start:b-k,end:b+k,saturated:l>=v}}function q(l){if(!Number.isFinite(l)||l<=0)return"0m";let p=Math.round(l/60000);if(p<60)return`${p}m`;return`${Math.floor(p/60)}h ${String(p%60).padStart(2,"0")}m`}function Q(l=86400000){return`${l/3600000}h`}function j(l,p,v,b){let k=Math.max(1,v-p),w=(l-p)/k*b;return Math.max(0,Math.min(b,w))}function G(l){let p=[];for(let b of l.attempt.segments){if(b.end<=b.start)continue;p.push({kind:b.kind,start:b.start,end:b.end})}let v=[];for(let b of l.milestones){if(b.ts<l.windowStart||b.ts>l.windowEnd)continue;v.push({kind:"milestone",start:b.ts,end:b.ts,commit:b.commit,stage:b.stage})}return{segs:p,milestones:v}}function ht(l,p,v,b,k){for(let w of l.milestones){let _=j(w.start,v,b,k);if(Math.abs(p-_)<=6)return w}for(let w of l.segs){let _=j(w.start,v,b,k),z=j(w.end,v,b,k);if(p>=_&&p<=Math.max(z,_+1))return w}return null}function X(l,p,v,b){if(l.kind==="milestone")return[`artifact · ${l.stage??""}`,v(l.start),`commit ${l.commit??""}`].join(`
`);let k=[`${l.kind} · ${b(l.end-l.start)}`,v(l.start,l.end)];if(l.kind==="firstbyte")k.push("first attributed ledger request — not network latency");if(l.kind==="tool")k.push("request-row minutes — not tool-call duration");if(l.kind==="unknown")k.push("no fact covers this gap");return k.push(`attempt ${p.attempt.index} · ${p.attempt.sid}`),k.join(`
`)}var at=13,ot=14,F=5;function mt(l){let p=l.attempt.claimEnd??l.windowEnd,v=Math.min(p,l.windowEnd)-l.attempt.claimStart;return v>0?v:null}function tt(l,p){return p===void 0?f(l):L(l,p).join(`
`)}function Lt(l,p){let{segs:v,milestones:b}=G(l),k=[];for(let w of v){let _=j(w.start,l.windowStart,l.windowEnd,p),z=Math.max(_+1,j(w.end,l.windowStart,l.windowEnd,p));k.push(x`<rect
				class="at-${w.kind}"
				x=${_.toFixed(1)}
				y=${at}
				width=${(z-_).toFixed(1)}
				height=${ot}
				rx="2"
			/>`)}for(let w of b){let _=j(w.start,l.windowStart,l.windowEnd,p),z=at+ot/2;k.push(x`<path
				class="at-ms"
				d="M ${_.toFixed(1)},${(z-F).toFixed(1)} l ${F},${F} l -${F},${F} l -${F},-${F} Z"
			/>`)}return e`${k}`}var ft=(l)=>({kind:l.kind,start:l.start});function gt(l){return{hover:(b,k)=>{let w=b.currentTarget;if(!k||!w){l.hide();return}let _=w.getBoundingClientRect();if(_.width===0)return;let z=ht(G(k),b.clientX-_.left,k.windowStart,k.windowEnd,_.width);if(!z){l.hide();return}l.setTip(X(z,k,tt,q),-1,ft(z)),l.placeTip(b.clientX,b.clientY)},hide:()=>l.hide(),keydown:(b,k)=>{if(b.key==="Escape"){l.hide(),b.target.blur();return}if(b.key!=="ArrowLeft"&&b.key!=="ArrowRight")return;b.preventDefault();let w=l.slot(),{milestones:_,segs:z}=G(k),R=[..._,...z];if(!R.length)return;let O=b.key==="ArrowLeft"?-1:1,C=Math.max(0,Math.min(R.length-1,w+O)),N=R[C];if(!N)return;l.setTip(X(N,k,tt,q),C,ft(N));let B=b.currentTarget;if(B){let E=B.getBoundingClientRect(),Z=j(N.start,k.windowStart,k.windowEnd,E.width);l.placeTip(E.left+Z,E.top+8)}},slot:()=>l.slot()}}function bt(l,p){return e`<div class="axis">
		<span>${Y(l.windowStart)}</span>
		<span>${p} · ${l.binMs/60000}m/bin</span>
		<span>${Y(l.windowEnd)}</span>
	</div>`}function vt(l,p,v){return e`<svg
		class="plot"
		viewBox="0 0 ${p} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${l.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(b)=>v.hover(b,l)}
		@pointerleave=${()=>v.hide()}
		@keydown=${(b)=>v.keydown(b,l)}
	>
		${Lt(l,p)}
	</svg>`}var xt=r`
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
`;var kt=r`${d(`@charset "UTF-8";
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
}`)}`;class lt extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[kt,xt];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let p=this._plotEl()?.clientWidth??0;if(p!==this._width)this._width=p,this.requestUpdate()});let l=this._plotEl();if(l&&this._ro)this._ro.observe(l)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let l=this._plotEl();if(l&&this._ro)this._width=l.clientWidth,this._ro.observe(l)}updated(){let l=this._plotEl();if(l&&this._ro)this._ro.observe(l)}update(l){if(super.update(l),!l.has("points")&&!l.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:b,segs:k}=G(this.attempt),w=[...b,...k],_=this._tipRef,z=w.findIndex((R)=>R.kind===_.kind&&R.start===_.start);if(z<0){this._hideTip();return}this._tip=X(w[z],this.attempt,tt,q),this._slot=z;return}let p=this._spec;if(!p.hasData||this._tipTs===null){if(!p.hasData)this._hideTip();return}let v=Math.floor((this._tipTs-(p.windowStart??0))/p.slotMs);if(v<0||v>=p.count){this._hideTip();return}this._slot=v,this._tip=this._tipText(p,v)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return ut(this.points,this._width||240)}_hover=(l)=>{let p=this._plotEl(),v=this._spec;if(!p||!v.hasData){this._hideTip();return}let b=p.getBoundingClientRect();if(b.width===0)return;let k=Math.max(0,Math.min(v.count-1,Math.floor((l.clientX-b.left)/b.width*v.count)));this._slot=k,this._tip=this._tipText(v,k),this._tipTs=(v.windowStart??0)+k*v.slotMs,this.requestUpdate(),this._placeTip(l.clientX,l.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(l)=>{let p=this._spec;if(l.key==="Escape"){this._hide();return}if(l.key!=="ArrowLeft"&&l.key!=="ArrowRight")return;l.preventDefault();let v=l.key==="ArrowLeft"?-1:1,b=Math.max(0,Math.min(p.count-1,this._slot+v));this._slot=b,this._tip=this._tipText(p,b),this._tipTs=(p.windowStart??0)+b*p.slotMs,this.requestUpdate();let k=this._plotEl();if(k){let w=k.getBoundingClientRect();this._placeTip(w.left+(b+0.5)/p.count*w.width,w.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(l,p){let v=l.bins[p],b=(l.windowStart??0)+p*l.slotMs,k=[f(b),`${I(b,A(b)!==M(b))} · ${J(l.slotMs)} bin`];if(v)k.push(`Fresh input ${v.fresh.toLocaleString("en-US")}`),k.push(`Cached input ${v.cached.toLocaleString("en-US")}`),k.push(`Output ${v.out.toLocaleString("en-US")}`);else k.push("no requests in this bin");return k.join(`
`)}_barsSvg(l){let v=(this._width||240)/l.count,b=Math.max(0.5,Math.min(st,v)),k=0;for(let _ of l.bins)if(_)k=Math.max(k,_.fresh+_.cached);let w=[];if(k>0)for(let _=0;_<l.count;_++){let z=l.bins[_];if(!z)continue;let R=_*v+(v-b)/2;w.push(this._barRects(z,R,k,b))}if(!w.length)return e``;return x`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${w}`}_barRects(l,p,v,b=st){let w=[],_=0,z=[[l.fresh,"spark-fresh"],[l.cached,"spark-cached"]];for(let[R,O]of z){if(R<=0)continue;let C=Math.max(0.5,R/v*38);w.push(x`<rect
					class=${O}
					x=${p.toFixed(1)}
					y=${Math.max(1,39-_-C).toFixed(1)}
					width=${b.toFixed(1)}
					height=${C.toFixed(1)}
				/>`),_+=C}return e`${w}`}_hairlineHtml(){let l=this._width||240,p=it(this._hairWallMs(),l);if(!p.visible)return null;return e`<div
			class="hairline${p.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${q(this._hairWallMs()??0)} of ${Q()} scale${p.saturated?" — saturated at full width":""}"
			title="elapsed ${q(this._hairWallMs()??0)} of ${Q()} scale${p.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${p.start.toFixed(1)}px;width:${(p.end-p.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let l=this._width||240,p=it(this._hairWallMs(),l);if(!p.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${q(this._hairWallMs()??0)} of ${Q()} scale`+(p.saturated?" — saturated at full width":""),this.requestUpdate();let v=this._plotEl()?.getBoundingClientRect();if(v)this._placeTip(v.left+p.center/Math.max(1,l)*v.width,v.bottom+2)};_hairKey=(l)=>{if(l.key==="Escape")this._hideTip(),this.requestUpdate(),l.target.blur()};_axisHtml(l){let p=this._tzLabel();return e`<div class="axis">
			<span>${l.hasData?Y(l.windowStart??0):""}</span>
			<span
				>${l.hasData?`${p} · ${J(l.slotMs)} bins`:"no activity"}</span
			>
			<span>${l.hasData?Y(l.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let l=-new Date().getTimezoneOffset(),p=Math.abs(l);return`UTC${l>=0?"+":"-"}${String(Math.floor(p/60)).padStart(2,"0")}:${String(p%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(l,p){let v=()=>{let k=this.renderRoot.querySelector(".tip");if(!k)return;let w=Math.min(l+10,window.innerWidth-k.offsetWidth-8),_=p-k.offsetHeight-10;k.style.left=`${Math.max(8,w)}px`,k.style.top=`${_>=8?_:p+12}px`};if(this.renderRoot.querySelector(".tip")){v();return}this.updateComplete.then(v).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?mt(this.attempt):this.wallMs}get _stripHost(){return{setTip:(l,p,v)=>{this._tip=l,this._slot=p,this._tipRef=v??null,this.requestUpdate()},placeTip:(l,p)=>this._placeTip(l,p),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=gt(this._stripHost);_renderAttempt(){let l=this.attempt,p=this._width||240;if(!l)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${vt(l,p,this._attemptHandlers)}
			${this._hairlineHtml()}
			${bt(l,this._tzLabel())}
			${this._tip?this._tipHtml():null}
		`}render(){if(this.mode==="attempt")return this._renderAttempt();let l=this._spec;return e`
			<svg
				class="plot"
				viewBox="0 0 ${this._width||240} 40"
				preserveAspectRatio="none"
				role="img"
				aria-label="Fresh and cached input tokens in ${J(l.slotMs)} bins across the measured track"
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
		`}}var yt=r`${d(`@charset "UTF-8";
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
}`)}`;class et extends h{static eventName="task-card-action-requested";action;id;project;executor;effort;constructor(l,p,v,b){super(et.eventName);this.action=l,this.id=p,this.project=v,this.executor=b?.executor,this.effort=b?.effort}}class nt extends h{static eventName="task-card-draft-changed";id;project;executor;effort;constructor(l,p,v){super(nt.eventName);this.id=l,this.project=p,this.executor=v?.executor,this.effort=v?.effort}}class rt extends h{static eventName="task-card-open-requested";id;project;constructor(l,p){super(rt.eventName);this.id=l,this.project=p}}function wt(l){if(l==="CLAIMED"||l==="RUNNING")return"working";if(l==="WAITING"||l==="BLOCKED"||l==="PAUSED")return"blocked";if(l==="SHATTERED")return"split";if(l==="FAILED")return"failed";if(l==="DONE")return"done";if(l==="CANCELLED")return"cancelled";return"ready"}function _t(l){if(l==="SHATTERED")return"split";return l.toLowerCase()}function Tt(l){return/^\s*BLOCKED\b/i.test(l)?"blocked":"warning"}function $t(l){return l.replace(/^\s*BLOCKED\b[\s:]+/i,"")||l}var D=o(u(s())),K=o(u(c())),Bt=i({value:s(),label:s(),badge:o(s()),reasoningEffort:o(T())}),Dt=i({tokens:K,wallMs:K,tokPerMin:K,cachePct:K}),Kt=i({mode:S(["spend","attempt"]),windowStartMs:K,windowEndMs:K,binMs:K,elapsedMs:K,scaleMs:K}),St=i({id:s(),project:D,title:D,state:s(),ageS:K,contextLines:o(a(s())),parentRef:D,model:D,host:D,warn:D,metrics:o(Dt),activity:o(Kt),nested:o(T()),preferColor:D,executors:o(a(Bt)),executorPick:D,effortOptions:o(a(s())),effortPick:D,pendingAction:D});function Et(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${Math.round(l/1000)}k`;return String(Math.round(l))}function Mt(l){if(l==null)return"—";if(l<60000)return`${Math.round(l/1000)}s`;let p=Math.round(l/60000);if(p>=60)return`${Math.floor(p/60)}h${String(p%60).padStart(2,"0")}m`;return`${p}m`}function At(l){if(l==null)return"—";if(l>=1e6)return`${(l/1e6).toFixed(1)}M`;if(l>=1000)return`${(l/1000).toFixed(1)}k`;return String(Math.round(l))}function zt(l){if(l==null)return"—";return`${Math.round(l)}%`}var ct="—";class pt extends n{static properties={card:{attribute:!1}};static styles=yt;constructor(){super();this.card={id:"",state:"READY"}}draftId;draftExecutor;draftEffort;tone(){return wt(this.card.state)}open(){this.dispatchEvent(new rt(this.card.id,this.card.project??null))}act(l,p){this.dispatchEvent(new et(l,this.card.id,this.card.project??null,p))}draft(l){this.dispatchEvent(new nt(this.card.id,this.card.project??null,l))}statusWord(){return _t(this.card.state)}render(){let l=this.card,p=this.tone(),v=l.metrics??null,b=l.ageS==null?ct:P(l.ageS),k=l.ageS==null?"age unknown":`open ${y(l.ageS)}`,w=l.executors??[],_=l.executorPick??"",z=l.effortOptions??[],R=l.effortPick??"",O=l.pendingAction??"",C=(E,Z)=>O===E?`${Z}…`:Z,N=(E)=>O===E,B=(E)=>O===E?"true":"false";return e`
			${l.nested?e`<span class="elbow" aria-hidden="true">↳</span>`:t}
			<div class="wrap">
				<div class="pad">
				<div class="head">
					<span class="sq" data-tone=${p}></span>
					<span class="stw">${this.statusWord()}</span>
					<span class="age" title=${k}>${b}</span>
				</div>
				<button class="tid" type="button" @click=${this.open}>
					${l.id}
				</button>
				${l.title?e`<div class="title" title=${l.title}>${l.title}</div>`:t}
				${(l.contextLines??[]).map((E)=>e`<div class="ctx" title=${E}>${E}</div>`)}
				${l.parentRef?e`<div class="ctx" title=${`parent ${l.parentRef}`}
							>↳ ${l.parentRef}</div
						>`:t}
				<hr class="rule" />
				<div class="cols">
					<div class="col">
						<span class="lab">model</span>
						<b title=${l.model??""}>${l.model??ct}</b>
					</div>
					<div class="col">
						<span class="lab">host</span>
						<b title=${l.host??""}>${l.host??ct}</b>
					</div>
				</div>
				<hr class="rule" />
				${l.warn?e`<div class="warn" role="note">
							<span class="wl">${Tt(l.warn)}</span>
							<span class="wt" title=${l.warn}>${$t(l.warn)}</span>
						</div>`:t}
				<div class="metrics">
					<div class="m">
						<span class="mv">${Et(v?.tokens)}</span>
						<span class="ml">tokens</span>
					</div>
					<div class="m">
						<span class="mv">${Mt(v?.wallMs)}</span>
						<span class="ml">time</span>
					</div>
					<div class="m">
						<span class="mv">${At(v?.tokPerMin)}</span>
						<span class="ml">tok/min</span>
					</div>
					<div class="m">
						<span class="mv">${zt(v?.cachePct)}</span>
						<span class="ml">cache</span>
					</div>
				</div>
				<slot class="details" name="details"></slot>
				</div>
				<slot class="activity" name="activity"></slot>
			</div>
			<footer>
				${p==="failed"?e`<button
							class="seg retry"
							type="button"
							?disabled=${N("retry")}
							aria-busy=${B("retry")}
							@click=${()=>this.act("retry")}
						>
							${C("retry","Retry")}
						</button>
						<button
							class="seg recover"
							type="button"
							?disabled=${N("recover")}
							aria-busy=${B("recover")}
							@click=${()=>this.act("recover")}
						>
							${C("recover","Recover → Ready")}
						</button>
						<button
							class="seg prompt"
							type="button"
							@click=${()=>this.act("prompt")}
						>
							Prompt ↗
						</button>`:t}
				${p==="ready"&&w.length?e`<select
							class="seg"
							aria-label=${`executor for ${l.id}`}
							@change=${(E)=>{this.draftExecutor=E.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${w.map((E)=>e`<option
									value=${E.value}
									?selected=${E.value===(this.draftExecutor??_)}
								>
									${E.badge??""}${E.label}
								</option>`)}
						</select>
						${z.length?e`<select
									class="seg"
									aria-label=${`reasoning effort for ${l.id}`}
									@change=${(E)=>{this.draftEffort=E.target.value,this.draft({effort:this.draftEffort})}}
								>
									${z.map((E)=>e`<option
											value=${E}
											?selected=${E===(this.draftEffort??R)}
										>
											${E}
										</option>`)}
								</select>`:t}
						<button
							class="seg start"
							type="button"
							title="dispatch on the chosen executor"
							?disabled=${N("start")}
							aria-busy=${B("start")}
							@click=${()=>this.act("start",{executor:this.draftExecutor??_,effort:this.draftEffort??R})}
						>
							${C("start","Start ▶")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${p==="ready"&&!w.length?e`<span class="spacer"></span>${this.promptSeg()}`:t}
				${p==="working"&&!w.length?e`<button
								class="seg release"
								type="button"
								title="release the claim — a live lane banks its capsule and exits"
								?disabled=${N("release")}
								aria-busy=${B("release")}
								@click=${()=>this.act("release")}
							>
								${C("release","Release ⏏")}
							</button>
							<span class="spacer"></span>
							${this.promptSeg()}`:t}
				${p==="working"&&w.length?e`<select
							class="seg"
							aria-label=${`reassign executor for ${l.id}`}
							@change=${(E)=>{this.draftExecutor=E.target.value,this.draft({executor:this.draftExecutor})}}
						>
							${w.map((E)=>e`<option
									value=${E.value}
									?selected=${E.value===(this.draftExecutor??_)}
								>
									${E.badge??""}${E.label}
								</option>`)}
						</select>
						<button
							class="seg reassign"
							type="button"
							title="release + re-dispatch on the chosen executor"
							?disabled=${N("reassign")}
							aria-busy=${B("reassign")}
							@click=${()=>this.act("reassign",{executor:this.draftExecutor??_})}
						>
							${C("reassign","Reassign ↻")}
						</button>
						<button
							class="seg release"
							type="button"
							title="release the claim — a live lane banks its capsule and exits"
							?disabled=${N("release")}
							aria-busy=${B("release")}
							@click=${()=>this.act("release")}
						>
							${C("release","Release ⏏")}
						</button>
						<span class="spacer"></span>
						${this.promptSeg()}`:t}
				${p==="done"?e`<span class="spacer"></span>
						<button
							class="seg tail report"
							type="button"
							title="open this item's report view"
							@click=${()=>this.act("report")}
						>
							Report ▸
						</button>
						${this.promptSeg()}`:t}
				${p!=="failed"&&p!=="ready"&&p!=="working"&&p!=="done"?e`<span class="spacer"></span>${this.promptSeg()}`:t}
			</footer>
		`}promptSeg(){return e`<button
			class="seg tail prompt"
			type="button"
			@click=${()=>this.act("prompt")}
		>
			Prompt ↗
		</button>`}willUpdate(){if(this.toggleAttribute("data-nested",!!this.card.nested),this.draftId!==this.card.id)this.draftId=this.card.id,this.draftExecutor=void 0,this.draftEffort=void 0;if(this.setAttribute("data-tone",this.tone()),this.card.preferColor)this.style.setProperty("--prefer",this.card.preferColor);else this.style.removeProperty("--prefer")}}var H=o(u(s())),V=o(u(c())),qt=i({fresh:V,cached:V,out:V,wall_ms:V,model_groups:o(g(s(),m()))}),jt=i({state:s(),observed_at:V,source:H,progress:o(u(i({stage:S(["completed","reviewed","review-blocked","landed"]),ts:V})))}),Ft=i({text:H}),Wt=i({id:s(),project:H,title:H,state:s(),age_s:V,owner_sid:H,owner_label:H,origin:H,model:H,locality:H,parent_id:H,tag_color:H,failure_note:H,wait_kind:H,wait_reason:H,requires:H,blocked_by:o(a(s())),waiting_on:o(a(s())),spend:o(u(qt)),execution:o(u(jt)),tail:o(u(Ft))});class W extends n{static properties={t:{attribute:!1},executors:{attribute:!1},executorPick:{attribute:!1},effortOptions:{attribute:!1},series:{attribute:!1},attempt:{attribute:!1},attemptView:{attribute:!1},pendingAction:{attribute:!1},draftPick:{attribute:!1},draftEffort:{attribute:!1}};static styles=r``;constructor(){super();this.t=null,this.executors=[],this.executorPick="",this.effortOptions=[],this.series=null,this.attempt=null,this.attemptView=!1,this.pendingAction="",this.draftPick=void 0,this.draftEffort=void 0}static modelOf(l){let p=l.spend?.model_groups,v="",b=-1;if(p)for(let[k,w]of Object.entries(p)){let _=typeof w==="object"&&w!==null?Number(w.requests??0):0;if(Number.isFinite(_)&&_>b)v=k,b=_}return v||l.model||void 0}static hostOf(l){let p=l.owner_label?.trim();if(p&&p!==l.owner_sid&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(p))return p;return l.owner_sid??void 0}static metricsOf(l){let p=l.spend;if(!p)return;let v=p.fresh??void 0,b=p.cached??void 0,k=p.out??void 0,w=p.wall_ms??void 0,_=v===void 0&&b===void 0&&k===void 0?void 0:(v??0)+(b??0)+(k??0),z=w!==void 0&&w>0?w/60000:0,R=z>0&&k!==void 0?k/z:void 0,O=(v??0)+(b??0),C=O>0&&b!==void 0?b/O*100:void 0;return{tokens:_,wallMs:w,tokPerMin:R,cachePct:C}}static parentRefOf(l){return l.parent_id??void 0}contextLinesOf(l){let p=[],v=l.execution;if(v){let _=v.progress?.stage;p.push(_?`${v.state} · ${_}`:`${v.state} · no artifact evidence in snapshot`)}if(l.state==="WAITING"&&l.wait_reason)p.push(`${l.wait_kind??"external"} · ${l.wait_reason}`);let b=l.blocked_by??[];if(b.length)p.push(`waiting on ${b.join(", ")}`);let k=l.waiting_on??[];if(k.length)p.push(`split into ${k.join(", ")}`);if(p.length)return p;let w=l.tail?.text?.trim();return w?[w]:[]}modelOf(l){let p={id:l.id,project:l.project??void 0,title:l.title??void 0,state:l.state,ageS:l.age_s??void 0,contextLines:this.contextLinesOf(l),parentRef:W.parentRefOf(l),model:W.modelOf(l),host:W.hostOf(l),warn:l.failure_note??void 0,metrics:W.metricsOf(l),nested:this.hasAttribute("data-nested"),preferColor:l.tag_color??void 0,executors:this.executors,executorPick:this.draftPick??this.executorPick,effortOptions:this.effortOptions,effortPick:this.draftEffort??"",pendingAction:this.pendingAction||void 0},v=St.safeParse(p);return v.success?v.data:null}render(){let l=Wt.safeParse(this.t);if(!this.t||!l.success)return e`<div class="kcard-invalid dim" role="note">
				card payload invalid
			</div>`;let p=l.data,v=this.modelOf(p);if(!v)return e``;let b=this.series||this.attempt?e`<klh-card-activity
						slot="activity"
						.points=${this.series??[]}
						.wallMs=${W.metricsOf(p)?.wallMs??null}
						.attempt=${this.attempt}
						.mode=${this.attemptView?"attempt":"spend"}
					></klh-card-activity>`:null;return e`<klh-task-card .card=${v}>${b}</klh-task-card>`}createRenderRoot(){return this}}var Vt=()=>{U("klh-task-card-host",W),U("klh-task-card",pt),U("klh-card-activity",lt)};Vt();export{Vt as registerBoardElements};
