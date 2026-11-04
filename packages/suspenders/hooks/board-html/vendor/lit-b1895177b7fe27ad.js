// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
import{h,r,e,E,n}from"./lit-b59bf30faa0b21f8.js";import{k,F,O,Z,q}from"./lit-12b46f627c606484.js";var y=1.5;function z(t,i,o,s=180000){let a=Array.from({length:o},()=>null);for(let l of t){let p=Math.floor((l[0]-i)/s);if(p>o-1)p=o-1;if(p<0)continue;let c=a[p];if(c==null)c={fresh:0,cached:0,out:0},a[p]=c;c.fresh+=l[1],c.cached+=l[2],c.out+=l[3]}return a}function X(t,i,o=6,s=180000){let a=Math.max(1,Math.floor(i/o)),l=t;return{count:a,slotMs:s,start:l-a*s,end:l}}var K={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function B(t,i,o){if(!t.length)return K;let{POSITIVE_INFINITY:s,NEGATIVE_INFINITY:a}=Number;for(let d of t){if(d[0]<s)s=d[0];if(d[0]>a)a=d[0]}let l=X(a,i),p=o??Math.max(l.start,s),c=Math.ceil((a-p)/l.slotMs)+1,u=Math.max(1,Math.min(l.count,c));return{bins:z(t,p,u),firstTs:s,windowStart:p,windowEnd:p+u*l.slotMs,count:u,slotMs:l.slotMs,startClipped:p>s,hasData:!0}}function _(t){let i=new Date(t),o=(s)=>String(s).padStart(2,"0");return`${o(i.getHours())}:${o(i.getMinutes())}`}function A(t,i,o=86400000){let s=i/2;if(t===null||t===void 0)return{visible:!1,center:s,half:0,start:s,end:s,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:s,half:0,start:s,end:s,saturated:!1};let a=Math.min(i/2,t/o*(i/2));return{visible:!0,center:s,half:a,start:s-a,end:s+a,saturated:t>=o}}function m(t){if(!Number.isFinite(t)||t<=0)return"0m";let i=Math.round(t/60000);if(i<60)return`${i}m`;return`${Math.floor(i/60)}h ${String(i%60).padStart(2,"0")}m`}function w(t=86400000){return`${t/3600000}h`}function f(t,i,o,s){let a=Math.max(1,o-i),l=(t-i)/a*s;return Math.max(0,Math.min(s,l))}function v(t){let i=[];for(let s of t.attempt.segments){if(s.end<=s.start)continue;i.push({kind:s.kind,start:s.start,end:s.end})}let o=[];for(let s of t.milestones){if(s.ts<t.windowStart||s.ts>t.windowEnd)continue;o.push({kind:"milestone",start:s.ts,end:s.ts,commit:s.commit,stage:s.stage})}return{segs:i,milestones:o}}function L(t,i,o,s,a){for(let l of t.milestones){let p=f(l.start,o,s,a);if(Math.abs(i-p)<=6)return l}for(let l of t.segs){let p=f(l.start,o,s,a),c=f(l.end,o,s,a);if(i>=p&&i<=Math.max(c,p+1))return l}return null}function T(t,i,o,s){if(t.kind==="milestone")return[`artifact · ${t.stage??""}`,o(t.start),`commit ${t.commit??""}`].join(`
`);let a=[`${t.kind} · ${s(t.end-t.start)}`,o(t.start,t.end)];if(t.kind==="firstbyte")a.push("first attributed ledger request — not network latency");if(t.kind==="tool")a.push("request-row minutes — not tool-call duration");if(t.kind==="unknown")a.push("no fact covers this gap");return a.push(`attempt ${i.attempt.index} · ${i.attempt.sid}`),a.join(`
`)}var M=13,H=14,b=5;function P(t){let i=t.attempt.claimEnd??t.windowEnd,o=Math.min(i,t.windowEnd)-t.attempt.claimStart;return o>0?o:null}function g(t,i){return i===void 0?k(t):q(t,i).join(`
`)}function j(t,i){let{segs:o,milestones:s}=v(t),a=[];for(let l of o){let p=f(l.start,t.windowStart,t.windowEnd,i),c=Math.max(p+1,f(l.end,t.windowStart,t.windowEnd,i));a.push(E`<rect
				class="at-${l.kind}"
				x=${p.toFixed(1)}
				y=${M}
				width=${(c-p).toFixed(1)}
				height=${H}
				rx="2"
			/>`)}for(let l of s){let p=f(l.start,t.windowStart,t.windowEnd,i),c=M+H/2;a.push(E`<path
				class="at-ms"
				d="M ${p.toFixed(1)},${(c-b).toFixed(1)} l ${b},${b} l -${b},${b} l -${b},-${b} Z"
			/>`)}return e`${a}`}var D=(t)=>({kind:t.kind,start:t.start});function Y(t){return{hover:(s,a)=>{let l=s.currentTarget;if(!a||!l){t.hide();return}let p=l.getBoundingClientRect();if(p.width===0)return;let c=L(v(a),s.clientX-p.left,a.windowStart,a.windowEnd,p.width);if(!c){t.hide();return}t.setTip(T(c,a,g,m),-1,D(c)),t.placeTip(s.clientX,s.clientY)},hide:()=>t.hide(),keydown:(s,a)=>{if(s.key==="Escape"){t.hide(),s.target.blur();return}if(s.key!=="ArrowLeft"&&s.key!=="ArrowRight")return;s.preventDefault();let l=t.slot(),{milestones:p,segs:c}=v(a),u=[...p,...c];if(!u.length)return;let d=s.key==="ArrowLeft"?-1:1,I=Math.max(0,Math.min(u.length-1,l+d)),x=u[I];if(!x)return;t.setTip(T(x,a,g,m),I,D(x));let C=s.currentTarget;if(C){let S=C.getBoundingClientRect(),U=f(x.start,a.windowStart,a.windowEnd,S.width);t.placeTip(S.left+U,S.top+8)}},slot:()=>t.slot()}}function G(t,i){return e`<div class="axis">
		<span>${_(t.windowStart)}</span>
		<span>${i} · ${t.binMs/60000}m/bin</span>
		<span>${_(t.windowEnd)}</span>
	</div>`}function N(t,i,o){return e`<svg
		class="plot"
		viewBox="0 0 ${i} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${t.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(s)=>o.hover(s,t)}
		@pointerleave=${()=>o.hide()}
		@keydown=${(s)=>o.keydown(s,t)}
	>
		${j(t,i)}
	</svg>`}var V=r`
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
`;var W=r`${h(`@charset "UTF-8";
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
}`)}`;class R extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[W,V];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let i=this._plotEl()?.clientWidth??0;if(i!==this._width)this._width=i,this.requestUpdate()});let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}updated(){let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}update(t){if(super.update(t),!t.has("points")&&!t.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:s,segs:a}=v(this.attempt),l=[...s,...a],p=this._tipRef,c=l.findIndex((u)=>u.kind===p.kind&&u.start===p.start);if(c<0){this._hideTip();return}this._tip=T(l[c],this.attempt,g,m),this._slot=c;return}let i=this._spec;if(!i.hasData||this._tipTs===null){if(!i.hasData)this._hideTip();return}let o=Math.floor((this._tipTs-(i.windowStart??0))/i.slotMs);if(o<0||o>=i.count){this._hideTip();return}this._slot=o,this._tip=this._tipText(i,o)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return B(this.points,this._width||240)}_hover=(t)=>{let i=this._plotEl(),o=this._spec;if(!i||!o.hasData){this._hideTip();return}let s=i.getBoundingClientRect();if(s.width===0)return;let a=Math.max(0,Math.min(o.count-1,Math.floor((t.clientX-s.left)/s.width*o.count)));this._slot=a,this._tip=this._tipText(o,a),this._tipTs=(o.windowStart??0)+a*o.slotMs,this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let i=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let o=t.key==="ArrowLeft"?-1:1,s=Math.max(0,Math.min(i.count-1,this._slot+o));this._slot=s,this._tip=this._tipText(i,s),this._tipTs=(i.windowStart??0)+s*i.slotMs,this.requestUpdate();let a=this._plotEl();if(a){let l=a.getBoundingClientRect();this._placeTip(l.left+(s+0.5)/i.count*l.width,l.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(t,i){let o=t.bins[i],s=(t.windowStart??0)+i*t.slotMs,a=[k(s),`${F(s,O(s)!==Z(s))} · ${t.slotMs/60000}-minute bin`];if(o)a.push(`Fresh input ${o.fresh.toLocaleString("en-US")}`),a.push(`Cached input ${o.cached.toLocaleString("en-US")}`),a.push(`Output ${o.out.toLocaleString("en-US")}`);else a.push("no requests in this bin");return a.join(`
`)}_barsSvg(t){let o=(this._width||240)/t.count,s=0;for(let l of t.bins)if(l)s=Math.max(s,l.fresh+l.cached);let a=[];if(s>0)for(let l=0;l<t.count;l++){let p=t.bins[l];if(!p)continue;let c=l*o+(o-y)/2;a.push(this._barRects(p,c,s))}if(!a.length)return e``;return E`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${a}`}_barRects(t,i,o){let a=[],l=0,p=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[c,u]of p){if(c<=0)continue;let d=Math.max(0.5,c/o*38);a.push(E`<rect
					class=${u}
					x=${i.toFixed(1)}
					y=${Math.max(1,39-l-d).toFixed(1)}
					width=${y}
					height=${d.toFixed(1)}
				/>`),l+=d}return e`${a}`}_hairlineHtml(){let t=this._width||240,i=A(this._hairWallMs(),t);if(!i.visible)return null;return e`<div
			class="hairline${i.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${m(this._hairWallMs()??0)} of ${w()} scale${i.saturated?" — saturated at full width":""}"
			title="elapsed ${m(this._hairWallMs()??0)} of ${w()} scale${i.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${i.start.toFixed(1)}px;width:${(i.end-i.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let t=this._width||240,i=A(this._hairWallMs(),t);if(!i.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${m(this._hairWallMs()??0)} of ${w()} scale`+(i.saturated?" — saturated at full width":""),this.requestUpdate();let o=this._plotEl()?.getBoundingClientRect();if(o)this._placeTip(o.left+i.center/Math.max(1,t)*o.width,o.bottom+2)};_hairKey=(t)=>{if(t.key==="Escape")this._hideTip(),this.requestUpdate(),t.target.blur()};_axisHtml(t){let i=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?_(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${i} · ${t.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${t.hasData?_(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),i=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(i/60)).padStart(2,"0")}:${String(i%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,i){let o=()=>{let a=this.renderRoot.querySelector(".tip");if(!a)return;let l=Math.min(t+10,window.innerWidth-a.offsetWidth-8),p=i-a.offsetHeight-10;a.style.left=`${Math.max(8,l)}px`,a.style.top=`${p>=8?p:i+12}px`};if(this.renderRoot.querySelector(".tip")){o();return}this.updateComplete.then(o).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?P(this.attempt):this.wallMs}get _stripHost(){return{setTip:(t,i,o)=>{this._tip=t,this._slot=i,this._tipRef=o??null,this.requestUpdate()},placeTip:(t,i)=>this._placeTip(t,i),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=Y(this._stripHost);_renderAttempt(){let t=this.attempt,i=this._width||240;if(!t)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${N(t,i,this._attemptHandlers)}
			${this._hairlineHtml()}
			${G(t,this._tzLabel())}
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
		`}}
export{R};
