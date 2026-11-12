import{n,e,t,o}from"./lit-ac8284bbd881cce8.js";import{F}from"./lit-4b202956ab4a357f.js";import{a,k,A,d,u,C,Ee,i}from"./lit-ea314af12110b1c3.js";import{S}from"./lit-0faf10e1680224f0.js";import{E,le}from"./lit-8a3f11727be01257.js";import{Re}from"./lit-12a9a3472000c1cd.js";import{Nr}from"./lit-0d2d66cf0f7716f4.js";function g(r,c,l){let s=r.observation,m=(M)=>Math.max(0,Math.round((r.now-M)/1000)),p=s&&typeof s.observedAt==="number"?m(s.observedAt):r.dataOkAt?m(r.dataOkAt):-1,v=s?Number(s.expiresAt):Number.NaN,N=!!s&&(!Number.isFinite(v)||v<=r.now||Number(s.observedAt)>r.now+5000),b="live",h="live";if(r.dataErr&&!r.dataOkAt)b="err",h="connecting";else if(r.dataErr)b="err",h=`error — last good ${c(p)}`;else if(N||p>=5)b="stale",h=`stale snapshot — observed ${c(p)}`;let D=!r.decLoaded?"decisions loading":r.decErr?"decisions unavailable":`decisions checked ${c(r.decOkAt?m(r.decOkAt):-1)}`,I=s?`Source: ${s.source} · target: ${s.target} · scope: ${s.scope} · observed: ${l(s.observedAt)} · expires: ${l(s.expiresAt)}`:"Legacy feed without observation provenance";return{cls:b,txt:h,dec:D,title:I,retry:!!r.dataErr}}var L=u({source:i(a()),target:i(a()),scope:i(a()),observedAt:i(k()),expiresAt:i(k())}),R=u({ts:k(),projects:d(u({project:a()})),sessions:i(d(u({}))),observation:i(L)}),V=u({ts:k(),decisions:d(u({})),projects:i(d(a()))}),T=u({ts:k(),decisions:d(u({}))}),Z=u({ok:Ee(!0),tasks:d(u({id:a(),project:a()})),projects:i(d(a()))}),q=u({ok:Ee(!0),series:C(a(),A()),attempts:i(C(a(),A()))}),x={data:R,dec:V,hist:T,tasks:Z,spend:q};function z(r){return(c)=>{let l=r.safeParse(c);if(!l.success)throw Error(`schema: ${Re(l.error)}`)}}var f=n`
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
`;class y extends o{static properties={text:{type:String},feed:{type:String,reflect:!0}};static styles=[n`
			:host([hidden]) {
				display: none;
			}
		`,f];constructor(){super();this.text="",this.feed=""}willUpdate(){this.hidden=!this.text}retry(){this.dispatchEvent(this.feed?new E(this.feed):new le(this.id))}render(){return e`<span role="alert">${this.text}</span
			><button class="retry" type="button" @click=${this.retry}>
				retry
			</button>`}}if(!customElements.get("klh-err-banner"))customElements.define("klh-err-banner",y);class O extends o{static properties={verdict:{attribute:!1}};static styles=[n`
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
	`,f];constructor(){super();this.verdict=null}retry(){this.dispatchEvent(new E("data"))}updated(){this.title=this.verdict?this.verdict.title:""}render(){let r=this.verdict;if(!r)return e`<span class="dot stale"></span>connecting`;return e`<span class="dot ${r.cls}"></span>${r.txt}
			<span class="dim">| ${r.dec}</span>${r.retry?e` <button class="retry" type="button" @click=${this.retry}>
							retry
						</button>`:t}`}}if(!customElements.get("klh-conn-banner"))customElements.define("klh-conn-banner",O);class j extends o{static styles=n`
		:host {
			display: contents;
		}
	`;store=F();unsubs=[];ticker=null;constructor(){super();for(let[r,c]of Object.entries(x))this.store.validate(r,z(c));this.addEventListener(E.eventName,(r)=>{r.stopPropagation(),this.store.kick(r.feed,!0)})}connectedCallback(){super.connectedCallback();let r=()=>this.pushConn();this.unsubs=["data","dec"].map((c)=>this.store.subscribe(c,r)),this.ticker=setInterval(()=>{if(!document.hidden)r()},1000),r()}disconnectedCallback(){super.disconnectedCallback();for(let r of this.unsubs)r();if(this.unsubs=[],this.ticker!==null)clearInterval(this.ticker);this.ticker=null}pushConn(){let r=this.store.get("data"),c=this.store.get("dec"),l=this.querySelectorAll("klh-conn-banner");if(!l.length)return;let s=r?.data?.observation,m=g({observation:s,dataOkAt:r?.okAt??0,dataErr:w(r),decOkAt:c?.okAt??0,decErr:w(c),decLoaded:c?.loaded??!1,now:Date.now()},S,(p)=>Nr(p??Number.NaN));for(let p of l)p.verdict=m}render(){return e`<slot></slot>`}}var w=(r)=>r?r.err:null;if(!customElements.get("klh-board-mediator"))customElements.define("klh-board-mediator",j);export{j as KlhBoardMediator};
