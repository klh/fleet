import{r,e,t,n}from"./lit-b59bf30faa0b21f8.js";import{S}from"./lit-b483bf61706b6925.js";import{P,o,c,b,a,i,y,C,s}from"./lit-2f69bfe86efc9f7c.js";import{m}from"./lit-bee36ad19b3b0155.js";import{f,R}from"./lit-e1fc19979af013f3.js";import{U}from"./lit-70c8b7a6a0a2f23a.js";function E(d,p,u){let l=d.observation,v=(L)=>Math.max(0,Math.round((d.now-L)/1000)),h=l&&typeof l.observedAt==="number"?v(l.observedAt):d.dataOkAt?v(d.dataOkAt):-1,z=l?Number(l.expiresAt):Number.NaN,D=!!l&&(!Number.isFinite(z)||z<=d.now||Number(l.observedAt)>d.now+5000),g="live",x="live";if(d.dataErr&&!d.dataOkAt)g="err",x="connecting";else if(d.dataErr)g="err",x=`error — last good ${p(h)}`;else if(D||h>=5)g="stale",x=`stale snapshot — observed ${p(h)}`;let I=!d.decLoaded?"decisions loading":d.decErr?"decisions unavailable":`decisions checked ${p(d.decOkAt?v(d.decOkAt):-1)}`,M=l?`Source: ${l.source} · target: ${l.target} · scope: ${l.scope} · observed: ${u(l.observedAt)} · expires: ${u(l.expiresAt)}`:"Legacy feed without observation provenance";return{cls:g,txt:x,dec:I,title:M,retry:!!d.dataErr}}var V=i({source:s(o()),target:s(o()),scope:s(o()),observedAt:s(c()),expiresAt:s(c())}),T=i({ts:c(),projects:a(i({project:o()})),sessions:s(a(i({}))),observation:s(V)}),Z=i({ts:c(),decisions:a(i({})),projects:s(a(o()))}),q=i({ts:c(),decisions:a(i({}))}),B=i({ok:C(!0),tasks:a(i({id:o(),project:o()})),projects:s(a(o()))}),H=i({ok:C(!0),series:y(o(),b()),attempts:s(y(o(),b()))}),O={data:T,dec:Z,hist:q,tasks:B,spend:H};function A(d){return(p)=>{let u=d.safeParse(p);if(!u.success)throw Error(`schema: ${P(u.error)}`)}}var k=r`
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
`;class w extends n{static properties={text:{type:String},feed:{type:String,reflect:!0}};static styles=[r`
			:host([hidden]) {
				display: none;
			}
		`,k];constructor(){super();this.text="",this.feed=""}willUpdate(){this.hidden=!this.text}retry(){this.dispatchEvent(this.feed?new f(this.feed):new R(this.id))}render(){return e`<span role="alert">${this.text}</span
			><button class="retry" type="button" @click=${this.retry}>
				retry
			</button>`}}if(!customElements.get("klh-err-banner"))customElements.define("klh-err-banner",w);class j extends n{static properties={verdict:{attribute:!1}};static styles=[r`
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
	`,k];constructor(){super();this.verdict=null}retry(){this.dispatchEvent(new f("data"))}updated(){this.title=this.verdict?this.verdict.title:""}render(){let d=this.verdict;if(!d)return e`<span class="dot stale"></span>connecting`;return e`<span class="dot ${d.cls}"></span>${d.txt}
			<span class="dim">| ${d.dec}</span>${d.retry?e` <button class="retry" type="button" @click=${this.retry}>
							retry
						</button>`:t}`}}if(!customElements.get("klh-conn-banner"))customElements.define("klh-conn-banner",j);class N extends n{static styles=r`
		:host {
			display: contents;
		}
	`;store=S();unsubs=[];ticker=null;constructor(){super();for(let[d,p]of Object.entries(O))this.store.validate(d,A(p));this.addEventListener(f.eventName,(d)=>{d.stopPropagation(),this.store.kick(d.feed,!0)})}connectedCallback(){super.connectedCallback();let d=()=>this.pushConn();this.unsubs=["data","dec"].map((p)=>this.store.subscribe(p,d)),this.ticker=setInterval(()=>{if(!document.hidden)d()},1000),d()}disconnectedCallback(){super.disconnectedCallback();for(let d of this.unsubs)d();if(this.unsubs=[],this.ticker!==null)clearInterval(this.ticker);this.ticker=null}pushConn(){let d=this.store.get("data"),p=this.store.get("dec"),u=this.querySelectorAll("klh-conn-banner");if(!u.length)return;let l=d?.data?.observation,v=E({observation:l,dataOkAt:d?.okAt??0,dataErr:F(d),decOkAt:p?.okAt??0,decErr:F(p),decLoaded:p?.loaded??!1,now:Date.now()},m,(h)=>U(h??Number.NaN));for(let h of u)h.verdict=v}render(){return e`<slot></slot>`}}var F=(d)=>d?d.err:null;if(!customElements.get("klh-board-mediator"))customElements.define("klh-board-mediator",N);export{N as KlhBoardMediator};
