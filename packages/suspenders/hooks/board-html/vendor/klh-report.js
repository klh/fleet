import{r,e,t,n}from"./lit-f18bcbfe556b7350.js";import{c,f}from"./lit-88ce58085f9deb62.js";import{x}from"./lit-8e6da95b14fcc99c.js";class o extends n{static properties={slice:{attribute:!1}};static styles=r`
		:host {
			display: block;
		}
	`;constructor(){super();this.slice={loaded:!1,err:null,okAt:0,data:null,open:"",detail:null,detailErr:null,detailBusy:!1}}createRenderRoot(){return this}stampText(){let a=this.slice.data;if(!a)return"";let i=(a.rows??[]).length,s=a.capacity?` · ${a.capacity}`:"";return`the work report · checked ${c(f(this.slice.okAt))} · ${i} rows${s}`}headText(a){let i=a.ownerSid?` · lane ${a.ownerSid}`:"",s=a.lastEventTs?` · last event ${c(f(a.lastEventTs))}`:" · no events yet";return`${a.id??""} · ${String(a.state??"").toLowerCase()}${i}${s}`}render(){let a=this.slice,i=a.data?.rows??[];return e`
			<div class="taskbar">
				<span id="reportStamp" class="dim" role="status">
					${this.stampText()}
				</span>
			</div>
			<klh-err-banner
				id="reportErr"
				class="taberr"
				feed="report"
				.text=${a.err?`report feed unavailable — last good ${a.okAt?c(f(a.okAt)):"never"}`:""}
			></klh-err-banner>
			<pre id="reportTable" class="rpttable">${a.data?.table||"loading the work report..."}</pre>
			<nav
				id="reportRows"
				class="rptstrip"
				aria-label="Expand a report row for its live lane detail"
			>
				${i.map((s)=>e`
						<button
							type="button"
							class=${a.open===s.id?"rptrow on":"rptrow"}
							data-rid=${s.id}
							title=${s.title}
							@click=${()=>this.dispatchEvent(new x(s.id))}
						>
							${s.id} ${s.st}
						</button>
					`)}
			</nav>
			<div id="reportDetail" class="rptdetail">${this.renderDetail()}</div>
		`}renderDetail(){let a=this.slice;if(!a.open)return t;if(a.detailBusy&&!a.detail&&!a.detailErr)return e`loading row detail...`;if(a.detailErr)return e`row unavailable: ${a.detailErr}`;let i=a.detail;if(!i)return t;let s=i.laneTail??[];return e`
			<div class="rpthead">${this.headText(i)}</div>
			${s.length?e`
						<div class="rpttail">
							${s.map((l)=>e`<div class="trow">
										${l.ts?`[${l.ts}] ${l.text}`:l.text}
									</div>`)}
						</div>
					`:e`<div class="dim">
						no live lane transcript for this row
					</div>`}
		`}}if(!customElements.get("klh-report"))customElements.define("klh-report",o);export{o as KlhReport};
