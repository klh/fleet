import{r,e,c,n}from"./lit-2f0d70419e37a5ce.js";import{s,i}from"./lit-f0b5670216be6815.js";var M=4;function V(t,o,l,a=180000){let p=Array.from({length:l},()=>null);for(let u of t){let m=Math.floor((u[0]-o)/a);if(m>l-1)m=l-1;if(m<0)continue;let d=p[m];if(d===null)d={fresh:0,cached:0,out:0},p[m]=d;d.fresh+=u[1],d.cached+=u[2],d.out+=u[3]}return p}function Y(t,o,l=6,a=180000){let p=Math.max(1,Math.floor(o/l)),u=t;return{count:p,slotMs:a,start:u-p*a,end:u}}var U={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function I(t,o,l){if(!t.length)return U;let{POSITIVE_INFINITY:a,NEGATIVE_INFINITY:p}=Number;for(let h of t){if(h[0]<a)a=h[0];if(h[0]>p)p=h[0]}let u=Y(p,o),m=l??Math.max(u.start,a),d=Math.ceil((p-m)/u.slotMs)+1,f=Math.max(1,Math.min(u.count,d));return{bins:V(t,m,f),firstTs:a,windowStart:m,windowEnd:m+f*u.slotMs,count:f,slotMs:u.slotMs,startClipped:m>a,hasData:!0}}function x(t){let o=new Date(t),l=(a)=>String(a).padStart(2,"0");return`${l(o.getHours())}:${l(o.getMinutes())}`}function y(t,o,l=86400000){let a=o/2;if(t===null||t===void 0)return{visible:!1,center:a,half:0,start:a,end:a,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:a,half:0,start:a,end:a,saturated:!1};let p=Math.min(o/2,t/l*(o/2));return{visible:!0,center:a,half:p,start:a-p,end:a+p,saturated:t>=l}}function v(t){if(!Number.isFinite(t)||t<=0)return"0m";let o=Math.round(t/60000);if(o<60)return`${o}m`;return`${Math.floor(o/60)}h ${String(o%60).padStart(2,"0")}m`}function w(t=86400000){return`${t/3600000}h`}function b(t,o,l,a){let p=Math.max(1,l-o),u=(t-o)/p*a;return Math.max(0,Math.min(a,u))}function T(t){let o=[];for(let a of t.attempt.segments){if(a.end<=a.start)continue;o.push({kind:a.kind,start:a.start,end:a.end})}let l=[];for(let a of t.milestones){if(a.ts<t.windowStart||a.ts>t.windowEnd)continue;l.push({kind:"milestone",start:a.ts,end:a.ts,commit:a.commit,stage:a.stage})}return{segs:o,milestones:l}}function B(t,o,l,a,p){for(let u of t.milestones){let m=b(u.start,l,a,p);if(Math.abs(o-m)<=6)return u}for(let u of t.segs){let m=b(u.start,l,a,p),d=b(u.end,l,a,p);if(o>=m&&o<=Math.max(d,m+1))return u}return null}function A(t,o,l,a){if(t.kind==="milestone")return[`artifact · ${t.stage??""}`,l(t.start),`commit ${t.commit??""}`].join(`
`);let p=[`${t.kind} · ${a(t.end-t.start)}`,`${l(t.start)} → ${l(t.end)}`];if(t.kind==="firstbyte")p.push("first attributed ledger request — not network latency");if(t.kind==="tool")p.push("request-row minutes — not tool-call duration");if(t.kind==="unknown")p.push("no fact covers this gap");return p.push(`attempt ${o.attempt.index} · ${o.attempt.sid}`),p.join(`
`)}var k=13,E=14,_=5;function C(t){let o=t.attempt.claimEnd??t.windowEnd,l=Math.min(o,t.windowEnd)-t.attempt.claimStart;return l>0?l:null}function W(t,o){let{segs:l,milestones:a}=T(t),p=[];for(let u of l){let m=b(u.start,t.windowStart,t.windowEnd,o),d=Math.max(m+1,b(u.end,t.windowStart,t.windowEnd,o));p.push(c`<rect
				class="at-${u.kind}"
				x=${m.toFixed(1)}
				y=${k}
				width=${(d-m).toFixed(1)}
				height=${E}
				rx="2"
			/>`)}for(let u of a){let m=b(u.start,t.windowStart,t.windowEnd,o),d=k+E/2;p.push(c`<path
				class="at-ms"
				d="M ${m.toFixed(1)},${(d-_).toFixed(1)} l ${_},${_} l -${_},${_} l -${_},-${_} Z"
			/>`)}return e`${p}`}function L(t){return{hover:(a,p)=>{let u=a.currentTarget;if(!p||!u){t.hide();return}let m=u.getBoundingClientRect();if(m.width===0)return;let d=B(T(p),a.clientX-m.left,p.windowStart,p.windowEnd,m.width);if(!d){t.hide();return}t.setTip(A(d,p,s,v),-1),t.placeTip(a.clientX,a.clientY)},hide:()=>t.hide(),keydown:(a,p)=>{if(a.key==="Escape"){t.hide(),a.target.blur();return}if(a.key!=="ArrowLeft"&&a.key!=="ArrowRight")return;a.preventDefault();let u=t.slot(),{milestones:m,segs:d}=T(p),f=[...m,...d];if(!f.length)return;let h=a.key==="ArrowLeft"?-1:1,H=Math.max(0,Math.min(f.length-1,u+h)),g=f[H];if(!g)return;t.setTip(A(g,p,s,v),H);let R=a.currentTarget;if(R){let S=R.getBoundingClientRect(),q=b(g.start,p.windowStart,p.windowEnd,S.width);t.placeTip(S.left+q,S.top+8)}},slot:()=>t.slot()}}function F(t,o){return e`<div class="axis">
		<span>${x(t.windowStart)}</span>
		<span>${o} · ${t.binMs/60000}m/bin</span>
		<span>${x(t.windowEnd)}</span>
	</div>`}function P(t,o,l){return e`<svg
		class="plot"
		viewBox="0 0 ${o} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${t.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(a)=>l.hover(a,t)}
		@pointerleave=${()=>l.hide()}
		@keydown=${(a)=>l.keydown(a,t)}
	>
		${W(t,o)}
	</svg>`}var D=r`
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
`;class N extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[r`
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
		.plot rect.spark-fresh {
			fill: var(--klh-accent, #d8900f);
		}
		.plot rect.spark-cached {
			fill: var(--klh-ok, #5c7a35);
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
		}
	`,D];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let o=this._plotEl()?.clientWidth??0;if(o!==this._width)this._width=o,this.requestUpdate()});let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}updated(){let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}update(t){if(super.update(t),t.has("points")||t.has("attempt")){let o=this._spec,l=this.mode==="attempt"&&!this.attempt;if(!o.hasData||l)this._hideTip()}}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return I(this.points,this._width||240)}_hover=(t)=>{let o=this._plotEl(),l=this._spec;if(!o||!l.hasData){this._hideTip();return}let a=o.getBoundingClientRect();if(a.width===0)return;let p=Math.max(0,Math.min(l.count-1,Math.floor((t.clientX-a.left)/a.width*l.count)));this._slot=p,this._tip=this._tipText(l,p),this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let o=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let l=t.key==="ArrowLeft"?-1:1,a=Math.max(0,Math.min(o.count-1,this._slot+l));this._slot=a,this._tip=this._tipText(o,a),this.requestUpdate();let p=this._plotEl();if(p){let u=p.getBoundingClientRect();this._placeTip(u.left+(a+0.5)/o.count*u.width,u.top+8)}};_hideTip(){this._tip=null,this._slot=-1}_tipText(t,o){let l=t.bins[o],a=(t.windowStart??0)+o*t.slotMs,p=a+t.slotMs,u=[s(a),`bin ${t.slotMs/60000} min · ${i(a)} → ${i(p)}`];if(l)u.push(`Fresh input ${l.fresh.toLocaleString("en-US")}`),u.push(`Cached input ${l.cached.toLocaleString("en-US")}`),u.push(`Output ${l.out.toLocaleString("en-US")}`);else u.push("no requests in this bin");return u.join(`
`)}_barsSvg(t){let l=(this._width||240)/t.count,a=0;for(let u of t.bins)if(u)a=Math.max(a,u.fresh+u.cached);let p=[];if(a>0)for(let u=0;u<t.count;u++){let m=t.bins[u];if(!m)continue;let d=u*l+(l-M)/2;p.push(this._barRects(m,d,a))}return e`${p}`}_barRects(t,o,l){let p=[],u=0,m=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[d,f]of m){if(d<=0)continue;let h=Math.max(0.5,d/l*38);p.push(c`<rect
					class=${f}
					x=${o.toFixed(1)}
					y=${Math.max(1,39-u-h).toFixed(1)}
					width=${M}
					height=${h.toFixed(1)}
				/>`),u+=h}return e`${p}`}_hairlineHtml(){let t=this._width||240,o=y(this._hairWallMs(),t);if(!o.visible)return null;return e`<div
			class="hairline${o.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${v(this._hairWallMs()??0)} of ${w()} scale${o.saturated?" — saturated at full width":""}"
			title="elapsed ${v(this._hairWallMs()??0)} of ${w()} scale${o.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${o.start.toFixed(1)}px;width:${(o.end-o.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let t=this._width||240,o=y(this._hairWallMs(),t);if(!o.visible)return;this._slot=-1,this._tip=`elapsed ${v(this._hairWallMs()??0)} of ${w()} scale`+(o.saturated?" — saturated at full width":""),this.requestUpdate();let l=this._plotEl()?.getBoundingClientRect();if(l)this._placeTip(l.left+o.center/Math.max(1,t)*l.width,l.bottom+2)};_hairKey=(t)=>{if(t.key==="Escape")this._hideTip(),this.requestUpdate(),t.target.blur()};_axisHtml(t){let o=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?x(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${o} · ${t.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${t.hasData?x(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),o=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(o/60)).padStart(2,"0")}:${String(o%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,o){let l=()=>{let p=this.renderRoot.querySelector(".tip");if(!p)return;let u=Math.min(t+10,window.innerWidth-p.offsetWidth-8),m=o-p.offsetHeight-10;p.style.left=`${Math.max(8,u)}px`,p.style.top=`${m>=8?m:o+12}px`};if(this.renderRoot.querySelector(".tip")){l();return}this.updateComplete.then(l).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?C(this.attempt):this.wallMs}get _stripHost(){return{setTip:(t,o)=>{this._tip=t,this._slot=o,this.requestUpdate()},placeTip:(t,o)=>this._placeTip(t,o),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=L(this._stripHost);_renderAttempt(){let t=this.attempt,o=this._width||240;if(!t)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${P(t,o,this._attemptHandlers)}
			${this._hairlineHtml()}
			${F(t,this._tzLabel())}
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
		`}}customElements.define("klh-card-activity",N);
