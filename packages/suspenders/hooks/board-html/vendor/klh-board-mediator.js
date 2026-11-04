import{r,e,t,n}from"./lit-b59bf30faa0b21f8.js";import{S}from"./lit-b483bf61706b6925.js";import{R,o,u,b,a,i,x,M,s}from"./lit-dbb2e415bb54e58a.js";import{m}from"./lit-fa2d59eb76085ea2.js";import{f,A}from"./lit-d4f1cb4c1f513c55.js";import{q}from"./lit-d109c83208056758.js";function E(c,l,p){let d=c.observation,v=(V)=>Math.max(0,Math.round((c.now-V)/1000)),h=d&&typeof d.observedAt==="number"?v(d.observedAt):c.dataOkAt?v(c.dataOkAt):-1,y=d?Number(d.expiresAt):Number.NaN,D=!!d&&(!Number.isFinite(y)||y<=c.now||Number(d.observedAt)>c.now+5000),g="live",k="live";if(c.dataErr&&!c.dataOkAt)g="err",k="connecting";else if(c.dataErr)g="err",k=`error — last good ${l(h)}`;else if(D||h>=5)g="stale",k=`stale snapshot — observed ${l(h)}`;let I=!c.decLoaded?"decisions loading":c.decErr?"decisions unavailable":`decisions checked ${l(c.decOkAt?v(c.decOkAt):-1)}`,L=d?`Source: ${d.source} · target: ${d.target} · scope: ${d.scope} · observed: ${p(d.observedAt)} · expires: ${p(d.expiresAt)}`:"Legacy feed without observation provenance";return{cls:g,txt:k,dec:I,title:L,retry:!!c.dataErr}}var T=i({source:s(o()),target:s(o()),scope:s(o()),observedAt:s(u()),expiresAt:s(u())}),Z=i({ts:u(),projects:a(i({project:o()})),sessions:s(a(i({}))),observation:s(T)}),B=i({ts:u(),decisions:a(i({})),projects:s(a(o()))}),P=i({ts:u(),decisions:a(i({}))}),H=i({ok:M(!0),tasks:a(i({id:o(),project:o()})),projects:s(a(o()))}),K=i({ok:M(!0),series:x(o(),b()),attempts:s(x(o(),b()))}),O={data:Z,dec:B,hist:P,tasks:H,spend:K};function w(c){return(l)=>{let p=c.safeParse(l);if(!p.success)throw Error(`schema: ${R(p.error)}`)}}var z=r`
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
`;class C extends n{static properties={text:{type:String},feed:{type:String,reflect:!0}};static styles=[r`
			:host([hidden]) {
				display: none;
			}
		`,z];constructor(){super();this.text="",this.feed=""}willUpdate(){this.hidden=!this.text}retry(){this.dispatchEvent(this.feed?new f(this.feed):new A(this.id))}render(){return e`<span role="alert">${this.text}</span
			><button class="retry" type="button" @click=${this.retry}>
				retry
			</button>`}}if(!customElements.get("klh-err-banner"))customElements.define("klh-err-banner",C);class j extends n{static properties={verdict:{attribute:!1}};static styles=[r`
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
	`,z];constructor(){super();this.verdict=null}retry(){this.dispatchEvent(new f("data"))}updated(){this.title=this.verdict?this.verdict.title:""}render(){let c=this.verdict;if(!c)return e`<span class="dot stale"></span>connecting`;return e`<span class="dot ${c.cls}"></span>${c.txt}
			<span class="dim">| ${c.dec}</span>${c.retry?e` <button class="retry" type="button" @click=${this.retry}>
							retry
						</button>`:t}`}}if(!customElements.get("klh-conn-banner"))customElements.define("klh-conn-banner",j);class N extends n{static styles=r`
		:host {
			display: contents;
		}
	`;store=S();unsubs=[];ticker=null;constructor(){super();for(let[c,l]of Object.entries(O))this.store.validate(c,w(l));this.addEventListener(f.eventName,(c)=>{c.stopPropagation(),this.store.kick(c.feed,!0)})}connectedCallback(){super.connectedCallback();let c=()=>this.pushConn();this.unsubs=["data","dec"].map((l)=>this.store.subscribe(l,c)),this.ticker=setInterval(()=>{if(!document.hidden)c()},1000),c()}disconnectedCallback(){super.disconnectedCallback();for(let c of this.unsubs)c();if(this.unsubs=[],this.ticker!==null)clearInterval(this.ticker);this.ticker=null}pushConn(){let c=this.store.get("data"),l=this.store.get("dec"),p=this.querySelectorAll("klh-conn-banner");if(!p.length)return;let d=c?.data?.observation,v=E({observation:d,dataOkAt:c?.okAt??0,dataErr:F(c),decOkAt:l?.okAt??0,decErr:F(l),decLoaded:l?.loaded??!1,now:Date.now()},m,(h)=>q(h??Number.NaN));for(let h of p)h.verdict=v}render(){return e`<slot></slot>`}}var F=(c)=>c?c.err:null;if(!customElements.get("klh-board-mediator"))customElements.define("klh-board-mediator",N);export{N as KlhBoardMediator};
