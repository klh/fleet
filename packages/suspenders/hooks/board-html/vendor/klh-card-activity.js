import{n,e,r}from"./lit-df39549a6b261b0c.js";import{i,s}from"./lit-696f34191bf4ca6d.js";var m=4;function S(t,a,u,o=180000){let c=Array.from({length:u},()=>null);for(let l of t){let p=Math.floor((l[0]-a)/o);if(p>u-1)p=u-1;if(p<0)continue;let h=c[p];if(h===null)h={fresh:0,cached:0,out:0},c[p]=h;h.fresh+=l[1],h.cached+=l[2],h.out+=l[3]}return c}function g(t,a,u=6,o=180000){let c=Math.max(1,Math.floor(a/u)),l=t;return{count:c,slotMs:o,start:l-c*o,end:l}}var T={bins:[],firstTs:null,windowStart:null,windowEnd:null,count:0,slotMs:180000,startClipped:!1,hasData:!1};function v(t,a,u){if(!t.length)return T;let{POSITIVE_INFINITY:o,NEGATIVE_INFINITY:c}=Number;for(let d of t){if(d[0]<o)o=d[0];if(d[0]>c)c=d[0]}let l=g(c,a),p=u??Math.max(l.start,o),h=Math.min(p+l.count*l.slotMs,c+l.slotMs);return{bins:S(t,p,l.count),firstTs:o,windowStart:p,windowEnd:h,count:l.count,slotMs:l.slotMs,startClipped:p>o,hasData:!0}}function w(t,a,u=86400000){let o=a/2;if(t===null||t===void 0)return{visible:!1,center:o,half:0,start:o,end:o,saturated:!1};if(!Number.isFinite(t)||t<=0)return{visible:!1,center:o,half:0,start:o,end:o,saturated:!1};let c=Math.min(a/2,t/u*(a/2));return{visible:!0,center:o,half:c,start:o-c,end:o+c,saturated:t>=u}}function b(t){if(!Number.isFinite(t)||t<=0)return"0m";let a=Math.round(t/60000);if(a<60)return`${a}m`;return`${Math.floor(a/60)}h ${String(a%60).padStart(2,"0")}m`}function _(t=86400000){return`${t/3600000}h`}class x extends r{static properties={points:{attribute:!1},wallMs:{attribute:!1},attempt:{attribute:!1},_tip:{state:!0},_slot:{state:!0}};static styles=n`
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
	`;constructor(){super();this.points=[],this.wallMs=null,this.attempt=null,this._tip=null,this._slot=-1}_ro=null;_width=0;connectedCallback(){if(super.connectedCallback(),typeof ResizeObserver<"u")this._ro=new ResizeObserver(()=>{let t=this._plotEl()?.clientWidth??0;if(t!==this._width)this._width=t,this.requestUpdate()})}disconnectedCallback(){this._ro?.disconnect(),this._ro=null,super.disconnectedCallback()}firstUpdated(){let t=this._plotEl();if(t&&this._ro)this._width=t.clientWidth,this._ro.observe(t)}_plotEl(){return this.renderRoot.querySelector("svg.plot")}get _spec(){return v(this.points,this._width||240)}_hover=(t)=>{let a=this._plotEl(),u=this._spec;if(!a||!u.hasData){this._hideTip();return}let o=a.getBoundingClientRect();if(o.width===0)return;let c=Math.max(0,Math.min(u.count-1,Math.floor((t.clientX-o.left)/o.width*u.count)));this._slot=c,this._tip=this._tipText(u,c),this.requestUpdate(),this._placeTip(t.clientX,t.clientY)};_hide=()=>{this._hideTip(),this.requestUpdate()};_keyNav=(t)=>{let a=this._spec;if(t.key==="Escape"){this._hide();return}if(t.key!=="ArrowLeft"&&t.key!=="ArrowRight")return;t.preventDefault();let u=t.key==="ArrowLeft"?-1:1,o=Math.max(0,Math.min(a.count-1,this._slot+u));this._slot=o,this._tip=this._tipText(a,o),this.requestUpdate();let c=this._plotEl();if(c){let l=c.getBoundingClientRect();this._placeTip(l.left+(o+0.5)/a.count*l.width,l.top+8)}};_hideTip(){this._tip=null,this._slot=-1}_tipText(t,a){let u=t.bins[a],o=(t.windowStart??0)+a*t.slotMs,c=o+t.slotMs,l=[i(o),`bin ${t.slotMs/60000} min · ${s(o)} → ${s(c)}`];if(u)l.push(`Fresh input ${u.fresh.toLocaleString("en-US")}`),l.push(`Cached input ${u.cached.toLocaleString("en-US")}`),l.push(`Output ${u.out.toLocaleString("en-US")}`);else l.push("no requests in this bin");return l.join(`
`)}_barsSvg(t){let u=(this._width||240)/t.count,o=0;for(let l of t.bins)if(l)o=Math.max(o,l.fresh+l.cached);let c=[];if(o>0)for(let l=0;l<t.count;l++){let p=t.bins[l];if(!p)continue;let h=l*u+(u-m)/2;c.push(this._barRects(p,h,o))}return e`${c}`}_barRects(t,a,u){let c=[],l=0,p=[[t.fresh,"spark-fresh"],[t.cached,"spark-cached"]];for(let[h,d]of p){if(h<=0)continue;let f=Math.max(0.5,h/u*26);c.push(e`<rect
					class=${d}
					x=${a.toFixed(1)}
					y=${Math.max(1,27-l-f).toFixed(1)}
					width=${m}
					height=${f.toFixed(1)}
				/>`),l+=f}return e`${c}`}_hairlineHtml(){let t=this._width||240,a=w(this.wallMs,t);if(!a.visible)return null;return e`<div
			class="hairline${a.saturated?" saturated":""}"
			role="img"
			aria-label="elapsed ${b(this.wallMs??0)} of ${_()} scale${a.saturated?" — saturated at full width":""}"
			title="elapsed ${b(this.wallMs??0)} of ${_()} scale${a.saturated?" — saturated at full width":""}"
		>
			<span
				class="span"
				style="left:${a.start.toFixed(1)}px;width:${(a.end-a.start).toFixed(1)}px"
			></span>
		</div>`}_axisHtml(t){let a=this._tzLabel();return e`<div class="axis">
			<span>${t.hasData?s(t.windowStart??0):""}</span>
			<span
				>${t.hasData?`${a} · ${t.slotMs/60000}m/bin`:"no activity"}</span
			>
			<span>${t.hasData?s(t.windowEnd??0):""}</span>
		</div>`}_tzLabel(){let t=-new Date().getTimezoneOffset(),a=Math.abs(t);return`UTC${t>=0?"+":"-"}${String(Math.floor(a/60)).padStart(2,"0")}:${String(a%60).padStart(2,"0")}`}_tipHtml(){return e`<div class="tip" role="tooltip">${this._tip}</div>`}_placeTip(t,a){let u=this.renderRoot.querySelector(".tip");if(!u)return;let o=Math.min(t+10,window.innerWidth-u.offsetWidth-8),c=a-u.offsetHeight-10;u.style.left=`${Math.max(8,o)}px`,u.style.top=`${c>=8?c:a+12}px`}render(){let t=this._spec;return e`
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
