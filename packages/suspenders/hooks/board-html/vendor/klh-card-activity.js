import{r,e,b,n}from"./lit-f23c5efb0b6d9812.js";import{l,u}from"./lit-6b69cfd2eeec119b.js";var M=4;function V(t,i,o,s=180000){let a=Array.from({length:o},()=>null);for(let p of t){let c=Math.floor((p[0]-i)/s);if(c>o-1)c=o-1;if(c<0)continue;let m=a[c];if(m===null)m={fresh:0,cached:0,out:0},a[c]=m;m.fresh+=p[1],m.cached+=p[2],m.out+=p[3]}return a}function Y(t,i,o=6,s=180000){let a=Math.max(1,Math.floor(i/o)),p=t;return{count:a,slotMs:s,start:p-a*s,end:p}}var U={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function I(t,i,o){if(!t.length)return U;let{POSITIVE_INFINITY:s,NEGATIVE_INFINITY:a}=Number;for(let d of t){if(d[0]<s)s=d[0];if(d[0]>a)a=d[0]}let p=Y(a,i),c=o??Math.max(p.start,s),m=Math.ceil((a-c)/p.slotMs)+1,h=Math.max(1,Math.min(p.count,m));return{bins:V(t,c,h),firstTs:s,windowStart:c,windowEnd:c+h*p.slotMs,count:h,slotMs:p.slotMs,startClipped:c>s,hasData:!0}}function x(t){let i=new Date(t),o=(s)=>String(s).padStart(2,"0");return`${o(i.getHours())}:${o(i.getMinutes())}`}function y(t,i,o=86400000){let s=i/2;if(t===null||t===void 0)return{visible:!1,center:s,half:0,start:s,end:s,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:s,half:0,start:s,end:s,saturated:!1};let a=Math.min(i/2,t/o*(i/2));return{visible:!0,center:s,half:a,start:s-a,end:s+a,saturated:t>=o}}function v(t){if(!Number.isFinite(t)||t<=0)return"0m";let i=Math.round(t/60000);if(i<60)return`${i}m`;return`${Math.floor(i/60)}h ${String(i%60).padStart(2,"0")}m`}function w(t=86400000){return`${t/3600000}h`}function f(t,i,o,s){let a=Math.max(1,o-i),p=(t-i)/a*s;return Math.max(0,Math.min(s,p))}function T(t){let i=[];for(let s of t.attempt.segments){if(s.end<=s.start)continue;i.push({kind:s.kind,start:s.start,end:s.end})}let o=[];for(let s of t.milestones){if(s.ts<t.windowStart||s.ts>t.windowEnd)continue;o.push({kind:"milestone",start:s.ts,end:s.ts,commit:s.commit,stage:s.stage})}return{segs:i,milestones:o}}function B(t,i,o,s,a){for(let p of t.milestones){let c=f(p.start,o,s,a);if(Math.abs(i-c)<=6)return p}for(let p of t.segs){let c=f(p.start,o,s,a),m=f(p.end,o,s,a);if(i>=c&&i<=Math.max(m,c+1))return p}return null}function A(t,i,o,s){if(t.kind==="milestone")return[`artifact · ${t.stage??""}`,o(t.start),`commit ${t.commit??""}`].join(`
`);let a=[`${t.kind} · ${s(t.end-t.start)}`,`${o(t.start)} → ${o(t.end)}`];if(t.kind==="firstbyte")a.push("first attributed ledger request — not network latency");if(t.kind==="tool")a.push("request-row minutes — not tool-call duration");if(t.kind==="unknown")a.push("no fact covers this gap");return a.push(`attempt ${i.attempt.index} · ${i.attempt.sid}`),a.join(`
`)}var k=13,E=14,_=5;function C(t){let i=t.attempt.claimEnd??t.windowEnd,o=Math.min(i,t.windowEnd)-t.attempt.claimStart;return o>0?o:null}function W(t,i){let{segs:o,milestones:s}=T(t),a=[];for(let p of o){let c=f(p.start,t.windowStart,t.windowEnd,i),m=Math.max(c+1,f(p.end,t.windowStart,t.windowEnd,i));a.push(b`<rect
				class="at-${p.kind}"
				x=${c.toFixed(1)}
				y=${k}
				width=${(m-c).toFixed(1)}
				height=${E}
				rx="2"
			/>`)}for(let p of s){let c=f(p.start,t.windowStart,t.windowEnd,i),m=k+E/2;a.push(b`<path
				class="at-ms"
				d="M ${c.toFixed(1)},${(m-_).toFixed(1)} l ${_},${_} l -${_},${_} l -${_},-${_} Z"
			/>`)}return e`${a}`}function L(t){return{hover:(s,a)=>{let p=s.currentTarget;if(!a||!p){t.hide();return}let c=p.getBoundingClientRect();if(c.width===0)return;let m=B(T(a),s.clientX-c.left,a.windowStart,a.windowEnd,c.width);if(!m){t.hide();return}t.setTip(A(m,a,l,v),-1),t.placeTip(s.clientX,s.clientY)},hide:()=>t.hide(),keydown:(s,a)=>{if(s.key==="Escape"){t.hide(),s.target.blur();return}if(s.key!=="ArrowLeft"&&s.key!=="ArrowRight")return;s.preventDefault();let p=t.slot(),{milestones:c,segs:m}=T(a),h=[...c,...m];if(!h.length)return;let d=s.key==="ArrowLeft"?-1:1,H=Math.max(0,Math.min(h.length-1,p+d)),g=h[H];if(!g)return;t.setTip(A(g,a,l,v),H);let R=s.currentTarget;if(R){let S=R.getBoundingClientRect(),q=f(g.start,a.windowStart,a.windowEnd,S.width);t.placeTip(S.left+q,S.top+8)}},slot:()=>t.slot()}}function F(t,i){return e`<div class="axis">
		<span>${x(t.windowStart)}</span>
		<span>${i} · ${t.binMs/60000}m/bin</span>
		<span>${x(t.windowEnd)}</span>
	</div>`}function P(t,i,o){return e`<svg
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
		${W(t,i)}
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
	`,D];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let i=this._plotEl()?.clientWidth??0;if(i!==this._width)this._width=i,this.requestUpdate()});let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}updated(){let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}update(t){if(super.update(t),t.has("points")||t.has("attempt")){let i=this._spec,o=this.mode==="attempt"&&!this.attempt;if(!i.hasData||o)this._hideTip()}}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return I(this.points,this._width||240)}_hover=(t)=>{let i=this._plotEl(),o=this._spec;if(!i||!o.hasData){this._hideTip();return}let s=i.getBoundingClientRect();if(s.width===0)return;let a=Math.max(0,Math.min(o.count-1,Math.floor((t.clientX-s.left)/s.width*o.count)));this._slot=a,this._tip=this._tipText(o,a),this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let i=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let o=t.key==="ArrowLeft"?-1:1,s=Math.max(0,Math.min(i.count-1,this._slot+o));this._slot=s,this._tip=this._tipText(i,s),this.requestUpdate();let a=this._plotEl();if(a){let p=a.getBoundingClientRect();this._placeTip(p.left+(s+0.5)/i.count*p.width,p.top+8)}};_hideTip(){this._tip=null,this._slot=-1}_tipText(t,i){let o=t.bins[i],s=(t.windowStart??0)+i*t.slotMs,a=s+t.slotMs,p=[l(s),`bin ${t.slotMs/60000} min · ${u(s)} → ${u(a)}`];if(o)p.push(`Fresh input ${o.fresh.toLocaleString("en-US")}`),p.push(`Cached input ${o.cached.toLocaleString("en-US")}`),p.push(`Output ${o.out.toLocaleString("en-US")}`);else p.push("no requests in this bin");return p.join(`
`)}_barsSvg(t){let o=(this._width||240)/t.count,s=0;for(let p of t.bins)if(p)s=Math.max(s,p.fresh+p.cached);let a=[];if(s>0)for(let p=0;p<t.count;p++){let c=t.bins[p];if(!c)continue;let m=p*o+(o-M)/2;a.push(this._barRects(c,m,s))}return e`${a}`}_barRects(t,i,o){let a=[],p=0,c=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[m,h]of c){if(m<=0)continue;let d=Math.max(0.5,m/o*38);a.push(b`<rect
					class=${h}
					x=${i.toFixed(1)}
					y=${Math.max(1,39-p-d).toFixed(1)}
					width=${M}
					height=${d.toFixed(1)}
				/>`),p+=d}return e`${a}`}_hairlineHtml(){let t=this._width||240,i=y(this._hairWallMs(),t);if(!i.visible)return null;return e`<div
			class="hairline${i.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${v(this._hairWallMs()??0)} of ${w()} scale${i.saturated?" — saturated at full width":""}"
			title="elapsed ${v(this._hairWallMs()??0)} of ${w()} scale${i.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${i.start.toFixed(1)}px;width:${(i.end-i.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let t=this._width||240,i=y(this._hairWallMs(),t);if(!i.visible)return;this._slot=-1,this._tip=`elapsed ${v(this._hairWallMs()??0)} of ${w()} scale`+(i.saturated?" — saturated at full width":""),this.requestUpdate();let o=this._plotEl()?.getBoundingClientRect();if(o)this._placeTip(o.left+i.center/Math.max(1,t)*o.width,o.bottom+2)};_hairKey=(t)=>{if(t.key==="Escape")this._hideTip(),this.requestUpdate(),t.target.blur()};_axisHtml(t){let i=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?x(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${i} · ${t.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${t.hasData?x(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),i=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(i/60)).padStart(2,"0")}:${String(i%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,i){let o=()=>{let a=this.renderRoot.querySelector(".tip");if(!a)return;let p=Math.min(t+10,window.innerWidth-a.offsetWidth-8),c=i-a.offsetHeight-10;a.style.left=`${Math.max(8,p)}px`,a.style.top=`${c>=8?c:i+12}px`};if(this.renderRoot.querySelector(".tip")){o();return}this.updateComplete.then(o).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?C(this.attempt):this.wallMs}get _stripHost(){return{setTip:(t,i)=>{this._tip=t,this._slot=i,this.requestUpdate()},placeTip:(t,i)=>this._placeTip(t,i),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=L(this._stripHost);_renderAttempt(){let t=this.attempt,i=this._width||240;if(!t)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${P(t,i,this._attemptHandlers)}
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
