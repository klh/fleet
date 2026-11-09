// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
import{g,r,e,A,n}from"./lit-f18bcbfe556b7350.js";import{_,H,D,L,B}from"./lit-22703ef594dc5221.js";var C=1.5;var k=[15000,30000,60000,120000,180000,300000,600000,900000,1800000,3600000];function P(t,i,a,s=180000){let o=Array.from({length:a},()=>null);for(let l of t){let p=Math.floor((l[0]-i)/s);if(p>a-1)p=a-1;if(p<0)continue;let c=o[p];if(c==null)c={fresh:0,cached:0,out:0},o[p]=c;c.fresh+=l[1],c.cached+=l[2],c.out+=l[3]}return o}function V(t){return Math.max(1,Math.floor(t/6))*180000}function tt(t,i,a=k){let s=V(t);for(let o of a){if(o<i)continue;if(Math.ceil(s/o)*1<=t)return o}return a[a.length-1]}var W={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function G(t,i,a){if(!t.length)return W;let{POSITIVE_INFINITY:s,NEGATIVE_INFINITY:o}=Number;for(let h of t){if(h[0]<s)s=h[0];if(h[0]>o)o=h[0]}let l=1,p=V(i),c=Math.max(o-p,s);for(let h of t){if(h[0]<c)continue;if(h[4]!==void 0&&h[4]>l)l=h[4]}let m=tt(i,l),d=Math.max(1,Math.ceil(p/m)),u=a??Math.max(o-d*m,s),T=Math.ceil((o-u)/m)+1,x=Math.max(1,Math.min(d,T));return{bins:P(t,u,x,m),firstTs:s,windowStart:u,windowEnd:u+x*m,count:x,slotMs:m,startClipped:u>s,hasData:!0}}function q(t,i,a,s){let o=t.filter((u)=>u[0]>=i&&u[0]<=a);if(!o.length)return W;let l=Math.max(1,a-i),p=1;for(let u of o)if(u[4]!==void 0&&u[4]>p)p=u[4];let c=k[k.length-1];for(let u of k){if(u<p)continue;if(Math.ceil(l/u)*1<=s){c=u;break}}let m=Math.max(1,Math.ceil(l/c)),d=Number.POSITIVE_INFINITY;for(let u of o)if(u[0]<d)d=u[0];return{bins:P(o,i,m,c),firstTs:d,windowStart:i,windowEnd:i+m*c,count:m,slotMs:c,startClipped:!1,hasData:!0}}function w(t){let i=new Date(t),a=(s)=>String(s).padStart(2,"0");return`${a(i.getHours())}:${a(i.getMinutes())}`}function E(t){if(t<60000)return`${Math.round(t/1000)}-second`;if(t<3600000)return`${Math.round(t/60000)}-minute`;return`${Math.round(t/3600000)}-hour`}function F(t,i,a=86400000){let s=i/2;if(t===null||t===void 0)return{visible:!1,center:s,half:0,start:s,end:s,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:s,half:0,start:s,end:s,saturated:!1};let o=Math.min(i/2,t/a*(i/2));return{visible:!0,center:s,half:o,start:s-o,end:s+o,saturated:t>=a}}function f(t){if(!Number.isFinite(t)||t<=0)return"0m";let i=Math.round(t/60000);if(i<60)return`${i}m`;return`${Math.floor(i/60)}h ${String(i%60).padStart(2,"0")}m`}function I(t=86400000){return`${t/3600000}h`}function b(t,i,a,s){let o=Math.max(1,a-i),l=(t-i)/o*s;return Math.max(0,Math.min(s,l))}function S(t){let i=[];for(let s of t.attempt.segments){if(s.end<=s.start)continue;i.push({kind:s.kind,start:s.start,end:s.end})}let a=[];for(let s of t.milestones){if(s.ts<t.windowStart||s.ts>t.windowEnd)continue;a.push({kind:"milestone",start:s.ts,end:s.ts,commit:s.commit,stage:s.stage})}return{segs:i,milestones:a}}function U(t,i,a,s,o){for(let l of t.milestones){let p=b(l.start,a,s,o);if(Math.abs(i-p)<=6)return l}for(let l of t.segs){let p=b(l.start,a,s,o),c=b(l.end,a,s,o);if(i>=p&&i<=Math.max(c,p+1))return l}return null}function y(t,i,a,s){if(t.kind==="milestone")return[`artifact · ${t.stage??""}`,a(t.start),`commit ${t.commit??""}`].join(`
`);let o=[`${t.kind} · ${s(t.end-t.start)}`,a(t.start,t.end)];if(t.kind==="firstbyte")o.push("first attributed ledger request — not network latency");if(t.kind==="tool")o.push("request-row minutes — not tool-call duration");if(t.kind==="unknown")o.push("no fact covers this gap");return o.push(`attempt ${i.attempt.index} · ${i.attempt.sid}`),o.join(`
`)}var N=13,Y=14,v=5;function X(t){let i=t.attempt.claimEnd??t.windowEnd,a=Math.min(i,t.windowEnd)-t.attempt.claimStart;return a>0?a:null}function R(t,i){return i===void 0?_(t):B(t,i).join(`
`)}function et(t,i){let{segs:a,milestones:s}=S(t),o=[];for(let l of a){let p=b(l.start,t.windowStart,t.windowEnd,i),c=Math.max(p+1,b(l.end,t.windowStart,t.windowEnd,i));o.push(A`<rect
				class="at-${l.kind}"
				x=${p.toFixed(1)}
				y=${N}
				width=${(c-p).toFixed(1)}
				height=${Y}
				rx="2"
			/>`)}for(let l of s){let p=b(l.start,t.windowStart,t.windowEnd,i),c=N+Y/2;o.push(A`<path
				class="at-ms"
				d="M ${p.toFixed(1)},${(c-v).toFixed(1)} l ${v},${v} l -${v},${v} l -${v},-${v} Z"
			/>`)}return e`${o}`}var O=(t)=>({kind:t.kind,start:t.start});function z(t){return{hover:(s,o)=>{let l=s.currentTarget;if(!o||!l){t.hide();return}let p=l.getBoundingClientRect();if(p.width===0)return;let c=U(S(o),s.clientX-p.left,o.windowStart,o.windowEnd,p.width);if(!c){t.hide();return}t.setTip(y(c,o,R,f),-1,O(c)),t.placeTip(s.clientX,s.clientY)},hide:()=>t.hide(),keydown:(s,o)=>{if(s.key==="Escape"){t.hide(),s.target.blur();return}if(s.key!=="ArrowLeft"&&s.key!=="ArrowRight")return;s.preventDefault();let l=t.slot(),{milestones:p,segs:c}=S(o),m=[...p,...c];if(!m.length)return;let d=s.key==="ArrowLeft"?-1:1,u=Math.max(0,Math.min(m.length-1,l+d)),T=m[u];if(!T)return;t.setTip(y(T,o,R,f),u,O(T));let x=s.currentTarget;if(x){let h=x.getBoundingClientRect(),Q=b(T.start,o.windowStart,o.windowEnd,h.width);t.placeTip(h.left+Q,h.top+8)}},slot:()=>t.slot()}}function K(t,i){return e`<div class="axis">
		<span>${w(t.windowStart)}</span>
		<span>${i} · ${t.binMs/60000}m/bin</span>
		<span>${w(t.windowEnd)}</span>
	</div>`}function j(t,i,a,s){return e`<svg
		class="plot"
		viewBox="0 0 ${i} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${t.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones${s?" over real token activity":""}"
		tabindex="0"
		@pointermove=${(o)=>a.hover(o,t)}
		@pointerleave=${()=>a.hide()}
		@keydown=${(o)=>a.keydown(o,t)}
	>
		${s}${et(t,i)}
	</svg>`}var Z=r`
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
`;var J=r`${g(`@charset "UTF-8";
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
}`)}`;class M extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[J,Z];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let i=this._plotEl()?.clientWidth??0;if(i!==this._width)this._width=i,this.requestUpdate()});let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}updated(){let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}update(t){if(super.update(t),!t.has("points")&&!t.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:s,segs:o}=S(this.attempt),l=[...s,...o],p=this._tipRef,c=l.findIndex((m)=>m.kind===p.kind&&m.start===p.start);if(c<0){this._hideTip();return}this._tip=y(l[c],this.attempt,R,f),this._slot=c;return}let i=this._spec;if(!i.hasData||this._tipTs===null){if(!i.hasData)this._hideTip();return}let a=Math.floor((this._tipTs-(i.windowStart??0))/i.slotMs);if(a<0||a>=i.count){this._hideTip();return}this._slot=a,this._tip=this._tipText(i,a)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return G(this.points,this._width||240)}_hover=(t)=>{let i=this._plotEl(),a=this._spec;if(!i||!a.hasData){this._hideTip();return}let s=i.getBoundingClientRect();if(s.width===0)return;let o=Math.max(0,Math.min(a.count-1,Math.floor((t.clientX-s.left)/s.width*a.count)));this._slot=o,this._tip=this._tipText(a,o),this._tipTs=(a.windowStart??0)+o*a.slotMs,this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let i=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let a=t.key==="ArrowLeft"?-1:1,s=Math.max(0,Math.min(i.count-1,this._slot+a));this._slot=s,this._tip=this._tipText(i,s),this._tipTs=(i.windowStart??0)+s*i.slotMs,this.requestUpdate();let o=this._plotEl();if(o){let l=o.getBoundingClientRect();this._placeTip(l.left+(s+0.5)/i.count*l.width,l.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(t,i){let a=t.bins[i],s=(t.windowStart??0)+i*t.slotMs,o=[_(s),`${H(s,D(s)!==L(s))} · ${E(t.slotMs)} bin`];if(a)o.push(`Fresh input ${a.fresh.toLocaleString("en-US")}`),o.push(`Cached input ${a.cached.toLocaleString("en-US")}`),o.push(`Output ${a.out.toLocaleString("en-US")}`);else o.push("no requests in this bin");return o.join(`
`)}_barsSvg(t){let a=(this._width||240)/t.count,s=Math.max(0.5,Math.min(C,a)),o=0;for(let p of t.bins)if(p)o=Math.max(o,p.fresh+p.cached);let l=[];if(o>0)for(let p=0;p<t.count;p++){let c=t.bins[p];if(!c)continue;let m=p*a+(a-s)/2;l.push(this._barRects(c,m,o,s))}if(!l.length)return e``;return A`<defs>
			<linearGradient id="klh-spec-fresh" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="1" />
				<stop offset="1" stop-color="var(--klh-chart-fresh, #8cbbad)" stop-opacity="0.45" />
			</linearGradient>
			<linearGradient id="klh-spec-cached" x1="0" y1="1" x2="0" y2="0">
				<stop offset="0" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.9" />
				<stop offset="1" stop-color="var(--klh-chart-cached, #5c7a35)" stop-opacity="0.4" />
			</linearGradient>
		</defs>
		${l}`}_barRects(t,i,a,s=C){let l=[],p=0,c=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[m,d]of c){if(m<=0)continue;let u=Math.max(0.5,m/a*38);l.push(A`<rect
					class=${d}
					x=${i.toFixed(1)}
					y=${Math.max(1,39-p-u).toFixed(1)}
					width=${s.toFixed(1)}
					height=${u.toFixed(1)}
				/>`),p+=u}return e`${l}`}_hairlineHtml(){let t=this._width||240,i=F(this._hairWallMs(),t);if(!i.visible)return null;return e`<div
			class="hairline${i.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${f(this._hairWallMs()??0)} of ${I()} scale${i.saturated?" — saturated at full width":""}"
			title="elapsed ${f(this._hairWallMs()??0)} of ${I()} scale${i.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${i.start.toFixed(1)}px;width:${(i.end-i.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let t=this._width||240,i=F(this._hairWallMs(),t);if(!i.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${f(this._hairWallMs()??0)} of ${I()} scale`+(i.saturated?" — saturated at full width":""),this.requestUpdate();let a=this._plotEl()?.getBoundingClientRect();if(a)this._placeTip(a.left+i.center/Math.max(1,t)*a.width,a.bottom+2)};_hairKey=(t)=>{if(t.key==="Escape")this._hideTip(),this.requestUpdate(),t.target.blur()};_axisHtml(t){let i=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?w(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${i} · ${E(t.slotMs)} bins`:"no activity"}</span
			>
			<span>${t.hasData?w(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),i=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(i/60)).padStart(2,"0")}:${String(i%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,i){let a=()=>{let o=this.renderRoot.querySelector(".tip");if(!o)return;let l=Math.min(t+10,window.innerWidth-o.offsetWidth-8),p=i-o.offsetHeight-10;o.style.left=`${Math.max(8,l)}px`,o.style.top=`${p>=8?p:i+12}px`};if(this.renderRoot.querySelector(".tip")){a();return}this.updateComplete.then(a).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?X(this.attempt):this.wallMs}get _stripHost(){return{setTip:(t,i,a)=>{this._tip=t,this._slot=i,this._tipRef=a??null,this.requestUpdate()},placeTip:(t,i)=>this._placeTip(t,i),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=z(this._stripHost);_renderAttempt(){let t=this.attempt,i=this._width||240;if(!t){if(this._spec.hasData)return this._renderSpend();return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`}return e`
			${j(t,i,this._attemptHandlers,this._barsSvg(q(this.points,t.windowStart,t.windowEnd,i)))}
			${this._hairlineHtml()}
			${K(t,this._tzLabel())}
			${this._tip?this._tipHtml():null}
		`}_renderSpend(){let t=this._spec;return e`
			<svg
				class="plot"
				viewBox="0 0 ${this._width||240} 40"
				preserveAspectRatio="none"
				role="img"
				aria-label="Fresh and cached input tokens in ${E(t.slotMs)} bins across the measured track"
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
		`}render(){if(this.mode==="attempt")return this._renderAttempt();return this._renderSpend()}}
export{M};
