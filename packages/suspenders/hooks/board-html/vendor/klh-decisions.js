import{n,e,t,r}from"./lit-f32c0cedac4dc611.js";import{m,b}from"./lit-e55ba8f95b31289c.js";import{c,i,u}from"./lit-ddc30ea03c3a459b.js";var h=(s)=>m(s??null),g=(s)=>typeof s==="string"&&s.trim().length>=8&&!/^\s*(?:#{1,6}\s*|\*\*|analysis\s+of\b|recommendation\s+:)/i.test(s),w=(s)=>{let a=String(s??"");if(a.startsWith("split"))return" psplit";if(a.startsWith("consensus "))return" pagree";return""},y=(s)=>`policy provenance: hub ${s.hub} · row ${s.id} · pin ${String(s.sha256??"").slice(0,12)}…`,k=(s)=>`— ${s.name||"leg"} (${s.model||"?"}) ${s.ok?`${s.ms}ms`:"FAILED"} — ${s.ok?s.verdict?String(s.verdict).toUpperCase():"NO VERDICT":"UNAVAILABLE"}`;class f extends r{static properties={slice:{attribute:!1},requests:{attribute:!1},collapsed:{type:Boolean,reflect:!0},histOpen:{type:Boolean,reflect:!0}};constructor(){super();this.slice={dec:{loaded:!1,err:null,okAt:0,data:null},hist:{loaded:!1,err:null,okAt:0,data:null},open:!0,query:"",filter:"",project:"",needs:{}},this.requests={answering:{},ansErr:{},sentOk:{},drafts:{},selOpt:{},advising:{},advRetry:{},advAttempts:{},advErr:{}},this.collapsed=!1,this.histOpen=!1}createRenderRoot(){return this}openDecs(){let s=this.slice.dec.data?.decisions??[],a=[];for(let o of s){if(o.dup_of)continue;if(o.state&&o.state!=="OPEN")continue;if(!this.inProject(o))continue;a.push(o)}return a}inProject(s){let a=this.slice.project;return!a||a==="all"||s.project===a}matches(s,a){let o=[s.id,s.question??s.title,...a];for(let d of[this.slice.filter,this.slice.query]){if(!d)continue;let p=d.toLowerCase();if(!o.some((l)=>String(l??"").toLowerCase().includes(p)))return!1}return!0}decMatches(s){return this.matches(s,[s.asked_by,s.asked_by_label,s.project])}gatedMatches(s){return this.matches(s,[s.project])}byId(s){let a=this.slice.dec.data?.decisions??[];for(let o of a)if(o.id===s&&this.inProject(o))return o;return null}adviceFor(s){let a=this.byId(s);if(a&&(("advice"in a)&&a.advice||("adviceError"in a)&&a.adviceError))return a;return this.slice.needs[s]??null}pick(s,a){let o=this.byId(s);if(!o)return;for(let d of o.options??[])if(d.label===a){this.requests.selOpt[s]=a;let p=this.querySelector(`.dec[data-id="${s}"] input.ans`);if(p)p.value=a,this.requests.drafts[s]=a,p.focus();this.requestUpdate()}}send(s){let o=(this.querySelector(`.dec[data-id="${s}"] input.ans`)?.value??"").trim();if(!o){this.requests.ansErr[s]="type an answer first",this.requestUpdate();return}this.dispatchEvent(new c(s,o))}use(s){let a=this.adviceFor(s),o=this.querySelector(`.dec[data-id="${s}"] input.ans`);if(!a?.advice||!o||!g(a.advice.rec))return;o.value=a.advice.rec??"",this.requests.drafts[s]=o.value,o.focus()}toggleHist(){this.histOpen=!this.histOpen,this.dispatchEvent(new CustomEvent("hist-toggle",{detail:this.histOpen,bubbles:!0,composed:!0}))}render(){let s=this.openDecs(),a=s.filter((d)=>this.decMatches(d)),o=[this.collapsed?"closed":"",s.length>0?"has":""].filter(Boolean).join(" ");return e`
			<section id="decisions" class=${o||t}>
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
					${a.map((d)=>this.renderDec(d))}
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
		`}feedErrText(){let s=this.slice.dec;if(!s.loaded||!s.err)return"";return`decision feed unavailable — last good ${s.okAt?h(Math.round((Date.now()-s.okAt)/1000)):"never"}`}histFeedErrText(){if(!this.histOpen)return"";let s=this.slice.hist;if(!s.err)return"";return`history unavailable — last good ${s.okAt?h(Math.round((Date.now()-s.okAt)/1000)):"never"}`}stateText(s){let a=this.slice.dec;if(!a.loaded)return"loading decisions...";if(a.err)return"";if(s.length)return this.slice.query||this.slice.filter?`${s.filter((o)=>this.decMatches(o)).length} of ${s.length} decisions shown`:`${s.length} decision${s.length===1?"":"s"} need you`;return`No pending decisions · checked ${h(Math.round((Date.now()-a.okAt)/1000))}`}renderDec(s){let a=s.id,o=this.requests,d=o.ansErr[a]||(s.owner_reason==="target-dead"?"The target lane is absent. Review the linked work and question; record an owner ruling or dismiss if obsolete.":s.delivery==="FAILED"?"delivery failed — press Send to retry":""),p=Boolean(s.owner_actionable),v=(s.dup_count??0)>1;return e`<div
			class="dec${o.sentOk[a]?" sent":""}"
			data-id=${a}
		>
			<div class="dbody">
			<div class="dhead">
				<span class="dproj mono">${s.project||"(unknown project)"}</span>
				<span class="dwho"
					>${s.asked_by_label||s.asked_by||"?"} · #${a}</span
				>
				${s.owner_actionable?e`<span class="dstale pill block"
							>${s.owner_reason==="target-dead"?"target lane absent":"owner ruling"}</span
						>`:t}
				${v?e`<span class="ddup pill"
							>+${(s.dup_count??1)-1} like this</span
						>`:t}
				${s.policy?e`<span class="dpol pill block">policy</span>`:t}
				<span class="dage dim">${this.decAge(s)}</span>
			</div>
			<div class="dq">${s.question||"(no question text)"}</div>
			<div class="dblocks">${this.blocksText(s)}</div>
			${s.policy?e`<div class="dsrc dim">${y(s.policy)}</div>`:t}
			<div class="dopts">
				${(s.options??[]).map((l)=>e`<div
						class="optrow${o.selOpt[a]===l.label?" sel":""}"
					>
						<button
							type="button"
							class="opt"
							aria-pressed=${o.selOpt[a]===l.label?"true":"false"}
							@click=${()=>l.label&&this.pick(a,l.label)}
						>
							${l.label}
						</button>
						<span class="trade dim">${l.tradeoff||""}</span>
					</div>`)}
			</div>
			${this.renderAdvice(a)}
			<div class="dans">
				<input
					class="ans"
					placeholder="your decision..."
					.value=${o.drafts[a]??""}
					@input=${(l)=>{this.requests.drafts[a]=l.target.value}}
					@keydown=${(l)=>{if(l.key==="Enter")l.preventDefault(),this.send(a)}}
				/>
			</div>
			<div class="derr" role="alert">${d}</div>
			</div>
			<div class="drail" role="group" aria-label="decision actions">
				<button
					class="send"
					type="button"
					?disabled=${o.answering[a]||!1}
					@click=${()=>this.send(a)}
				>
					${o.sentOk[a]?"Sent":p?"Record ruling":"Send"}
				</button>
				<button
					class="getrec"
					type="button"
					?disabled=${o.advising[a]!==void 0||!1}
					@click=${()=>this.dispatchEvent(new i(a))}
				>
					Get recommendation
				</button>
				<button
					class="dismiss"
					type="button"
					@click=${()=>this.dispatchEvent(new u(a))}
				>
					${s.owner_reason==="target-dead"?"Dismiss if obsolete":"Cancel"}
				</button>
			</div>
		</div>`}decAge(s){if(s.age_s!=null)return h(s.age_s);if(s.created_ts)return h(Math.max(0,Math.round((Date.now()-s.created_ts)/1000)));return""}blocksText(s){return s.task_id?`linked work: ${s.task_id} · ${s.task_title||"(untitled)"}${s.task_state?` · ${s.task_state.toLowerCase()}`:" · missing from work graph"}`:"linked work: none"}renderAdvice(s){let a=this.requests,o=this.adviceFor(s);if(a.advising[s]!==void 0){let p=Math.round((Date.now()-(a.advising[s]??0))/1000);return e`<div class="dadv">
				<span class="dim"
					>${o?.advicePending==="queued"?"recommendation queued":`getting recommendation... ${p}s`}${a.advRetry[s]?" (retrying)":""}</span
				>
			</div>`}if(a.advErr[s])return e`<div class="dadv">
				<span class="risk">advice request failed: ${a.advErr[s]}</span>
				<button
					class="advretry"
					type="button"
					@click=${()=>this.dispatchEvent(new i(s))}
				>
					retry
				</button>
			</div>`;if(o?.adviceError)return e`<div class="dadv">
				<span class="risk">advice failed: ${o.adviceError}</span>
				<button
					class="advretry"
					type="button"
					@click=${()=>this.dispatchEvent(new i(s))}
				>
					retry
				</button>
			</div>`;let d=o?.advice;if(!d)return t;return e`<div class="dadv">
			<div class="rhead">
				RECOMMENDATION${d.model?e` <span class="dim">${d.model}</span>`:t}
			</div>
			<div class="rec">${d.rec||""}</div>
			${d.rationale?e`<div class="why">${d.rationale}</div>`:t}
			${d.risk?e`<div class="risk">risk: ${d.risk}</div>`:t}
			${d.panel?this.renderPanel(d.panel):t}
			${g(d.rec)?e`<button class="use" type="button" @click=${()=>this.use(s)}>
						use
					</button>`:e`<span class="risk">No usable recommendation — retry</span>
						<button
							class="advretry"
							type="button"
							@click=${()=>this.dispatchEvent(new i(s))}
						>
							retry
						</button>`}
		</div>`}renderPanel(s){let a=String(s.consensus??"");return e`<div>
			<div class="pconsensus${w(a)}">${a}</div>
			${(s.legs??[]).map((o)=>e`<div class="pleg">${k(o)}</div>
					${!o.ok&&o.error?e`<div class="plegerr dim">${o.error}</div>`:t}`)}
		</div>`}renderGated(){return(this.slice.dec.data?.gated??[]).map((a)=>this.gatedMatches(a)?e`<div class="gated" data-id=${a.id}>
						<div class="dhead">
							<span class="dproj mono">${a.project||"(unknown project)"}</span>
							<span class="dwho"
								>${a.id} · ${a.reason==="gated"?"owner-gated":"blocked"}</span
							>
							<span class="dage dim">${h(a.age_s)}</span>
						</div>
						<div class="dq">${a.title||"(untitled)"}</div>
						<div class="dadv rec">${a.best_action||""}</div>
					</div>`:t)}histStateText(){if(!this.histOpen)return"";let s=this.slice.hist,a=this.histRows();if(!s.loaded&&!s.err)return"loading history...";if(s.err)return a.length?`${a.length} archived · stale`:"unavailable";return a.length?`${a.length} archived`:"(no archived decisions)"}histRows(){return(this.slice.hist.data?.decisions??[]).filter((a)=>a.state&&a.state!=="OPEN"&&this.inProject(a))}renderHist(){if(!this.histOpen)return[];let s=this.histRows();if(!s.length)return[];return s.map((a)=>e`<div class="hrow">
				<span class="pill hst">${String(a.state).toLowerCase()}</span>
				<span>
					<span class="hq"
						>${String(a.question||"(no question text)").slice(0,140)}</span
					>
					${a.answer_note?e`<span class="hans"
								>${String(a.answer_note).slice(0,200)}</span
							>`:t}
				</span>
				<span class="hage dim"
					>${h(b(a.answered_ts||a.ack_ts||a.created_ts))}</span
				>
			</div>`)}static styles=n`
		:host {
			display: block;
		}
	`}if(!customElements.get("klh-decisions"))customElements.define("klh-decisions",f);export{f as KlhDecisions,k as legLine,w as panelClassOf,y as policySrcOf,g as usableRec};
