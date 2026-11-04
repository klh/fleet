import{r,e,t,n}from"./lit-b59bf30faa0b21f8.js";import{g,d,v}from"./lit-9967cffdff71701c.js";import{m,I}from"./lit-0840573c4dba1f10.js";var p=(s)=>m(s??null),h=(s)=>typeof s==="string"&&s.trim().length>=8&&!/^\s*(?:#{1,6}\s*|\*\*|analysis\s+of\b|recommendation\s+:)/i.test(s),f=(s)=>{let i=String(s??"");if(i.startsWith("split"))return" psplit";if(i.startsWith("consensus "))return" pagree";return""},w=(s)=>`policy provenance: hub ${s.hub} · row ${s.id} · pin ${String(s.sha256??"").slice(0,12)}…`,y=(s)=>`— ${s.name||"leg"} (${s.model||"?"}) ${s.ok?`${s.ms}ms`:"FAILED"} — ${s.ok?s.verdict?String(s.verdict).toUpperCase():"NO VERDICT":"UNAVAILABLE"}`;class b extends n{static properties={slice:{attribute:!1},requests:{attribute:!1},collapsed:{type:Boolean,reflect:!0},histOpen:{type:Boolean,reflect:!0}};constructor(){super();this.slice={dec:{loaded:!1,err:null,okAt:0,data:null},hist:{loaded:!1,err:null,okAt:0,data:null},open:!0,query:"",filter:"",project:"",needs:{}},this.requests={answering:{},ansErr:{},sentOk:{},drafts:{},selOpt:{},advising:{},advRetry:{},advAttempts:{},advErr:{}},this.collapsed=!1,this.histOpen=!1}createRenderRoot(){return this}openDecs(){let s=this.slice.dec.data?.decisions??[],i=[];for(let a of s){if(a.dup_of)continue;if(a.state&&a.state!=="OPEN")continue;if(!this.inProject(a))continue;i.push(a)}return i}inProject(s){let i=this.slice.project;return!i||i==="all"||s.project===i}rowMatches(s,i){let a=[s.id,s.question??s.title,...i];for(let o of[this.slice.filter,this.slice.query]){if(!o)continue;let l=o.toLowerCase();if(!a.some((c)=>String(c??"").toLowerCase().includes(l)))return!1}return!0}decMatches(s){return this.rowMatches(s,[s.asked_by,s.asked_by_label,s.project])}gatedMatches(s){return this.rowMatches(s,[s.project])}byId(s){let i=this.slice.dec.data?.decisions??[];for(let a of i)if(a.id===s&&this.inProject(a))return a;return null}adviceFor(s){let i=this.byId(s);if(i&&(("advice"in i)&&i.advice||("adviceError"in i)&&i.adviceError))return i;return this.slice.needs[s]??null}pick(s,i){let a=this.byId(s);if(!a)return;for(let o of a.options??[])if(o.label===i){this.requests.selOpt[s]=i;let l=this.querySelector(`.dec[data-id="${s}"] input.ans`);if(l)l.value=i,this.requests.drafts[s]=i,l.focus();this.requestUpdate()}}send(s){let a=(this.querySelector(`.dec[data-id="${s}"] input.ans`)?.value??"").trim();if(!a){this.requests.ansErr[s]="type an answer first",this.requestUpdate();return}this.dispatchEvent(new g(s,a))}use(s){let i=this.adviceFor(s),a=this.querySelector(`.dec[data-id="${s}"] input.ans`);if(!i?.advice||!a||!h(i.advice.rec))return;a.value=i.advice.rec??"",this.requests.drafts[s]=a.value,a.focus()}toggleHist(){this.histOpen=!this.histOpen,this.dispatchEvent(new CustomEvent("hist-toggle",{detail:this.histOpen,bubbles:!0,composed:!0}))}render(){let s=this.openDecs(),i=s.filter((o)=>this.decMatches(o)),a=[this.collapsed?"closed":"",s.length>0?"has":""].filter(Boolean).join(" ");return e`
			<section id="decisions" class=${a||t}>
				<h2>
					<button
						id="decToggle"
						type="button"
						@click=${()=>{this.dispatchEvent(new CustomEvent("collapse-toggle",{detail:!this.collapsed,bubbles:!0,composed:!0}))}}
					>
						<span id="decCaret">${this.collapsed?"+":"-"}</span> Decisions needed
					</button>
					<span id="decState" aria-live="polite">${this.stateText(s)}</span>
				</h2>
				<klh-err-banner
					id="decErr"
					feed="dec"
					.text=${this.feedErrText()}
				></klh-err-banner>
				<div id="decList">
					${i.map((o)=>this.renderDec(o))}
				</div>
				<h3 class="gatedhead">
					Gated work
					<span class="dim">
						owner-gated + blocked items — the report's needs-you rows
					</span>
				</h3>
				<div id="gatedList">${this.renderGated()}</div>
			</section>
			<div id="hist">
				<div class="histhead">
					<button
						id="histHead"
						type="button"
						aria-expanded=${this.histOpen?"true":"false"}
						@click=${this.toggleHist}
					>
						<span id="histCaret">${this.histOpen?"-":"+"}</span> History
					</button>
					<span id="histState">${this.histStateText()}</span>
				</div>
				<klh-err-banner
					id="histErr"
					feed="hist"
					.text=${this.histFeedErrText()}
				></klh-err-banner>
				<div
					id="histBody"
					style=${this.histOpen?"display:block":"display:none"}
				>
					${this.renderHist()}
				</div>
			</div>
		`}feedErrText(){let s=this.slice.dec;if(!s.loaded||!s.err)return"";return`decision feed unavailable — last good ${s.okAt?p(Math.round((Date.now()-s.okAt)/1000)):"never"}`}histFeedErrText(){if(!this.histOpen)return"";let s=this.slice.hist;if(!s.err)return"";return`history unavailable — last good ${s.okAt?p(Math.round((Date.now()-s.okAt)/1000)):"never"}`}stateText(s){let i=this.slice.dec;if(!i.loaded)return"loading decisions...";if(i.err)return"";if(s.length)return this.slice.query||this.slice.filter?`${s.filter((a)=>this.decMatches(a)).length} of ${s.length} decisions shown`:`${s.length} decision${s.length===1?"":"s"} need you`;return`No pending decisions · checked ${p(Math.round((Date.now()-i.okAt)/1000))}`}renderDec(s){let i=s.id,a=this.requests,o=a.ansErr[i]||(s.owner_reason==="target-dead"?"The target lane is absent. Review the linked work and question; record an owner ruling or dismiss if obsolete.":s.delivery==="FAILED"?"delivery failed — press Send to retry":""),l=Boolean(s.owner_actionable),u=(s.dup_count??0)>1;return e`<div
			class="dec${a.sentOk[i]?" sent":""}"
			data-id=${i}
		>
			<div class="dbody">
			<div class="dhead">
				<span class="dproj mono">${s.project||"(unknown project)"}</span>
				<span class="dwho"
					>${s.asked_by_label||s.asked_by||"?"} · #${i}</span
				>
				${s.owner_actionable?e`<span class="dstale pill block"
							>${s.owner_reason==="target-dead"?"target lane absent":"owner ruling"}</span
						>`:t}
				${u?e`<span class="ddup pill"
							>+${(s.dup_count??1)-1} like this</span
						>`:t}
				${s.policy?e`<span class="dpol pill block">policy</span>`:t}
				<span class="dage dim">${this.decAge(s)}</span>
			</div>
			<div class="dq">${s.question||"(no question text)"}</div>
			<div class="dblocks">${this.blocksText(s)}</div>
			${s.policy?e`<div class="dsrc dim">${w(s.policy)}</div>`:t}
			<div class="dopts">
				${(s.options??[]).map((c)=>e`<div
						class="optrow${a.selOpt[i]===c.label?" sel":""}"
					>
						<button
							type="button"
							class="opt"
							aria-pressed=${a.selOpt[i]===c.label?"true":"false"}
							@click=${()=>c.label&&this.pick(i,c.label)}
						>
							${c.label}
						</button>
						<span class="trade dim">${c.tradeoff||""}</span>
					</div>`)}
			</div>
			${this.renderAdvice(i)}
			<div class="dans">
				<input
					class="ans"
					placeholder="your decision..."
					.value=${a.drafts[i]??""}
					@input=${(c)=>{this.requests.drafts[i]=c.target.value}}
					@keydown=${(c)=>{if(c.key==="Enter")c.preventDefault(),this.send(i)}}
				/>
			</div>
			<div class="derr" role="alert">${o}</div>
			</div>
			<div class="drail" role="group" aria-label="decision actions">
				<button
					class="send"
					type="button"
					?disabled=${a.answering[i]||!1}
					@click=${()=>this.send(i)}
				>
					${a.sentOk[i]?"Sent":l?"Record ruling":"Send"}
				</button>
				<button
					class="getrec"
					type="button"
					?disabled=${a.advising[i]!==void 0||!1}
					@click=${()=>this.dispatchEvent(new d(i))}
				>
					Get recommendation
				</button>
				<button
					class="dismiss"
					type="button"
					@click=${()=>this.dispatchEvent(new v(i))}
				>
					${s.owner_reason==="target-dead"?"Dismiss if obsolete":"Cancel"}
				</button>
			</div>
		</div>`}decAge(s){if(s.age_s!=null)return p(s.age_s);if(s.created_ts)return p(Math.max(0,Math.round((Date.now()-s.created_ts)/1000)));return""}blocksText(s){return s.task_id?`linked work: ${s.task_id} · ${s.task_title||"(untitled)"}${s.task_state?` · ${s.task_state.toLowerCase()}`:" · missing from work graph"}`:"linked work: none"}renderAdvice(s){let i=this.requests,a=this.adviceFor(s);if(i.advising[s]!==void 0){let l=Math.round((Date.now()-(i.advising[s]??0))/1000);return e`<div class="dadv">
				<span class="dim"
					>${a?.advicePending==="queued"?"recommendation queued":`getting recommendation... ${l}s`}${i.advRetry[s]?" (retrying)":""}</span
				>
			</div>`}if(i.advErr[s])return e`<div class="dadv">
				<span class="risk">advice request failed: ${i.advErr[s]}</span>
				<button
					class="advretry"
					type="button"
					@click=${()=>this.dispatchEvent(new d(s))}
				>
					retry
				</button>
			</div>`;if(a?.adviceError)return e`<div class="dadv">
				<span class="risk">advice failed: ${a.adviceError}</span>
				<button
					class="advretry"
					type="button"
					@click=${()=>this.dispatchEvent(new d(s))}
				>
					retry
				</button>
			</div>`;let o=a?.advice;if(!o)return t;return e`<div class="dadv">
			<div class="rhead">
				RECOMMENDATION${o.model?e` <span class="dim">${o.model}</span>`:t}
			</div>
			<div class="rec">${o.rec||""}</div>
			${o.rationale?e`<div class="why">${o.rationale}</div>`:t}
			${o.risk?e`<div class="risk">risk: ${o.risk}</div>`:t}
			${o.panel?this.renderPanel(o.panel):t}
			${h(o.rec)?e`<button class="use" type="button" @click=${()=>this.use(s)}>
						use
					</button>`:e`<span class="risk">No usable recommendation — retry</span>
						<button
							class="advretry"
							type="button"
							@click=${()=>this.dispatchEvent(new d(s))}
						>
							retry
						</button>`}
		</div>`}renderPanel(s){let i=String(s.consensus??"");return e`<div>
			<div class="pconsensus${f(i)}">${i}</div>
			${(s.legs??[]).map((a)=>e`<div class="pleg">${y(a)}</div>
					${!a.ok&&a.error?e`<div class="plegerr dim">${a.error}</div>`:t}`)}
		</div>`}renderGated(){return(this.slice.dec.data?.gated??[]).map((i)=>this.gatedMatches(i)?e`<div class="gated" data-id=${i.id}>
						<div class="dhead">
							<span class="dproj mono">${i.project||"(unknown project)"}</span>
							<span class="dwho"
								>${i.id} · ${i.reason==="gated"?"owner-gated":"blocked"}</span
							>
							<span class="dage dim">${p(i.age_s)}</span>
						</div>
						<div class="dq">${i.title||"(untitled)"}</div>
						<div class="dadv rec">${i.best_action||""}</div>
					</div>`:t)}histStateText(){if(!this.histOpen)return"";let s=this.slice.hist,i=this.histRows();if(!s.loaded&&!s.err)return"loading history...";if(s.err)return i.length?`${i.length} archived · stale`:"unavailable";return i.length?`${i.length} archived`:"(no archived decisions)"}histRows(){return(this.slice.hist.data?.decisions??[]).filter((i)=>i.state&&i.state!=="OPEN"&&this.inProject(i))}renderHist(){if(!this.histOpen)return[];let s=this.histRows();if(!s.length)return[];return s.map((i)=>e`<div class="hrow">
				<span class="pill hst">${String(i.state).toLowerCase()}</span>
				<span>
					<span class="hq"
						>${String(i.question||"(no question text)").slice(0,140)}</span
					>
					${i.answer_note?e`<span class="hans"
								>${String(i.answer_note).slice(0,200)}</span
							>`:t}
				</span>
				<span class="hage dim"
					>${p(I(i.answered_ts||i.ack_ts||i.created_ts))}</span
				>
			</div>`)}static styles=r`
		:host {
			display: block;
		}
	`}if(!customElements.get("klh-decisions"))customElements.define("klh-decisions",b);export{b as KlhDecisions,y as legLine,f as panelClassOf,w as policySrcOf,h as usableRec};
