import{s,t,e,r}from"./vendor/lit-b2fchqc3.js";import{i,o}from"./vendor/lit-3pe70h91.js";class c extends r{static properties={verdict:{attribute:!1}};static styles=[s`
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
	`,o];constructor(){super();this.verdict=null}retry(){this.dispatchEvent(new i("data"))}updated(){this.title=this.verdict?this.verdict.title:""}render(){let n=this.verdict;if(!n)return t`<span class="dot stale"></span>connecting`;return t`<span class="dot ${n.cls}"></span>${n.txt}
			<span class="dim">| ${n.dec}</span>${n.retry?t` <button class="retry" type="button" @click=${this.retry}>
							retry
						</button>`:e}`}}if(!customElements.get("klh-conn-banner"))customElements.define("klh-conn-banner",c);export{c as KlhConnBanner};
