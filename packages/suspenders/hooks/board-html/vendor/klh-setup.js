import{r,e,t,n}from"./lit-f18bcbfe556b7350.js";import{c,f}from"./lit-88ce58085f9deb62.js";import{w}from"./lit-dc60aaafb4061444.js";var d={llm:1,hubs:1},p=(s)=>{let i=[],a=[];for(let l of s)(d[l.id||""]?a:i).push(l);return{local:i,remote:a}};class o extends n{static properties={slice:{attribute:!1}};static styles=r`
		:host {
			display: block;
		}
	`;constructor(){super();this.slice={loaded:!1,err:null,okAt:0,data:null}}createRenderRoot(){return this}summaryText(){let s=this.slice.data?.checks??[],i=s.filter((a)=>!a.ok).length;return i?`${i} checks need attention / ${s.length} total`:`${s.length} checks passing`}renderCard(s){let i=String(s.detail||""),a=i.startsWith("/")||i.includes(".generation-");return e`
			<div class="card scard">
				<div class="shead">
					<span class="sok ${s.ok?"ok":"fail"}">${s.ok?"ok":"fail"}</span>
					<b>${s.label||s.id||"?"}</b>
				</div>
				${i?a?e`
								<details class="sdetail">
									<summary>Technical details</summary>
									<code>${i}</code>
								</details>
							`:e`<div class="sdetail dim">${i}</div>`:t}
				${s.fix?e`
							<div class="sfix">
								<code>${s.fix}</code>
								<button
									type="button"
									class="copyfix"
									data-fix=${s.fix}
									@click=${()=>this.dispatchEvent(new w(s.fix||""))}
								>
									copy
								</button>
							</div>
						`:t}
			</div>
		`}renderGroup(s,i){return e`
			<h3 class="sgroup">
				${s} <span class="dim">(${i.length})</span>
			</h3>
			${i.map((a)=>this.renderCard(a))}
		`}render(){let s=this.slice;if(!s.loaded&&!s.err)return e`<div class="state dim">loading setup checks...</div>`;let i=s.data?.checks??[],{local:a,remote:l}=p(i);return e`
			<klh-err-banner
				id="setupErr"
				class="taberr"
				feed="setup"
				.text=${s.err?`setup checks unavailable — last good ${s.okAt?c(f(s.okAt)):"never"}`:""}
			></klh-err-banner>
			<p id="setupSummary" class="setupsummary dim" aria-live="polite">
				${i.length?this.summaryText():t}
			</p>
			<div class="grid" id="setupBody">
				${a.length?this.renderGroup("Local wiring",a):t}${l.length?this.renderGroup("Remote reachability",l):t}${!a.length&&!l.length?e`<div class="state dim">(no checks returned)</div>`:t}
			</div>
		`}}if(!customElements.get("klh-setup"))customElements.define("klh-setup",o);export{o as KlhSetup,p as setupGroups};
