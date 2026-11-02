import{r,e,c,n}from"./lit-2f0d70419e37a5ce.js";import{o,i}from"./lit-bd2f52b2bd980c82.js";var M=4;function Y(t,s,l,a=180000){let p=Array.from({length:l},()=>null);for(let u of t){let m=Math.floor((u[0]-s)/a);if(m>l-1)m=l-1;if(m<0)continue;let d=p[m];if(d===null)d={fresh:0,cached:0,out:0},p[m]=d;d.fresh+=u[1],d.cached+=u[2],d.out+=u[3]}return p}function U(t,s,l=6,a=180000){let p=Math.max(1,Math.floor(s/l)),u=t;return{count:p,slotMs:a,start:u-p*a,end:u}}var W={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function I(t,s,l){if(!t.length)return W;let{POSITIVE_INFINITY:a,NEGATIVE_INFINITY:p}=Number;for(let f of t){if(f[0]<a)a=f[0];if(f[0]>p)p=f[0]}let u=U(p,s),m=l??Math.max(u.start,a),d=Math.ceil((p-m)/u.slotMs)+1,h=Math.max(1,Math.min(u.count,d));return{bins:Y(t,m,h),firstTs:a,windowStart:m,windowEnd:m+h*u.slotMs,count:h,slotMs:u.slotMs,startClipped:m>a,hasData:!0}}function T(t){let s=new Date(t),l=(a)=>String(a).padStart(2,"0");return`${l(s.getHours())}:${l(s.getMinutes())}`}function y(t,s,l=86400000){let a=s/2;if(t===null||t===void 0)return{visible:!1,center:a,half:0,start:a,end:a,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:a,half:0,start:a,end:a,saturated:!1};let p=Math.min(s/2,t/l*(s/2));return{visible:!0,center:a,half:p,start:a-p,end:a+p,saturated:t>=l}}function b(t){if(!Number.isFinite(t)||t<=0)return"0m";let s=Math.round(t/60000);if(s<60)return`${s}m`;return`${Math.floor(s/60)}h ${String(s%60).padStart(2,"0")}m`}function S(t=86400000){return`${t/3600000}h`}function _(t,s,l,a){let p=Math.max(1,l-s),u=(t-s)/p*a;return Math.max(0,Math.min(a,u))}function w(t){let s=[];for(let a of t.attempt.segments){if(a.end<=a.start)continue;s.push({kind:a.kind,start:a.start,end:a.end})}let l=[];for(let a of t.milestones){if(a.ts<t.windowStart||a.ts>t.windowEnd)continue;l.push({kind:"milestone",start:a.ts,end:a.ts,commit:a.commit,stage:a.stage})}return{segs:s,milestones:l}}function B(t,s,l,a,p){for(let u of t.milestones){let m=_(u.start,l,a,p);if(Math.abs(s-m)<=6)return u}for(let u of t.segs){let m=_(u.start,l,a,p),d=_(u.end,l,a,p);if(s>=m&&s<=Math.max(d,m+1))return u}return null}function x(t,s,l,a){if(t.kind==="milestone")return[`artifact · ${t.stage??""}`,l(t.start),`commit ${t.commit??""}`].join(`
`);let p=[`${t.kind} · ${a(t.end-t.start)}`,`${l(t.start)} → ${l(t.end)}`];if(t.kind==="firstbyte")p.push("first attributed ledger request — not network latency");if(t.kind==="tool")p.push("request-row minutes — not tool-call duration");if(t.kind==="unknown")p.push("no fact covers this gap");return p.push(`attempt ${s.attempt.index} · ${s.attempt.sid}`),p.join(`
`)}var k=13,E=14,v=5;function L(t){let s=t.attempt.claimEnd??t.windowEnd,l=Math.min(s,t.windowEnd)-t.attempt.claimStart;return l>0?l:null}function G(t,s){let{segs:l,milestones:a}=w(t),p=[];for(let u of l){let m=_(u.start,t.windowStart,t.windowEnd,s),d=Math.max(m+1,_(u.end,t.windowStart,t.windowEnd,s));p.push(c`<rect
				class="at-${u.kind}"
				x=${m.toFixed(1)}
				y=${k}
				width=${(d-m).toFixed(1)}
				height=${E}
				rx="2"
			/>`)}for(let u of a){let m=_(u.start,t.windowStart,t.windowEnd,s),d=k+E/2;p.push(c`<path
				class="at-ms"
				d="M ${m.toFixed(1)},${(d-v).toFixed(1)} l ${v},${v} l -${v},${v} l -${v},-${v} Z"
			/>`)}return e`${p}`}var C=(t)=>({kind:t.kind,start:t.start});function F(t){return{hover:(a,p)=>{let u=a.currentTarget;if(!p||!u){t.hide();return}let m=u.getBoundingClientRect();if(m.width===0)return;let d=B(w(p),a.clientX-m.left,p.windowStart,p.windowEnd,m.width);if(!d){t.hide();return}t.setTip(x(d,p,o,b),-1,C(d)),t.placeTip(a.clientX,a.clientY)},hide:()=>t.hide(),keydown:(a,p)=>{if(a.key==="Escape"){t.hide(),a.target.blur();return}if(a.key!=="ArrowLeft"&&a.key!=="ArrowRight")return;a.preventDefault();let u=t.slot(),{milestones:m,segs:d}=w(p),h=[...m,...d];if(!h.length)return;let f=a.key==="ArrowLeft"?-1:1,H=Math.max(0,Math.min(h.length-1,u+f)),g=h[H];if(!g)return;t.setTip(x(g,p,o,b),H,C(g));let R=a.currentTarget;if(R){let A=R.getBoundingClientRect(),V=_(g.start,p.windowStart,p.windowEnd,A.width);t.placeTip(A.left+V,A.top+8)}},slot:()=>t.slot()}}function P(t,s){return e`<div class="axis">
		<span>${T(t.windowStart)}</span>
		<span>${s} · ${t.binMs/60000}m/bin</span>
		<span>${T(t.windowEnd)}</span>
	</div>`}function D(t,s,l){return e`<svg
		class="plot"
		viewBox="0 0 ${s} 40"
		preserveAspectRatio="none"
		role="img"
		aria-label="Current attempt: fixed 90-minute window, ${t.binMs/60000}-minute bins; queue, firstbyte, tool, pause, unknown segments plus artifact milestones"
		tabindex="0"
		@pointermove=${(a)=>l.hover(a,t)}
		@pointerleave=${()=>l.hide()}
		@keydown=${(a)=>l.keydown(a,t)}
	>
		${G(t,s)}
	</svg>`}var N=r`
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
`;class q extends n{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},mode:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=[r`
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
	`,N];constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this.mode="spend",this._width=0,this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let s=this._plotEl()?.clientWidth??0;if(s!==this._width)this._width=s,this.requestUpdate()});let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}updated(){let t=this._plotEl();if(t&&this._ro)this._ro.observe(t)}update(t){if(super.update(t),!t.has("points")&&!t.has("attempt"))return;if(this.mode==="attempt"){if(!this.attempt||!this._tipRef){this._hideTip();return}let{milestones:a,segs:p}=w(this.attempt),u=[...a,...p],m=this._tipRef,d=u.findIndex((h)=>h.kind===m.kind&&h.start===m.start);if(d<0){this._hideTip();return}this._tip=x(u[d],this.attempt,o,b),this._slot=d;return}let s=this._spec;if(!s.hasData||this._tipTs===null){if(!s.hasData)this._hideTip();return}let l=Math.floor((this._tipTs-(s.windowStart??0))/s.slotMs);if(l<0||l>=s.count){this._hideTip();return}this._slot=l,this._tip=this._tipText(s,l)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return I(this.points,this._width||240)}_hover=(t)=>{let s=this._plotEl(),l=this._spec;if(!s||!l.hasData){this._hideTip();return}let a=s.getBoundingClientRect();if(a.width===0)return;let p=Math.max(0,Math.min(l.count-1,Math.floor((t.clientX-a.left)/a.width*l.count)));this._slot=p,this._tip=this._tipText(l,p),this._tipTs=(l.windowStart??0)+p*l.slotMs,this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let s=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let l=t.key==="ArrowLeft"?-1:1,a=Math.max(0,Math.min(s.count-1,this._slot+l));this._slot=a,this._tip=this._tipText(s,a),this._tipTs=(s.windowStart??0)+a*s.slotMs,this.requestUpdate();let p=this._plotEl();if(p){let u=p.getBoundingClientRect();this._placeTip(u.left+(a+0.5)/s.count*u.width,u.top+8)}};_hideTip(){this._tip=null,this._slot=-1,this._tipRef=null,this._tipTs=null}_tipText(t,s){let l=t.bins[s],a=(t.windowStart??0)+s*t.slotMs,p=a+t.slotMs,u=[o(a),`bin ${t.slotMs/60000} min · ${i(a)} → ${i(p)}`];if(l)u.push(`Fresh input ${l.fresh.toLocaleString("en-US")}`),u.push(`Cached input ${l.cached.toLocaleString("en-US")}`),u.push(`Output ${l.out.toLocaleString("en-US")}`);else u.push("no requests in this bin");return u.join(`
`)}_barsSvg(t){let l=(this._width||240)/t.count,a=0;for(let u of t.bins)if(u)a=Math.max(a,u.fresh+u.cached);let p=[];if(a>0)for(let u=0;u<t.count;u++){let m=t.bins[u];if(!m)continue;let d=u*l+(l-M)/2;p.push(this._barRects(m,d,a))}return e`${p}`}_barRects(t,s,l){let p=[],u=0,m=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[d,h]of m){if(d<=0)continue;let f=Math.max(0.5,d/l*38);p.push(c`<rect
					class=${h}
					x=${s.toFixed(1)}
					y=${Math.max(1,39-u-f).toFixed(1)}
					width=${M}
					height=${f.toFixed(1)}
				/>`),u+=f}return e`${p}`}_hairlineHtml(){let t=this._width||240,s=y(this._hairWallMs(),t);if(!s.visible)return null;return e`<div
			class="hairline${s.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${b(this._hairWallMs()??0)} of ${S()} scale${s.saturated?" — saturated at full width":""}"
			title="elapsed ${b(this._hairWallMs()??0)} of ${S()} scale${s.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${s.start.toFixed(1)}px;width:${(s.end-s.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let t=this._width||240,s=y(this._hairWallMs(),t);if(!s.visible)return;this._slot=-1,this._tipRef=null,this._tipTs=null,this._tip=`elapsed ${b(this._hairWallMs()??0)} of ${S()} scale`+(s.saturated?" — saturated at full width":""),this.requestUpdate();let l=this._plotEl()?.getBoundingClientRect();if(l)this._placeTip(l.left+s.center/Math.max(1,t)*l.width,l.bottom+2)};_hairKey=(t)=>{if(t.key==="Escape")this._hideTip(),this.requestUpdate(),t.target.blur()};_axisHtml(t){let s=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?T(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${s} · ${t.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${t.hasData?T(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),s=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,s){let l=()=>{let p=this.renderRoot.querySelector(".tip");if(!p)return;let u=Math.min(t+10,window.innerWidth-p.offsetWidth-8),m=s-p.offsetHeight-10;p.style.left=`${Math.max(8,u)}px`,p.style.top=`${m>=8?m:s+12}px`};if(this.renderRoot.querySelector(".tip")){l();return}this.updateComplete.then(l).catch(()=>{return})}_hairWallMs(){return this.mode==="attempt"&&this.attempt?L(this.attempt):this.wallMs}get _stripHost(){return{setTip:(t,s,l)=>{this._tip=t,this._slot=s,this._tipRef=l??null,this.requestUpdate()},placeTip:(t,s)=>this._placeTip(t,s),hide:()=>{this._hideTip(),this.requestUpdate()},slot:()=>this._slot}}_attemptHandlers=F(this._stripHost);_renderAttempt(){let t=this.attempt,s=this._width||240;if(!t)return e`<div class="attempt-empty" role="img">
					no attempt in the fixed 90-minute window
				</div>`;return e`
			${D(t,s,this._attemptHandlers)}
			${this._hairlineHtml()}
			${P(t,this._tzLabel())}
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
		`}}customElements.define("klh-card-activity",q);
