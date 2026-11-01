import{n,e,r}from"./lit-df39549a6b261b0c.js";import{i,s}from"./lit-696f34191bf4ca6d.js";var _=4;function g(t,a,o,l=180000){let c=Array.from({length:o},()=>null);for(let u of t){let h=Math.floor((u[0]-a)/l);if(h>o-1)h=o-1;if(h<0)continue;let p=c[h];if(p===null)p={fresh:0,cached:0,out:0},c[h]=p;p.fresh+=u[1],p.cached+=u[2],p.out+=u[3]}return c}function S(t,a,o=6,l=180000){let c=Math.max(1,Math.floor(a/o)),u=t;return{count:c,slotMs:l,start:u-c*l,end:u}}var T={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function w(t,a,o){if(!t.length)return T;let{POSITIVE_INFINITY:l,NEGATIVE_INFINITY:c}=Number;for(let d of t){if(d[0]<l)l=d[0];if(d[0]>c)c=d[0]}let u=S(c,a),h=o??Math.max(u.start,l),p=Math.min(h+u.count*u.slotMs,c+u.slotMs);return{bins:g(t,h,u.count),firstTs:l,windowStart:h,windowEnd:p,count:u.count,slotMs:u.slotMs,startClipped:h>l,hasData:!0}}function v(t,a,o=86400000){let l=a/2;if(t===null||t===void 0)return{visible:!1,center:l,half:0,start:l,end:l,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:l,half:0,start:l,end:l,saturated:!1};let c=Math.min(a/2,t/o*(a/2));return{visible:!0,center:l,half:c,start:l-c,end:l+c,saturated:t>=o}}function f(t){if(!Number.isFinite(t)||t<=0)return"0m";let a=Math.round(t/60000);if(a<60)return`${a}m`;return`${Math.floor(a/60)}h ${String(a%60).padStart(2,"0")}m`}function b(t=86400000){return`${t/3600000}h`}class x extends r{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},_width:{state:!0},_tip:{state:!0},_slot:{state:!0}};static styles=n`
		:host {
			display: block;
			font: 11px/1.5 ui-sans-serif, system-ui;
		}
		.plot {
			display: block;
			width: 100%;
			height: 28px;
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
	`;constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this._width=0,this._tip=null,this._slot=-1}_ro=null;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let t=this._plotEl()?.clientWidth??0;if(t!==this._width)this._width=t,this.requestUpdate()})}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return w(this.points,this._width||240)}_hover=(t)=>{let a=this._plotEl(),o=this._spec;if(!a||!o.hasData){this._hideTip();return}let l=a.getBoundingClientRect();if(l.width===0)return;let c=Math.max(0,Math.min(o.count-1,Math.floor((t.clientX-l.left)/l.width*o.count)));this._slot=c,this._tip=this._tipText(o,c),this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let a=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let o=t.key==="ArrowLeft"?-1:1,l=Math.max(0,Math.min(a.count-1,this._slot+o));this._slot=l,this._tip=this._tipText(a,l),this.requestUpdate();let c=this._plotEl();if(c){let u=c.getBoundingClientRect();this._placeTip(u.left+(l+0.5)/a.count*u.width,u.top+8)}};_hideTip(){this._tip=null,this._slot=-1}_tipText(t,a){let o=t.bins[a],l=(t.windowStart??0)+a*t.slotMs,c=l+t.slotMs,u=[i(l),`bin ${t.slotMs/60000} min · ${s(l)} → ${s(c)}`];if(o)u.push(`Fresh input ${o.fresh.toLocaleString("en-US")}`),u.push(`Cached input ${o.cached.toLocaleString("en-US")}`),u.push(`Output ${o.out.toLocaleString("en-US")}`);else u.push("no requests in this bin");return u.join(`
`)}_barsSvg(t){let o=(this._width||240)/t.count,l=0;for(let u of t.bins)if(u)l=Math.max(l,u.fresh+u.cached);let c=[];if(l>0)for(let u=0;u<t.count;u++){let h=t.bins[u];if(!h)continue;let p=u*o+(o-_)/2;c.push(this._barRects(h,p,l))}return e`${c}`}_barRects(t,a,o){let c=[],u=0,h=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[p,d]of h){if(p<=0)continue;let m=Math.max(0.5,p/o*26);c.push(e`<rect
					class=${d}
					x=${a.toFixed(1)}
					y=${Math.max(1,27-u-m).toFixed(1)}
					width=${_}
					height=${m.toFixed(1)}
				/>`),u+=m}return e`${c}`}_hairlineHtml(){let t=this._width||240,a=v(this.wallMs,t);if(!a.visible)return null;return e`<div
			class="hairline${a.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${f(this.wallMs??0)} of ${b()} scale${a.saturated?" — saturated at full width":""}"
			title="elapsed ${f(this.wallMs??0)} of ${b()} scale${a.saturated?" — saturated at full width":""}"
			tabindex="0"
			@focus=${this._hairFocus}
			@blur=${this._hide}
			@keydown=${this._hairKey}
		>
			<span
				class="span"
				style="left:${a.start.toFixed(1)}px;width:${(a.end-a.start).toFixed(1)}px"
			></span>
		</div>`}_hairFocus=()=>{let t=this._width||240,a=v(this.wallMs,t);if(!a.visible)return;this._slot=-1,this._tip=`elapsed ${f(this.wallMs??0)} of ${b()} scale`+(a.saturated?" — saturated at full width":""),this.requestUpdate();let o=this._plotEl()?.getBoundingClientRect();if(o)this._placeTip(o.left+a.center/Math.max(1,t)*o.width,o.bottom+2)};_hairKey=(t)=>{if(t.key==="Escape")this._hideTip(),this.requestUpdate(),t.target.blur()};_axisHtml(t){let a=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?s(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${a} · ${t.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${t.hasData?s(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),a=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(a/60)).padStart(2,"0")}:${String(a%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,a){let o=this.renderRoot.querySelector(".tip");if(!o)return;let l=Math.min(t+10,window.innerWidth-o.offsetWidth-8),c=a-o.offsetHeight-10;o.style.left=`${Math.max(8,l)}px`,o.style.top=`${c>=8?c:a+12}px`}render(){let t=this._spec;return e`
			<svg
				class="plot"
				viewBox="0 0 ${this._width||240} 28"
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
		`}}customElements.define("klh-card-activity",x);
