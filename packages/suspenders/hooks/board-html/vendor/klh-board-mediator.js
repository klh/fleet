import{r,e,t,n}from"./lit-b59bf30faa0b21f8.js";import{S}from"./lit-b483bf61706b6925.js";import{P,o,d,b,a,i,y,C,s}from"./lit-307787039bd4ed43.js";import{m}from"./lit-b7eecf58073b7927.js";import{f,A}from"./lit-19130002dd3c1d75.js";import{H}from"./lit-12b46f627c606484.js";function E(c,p,u){let l=c.observation,v=(R)=>Math.max(0,Math.round((c.now-R)/1000)),h=l&&typeof l.observedAt==="number"?v(l.observedAt):c.dataOkAt?v(c.dataOkAt):-1,z=l?Number(l.expiresAt):Number.NaN,I=!!l&&(!Number.isFinite(z)||z<=c.now||Number(l.observedAt)>c.now+5000),g="live",k="live";if(c.dataErr&&!c.dataOkAt)g="err",k="connecting";else if(c.dataErr)g="err",k=`error — last good ${p(h)}`;else if(I||h>=5)g="stale",k=`stale snapshot — observed ${p(h)}`;let M=!c.decLoaded?"decisions loading":c.decErr?"decisions unavailable":`decisions checked ${p(c.decOkAt?v(c.decOkAt):-1)}`,L=l?`Source: ${l.source} · target: ${l.target} · scope: ${l.scope} · observed: ${u(l.observedAt)} · expires: ${u(l.expiresAt)}`:"Legacy feed without observation provenance";return{cls:g,txt:k,dec:M,title:L,retry:!!c.dataErr}}var V=i({source:s(o()),target:s(o()),scope:s(o()),observedAt:s(d()),expiresAt:s(d())}),T=i({ts:d(),projects:a(i({project:o()})),sessions:s(a(i({}))),observation:s(V)}),Z=i({ts:d(),decisions:a(i({})),projects:s(a(o()))}),q=i({ok:C(!0),tasks:a(i({id:o(),project:o()})),projects:s(a(o()))}),B=i({ok:C(!0),series:y(o(),b()),attempts:s(y(o(),b()))}),O={data:T,dec:Z,tasks:q,spend:B};function w(c){return(p)=>{let u=c.safeParse(p);if(!u.success)throw Error(`schema: ${P(u.error)}`)}}var x=r`
	.retry {
		background: none;
		border: 1px solid var(--klh-danger);
		color: var(--klh-danger-ink);
		border-radius: 2px;
		font: inherit;
		font-size: 10px;
		padding: 1px 8px;
		cursor: pointer;
		margin-left: 8px;
	}
`;class j extends n{static properties={text:{type:String},feed:{type:String,reflect:!0}};static styles=[r`
			:host([hidden]) {
				display: none;
			}
		`,x];constructor(){super();this.text="",this.feed=""}willUpdate(){this.hidden=!this.text}retry(){this.dispatchEvent(this.feed?new f(this.feed):new A(this.id))}render(){return e`<span role="alert">${this.text}</span
			><button class="retry" type="button" @click=${this.retry}>
				retry
			</button>`}}if(!customElements.get("klh-err-banner"))customElements.define("klh-err-banner",j);class N extends n{static properties={verdict:{attribute:!1}};static styles=[r`
		:host {
			font-size: 11px;
			color: var(--klh-dim);
			white-space: nowrap;
		}
		.dot {
			display: inline-block;
			width: 8px;
			height: 8px;
			border-radius: 50%;
			margin-right: 5px;
			vertical-align: 0;
		}
		.dot.live {
			background: var(--klh-ok);
		}
		.dot.stale {
			background: var(--klh-accent);
		}
		.dot.err {
			background: var(--klh-danger);
		}
	`,x];constructor(){super();this.verdict=null}retry(){this.dispatchEvent(new f("data"))}updated(){this.title=this.verdict?this.verdict.title:""}render(){let c=this.verdict;if(!c)return e`<span class="dot stale"></span>connecting`;return e`<span class="dot ${c.cls}"></span>${c.txt}
			<span class="dim">| ${c.dec}</span>${c.retry?e` <button class="retry" type="button" @click=${this.retry}>
							retry
						</button>`:t}`}}if(!customElements.get("klh-conn-banner"))customElements.define("klh-conn-banner",N);class D extends n{static styles=r`
		:host {
			display: contents;
		}
	`;store=S();unsubs=[];ticker=null;constructor(){super();for(let[c,p]of Object.entries(O))this.store.validate(c,w(p));this.addEventListener(f.eventName,(c)=>{c.stopPropagation(),this.store.kick(c.feed,!0)})}connectedCallback(){super.connectedCallback();let c=()=>this.pushConn();this.unsubs=["data","dec"].map((p)=>this.store.subscribe(p,c)),this.ticker=setInterval(()=>{if(!document.hidden)c()},1000),c()}disconnectedCallback(){super.disconnectedCallback();for(let c of this.unsubs)c();if(this.unsubs=[],this.ticker!==null)clearInterval(this.ticker);this.ticker=null}pushConn(){let c=this.store.get("data"),p=this.store.get("dec"),u=this.querySelectorAll("klh-conn-banner");if(!u.length)return;let l=c?.data?.observation,v=E({observation:l,dataOkAt:c?.okAt??0,dataErr:F(c),decOkAt:p?.okAt??0,decErr:F(p),decLoaded:p?.loaded??!1,now:Date.now()},m,(h)=>H(h??Number.NaN));for(let h of u)h.verdict=v}render(){return e`<slot></slot>`}}var F=(c)=>c?c.err:null;if(!customElements.get("klh-board-mediator"))customElements.define("klh-board-mediator",D);export{D as KlhBoardMediator};
