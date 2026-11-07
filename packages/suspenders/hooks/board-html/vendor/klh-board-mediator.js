import{r,e,t,n}from"./lit-f18bcbfe556b7350.js";import{O,o,d,b,l,i,E,D,s}from"./lit-73363dc2a02d234f.js";import{c}from"./lit-88ce58085f9deb62.js";import{p}from"./lit-032b27a86ffe7dd0.js";import{v,C}from"./lit-71b20d68dd352113.js";import{K}from"./lit-4d58b154a05c60be.js";function S(a,m,h){let u=a.observation,g=(V)=>Math.max(0,Math.round((a.now-V)/1000)),f=u&&typeof u.observedAt==="number"?g(u.observedAt):a.dataOkAt?g(a.dataOkAt):-1,y=u?Number(u.expiresAt):Number.NaN,M=!!u&&(!Number.isFinite(y)||y<=a.now||Number(u.observedAt)>a.now+5000),x="live",k="live";if(a.dataErr&&!a.dataOkAt)x="err",k="connecting";else if(a.dataErr)x="err",k=`error — last good ${m(f)}`;else if(M||f>=5)x="stale",k=`stale snapshot — observed ${m(f)}`;let L=!a.decLoaded?"decisions loading":a.decErr?"decisions unavailable":`decisions checked ${m(a.decOkAt?g(a.decOkAt):-1)}`,R=u?`Source: ${u.source} · target: ${u.target} · scope: ${u.scope} · observed: ${h(u.observedAt)} · expires: ${h(u.expiresAt)}`:"Legacy feed without observation provenance";return{cls:x,txt:k,dec:L,title:R,retry:!!a.dataErr}}var T=i({source:s(o()),target:s(o()),scope:s(o()),observedAt:s(d()),expiresAt:s(d())}),Z=i({ts:d(),projects:l(i({project:o()})),sessions:s(l(i({}))),observation:s(T)}),q=i({ts:d(),decisions:l(i({})),projects:s(l(o()))}),B=i({ts:d(),decisions:l(i({}))}),P=i({ok:D(!0),tasks:l(i({id:o(),project:o()})),projects:s(l(o()))}),H=i({ok:D(!0),series:E(o(),b()),attempts:s(E(o(),b()))}),A={data:Z,dec:q,hist:B,tasks:P,spend:H};function w(a){return(m)=>{let h=a.safeParse(m);if(!h.success)throw Error(`schema: ${O(h.error)}`)}}var z=r`
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
		`,z];constructor(){super();this.text="",this.feed=""}willUpdate(){this.hidden=!this.text}retry(){this.dispatchEvent(this.feed?new v(this.feed):new C(this.id))}render(){return e`<span role="alert">${this.text}</span
			><button class="retry" type="button" @click=${this.retry}>
				retry
			</button>`}}if(!customElements.get("klh-err-banner"))customElements.define("klh-err-banner",j);class F extends n{static properties={verdict:{attribute:!1}};static styles=[r`
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
	`,z];constructor(){super();this.verdict=null}retry(){this.dispatchEvent(new v("data"))}updated(){this.title=this.verdict?this.verdict.title:""}render(){let a=this.verdict;if(!a)return e`<span class="dot stale"></span>connecting`;return e`<span class="dot ${a.cls}"></span>${a.txt}
			<span class="dim">| ${a.dec}</span>${a.retry?e` <button class="retry" type="button" @click=${this.retry}>
							retry
						</button>`:t}`}}if(!customElements.get("klh-conn-banner"))customElements.define("klh-conn-banner",F);class I extends n{static styles=r`
		:host {
			display: contents;
		}
	`;store=p();unsubs=[];ticker=null;constructor(){super();for(let[a,m]of Object.entries(A))this.store.validate(a,w(m));this.addEventListener(v.eventName,(a)=>{a.stopPropagation(),this.store.kick(a.feed,!0)})}connectedCallback(){super.connectedCallback();let a=()=>this.pushConn();this.unsubs=["data","dec"].map((m)=>this.store.subscribe(m,a)),this.ticker=setInterval(()=>{if(!document.hidden)a()},1000),a()}disconnectedCallback(){super.disconnectedCallback();for(let a of this.unsubs)a();if(this.unsubs=[],this.ticker!==null)clearInterval(this.ticker);this.ticker=null}pushConn(){let a=this.store.get("data"),m=this.store.get("dec"),h=this.querySelectorAll("klh-conn-banner");if(!h.length)return;let u=a?.data?.observation,g=S({observation:u,dataOkAt:a?.okAt??0,dataErr:N(a),decOkAt:m?.okAt??0,decErr:N(m),decLoaded:m?.loaded??!1,now:Date.now()},c,(f)=>K(f??Number.NaN));for(let f of h)f.verdict=g}render(){return e`<slot></slot>`}}var N=(a)=>a?a.err:null;if(!customElements.get("klh-board-mediator"))customElements.define("klh-board-mediator",I);export{I as KlhBoardMediator};
