import{n,e,t,o}from"./lit-ac8284bbd881cce8.js";import{z,y,P}from"./lit-c1b88aed7aa22900.js";import{S,tt}from"./lit-0faf10e1680224f0.js";var l=(s)=>S(s??null),u=(s)=>typeof s==="string"&&s.trim().length>=8&&!/^\s*(?:#{1,6}\s*|\*\*|analysis\s+of\b|recommendation\s+:)/i.test(s),v=(s)=>{let i=String(s??"");if(i.startsWith("split"))return" psplit";if(i.startsWith("consensus "))return" pagree";return""},g=(s)=>`policy provenance: hub ${s.hub} · row ${s.id} · pin ${String(s.sha256??"").slice(0,12)}…`,b=(s)=>`— ${s.name||"leg"} (${s.model||"?"}) ${s.ok?`${s.ms}ms`:"FAILED"} — ${s.ok?s.verdict?String(s.verdict).toUpperCase():"NO VERDICT":"UNAVAILABLE"}`;class h extends o{static properties={slice:{attribute:!1},requests:{attribute:!1},collapsed:{type:Boolean,reflect:!0},histOpen:{type:Boolean,reflect:!0}};constructor(){super();this.slice={dec:{loaded:!1,err:null,okAt:0,data:null},hist:{loaded:!1,err:null,okAt:0,data:null},open:!0,query:"",filter:"",project:"",needs:{}},this.requests={answering:{},ansErr:{},sentOk:{},drafts:{},selOpt:{},advising:{},advRetry:{},advAttempts:{},advErr:{}},this.collapsed=!1,this.histOpen=!1}createRenderRoot(){return this}openDecs(){let s=this.slice.dec.data?.decisions??[],i=[];for(let r of s){if(r.dup_of)continue;if(r.state&&r.state!=="OPEN")continue;if(!this.inProject(r))continue;i.push(r)}return i}inProject(s){let i=this.slice.project;return!i||i==="all"||s.project===i}rowMatches(s,i){let r=[s.id,s.question??s.title,...i];for(let a of[this.slice.filter,this.slice.query]){if(!a)continue;let c=a.toLowerCase();if(!r.some((d)=>String(d??"").toLowerCase().includes(c)))return!1}return!0}decMatches(s){return this.rowMatches(s,[s.asked_by,s.asked_by_label,s.project])}gatedMatches(s){return this.rowMatches(s,[s.project])}byId(s){let i=this.slice.dec.data?.decisions??[];for(let r of i)if(r.id===s&&this.inProject(r))return r;return null}adviceFor(s){let i=this.byId(s);if(i&&(("advice"in i)&&i.advice||("adviceError"in i)&&i.adviceError))return i;return this.slice.needs[s]??null}pick(s,i){let r=this.byId(s);if(!r)return;for(let a of r.options??[])if(a.label===i){this.requests.selOpt[s]=i;let c=this.querySelector(`.dec[data-id="${s}"] input.ans`);if(c)c.value=i,this.requests.drafts[s]=i,c.focus();this.requestUpdate()}}send(s){let r=(this.querySelector(`.dec[data-id="${s}"] input.ans`)?.value??"").trim();if(!r){this.requests.ansErr[s]="type an answer first",this.requestUpdate();return}this.dispatchEvent(new z(s,r))}use(s){let i=this.adviceFor(s),r=this.querySelector(`.dec[data-id="${s}"] input.ans`);if(!i?.advice||!r||!u(i.advice.rec))return;r.value=i.advice.rec??"",this.requests.drafts[s]=r.value,r.focus()}toggleHist(){this.histOpen=!this.histOpen,this.dispatchEvent(new CustomEvent("hist-toggle",{detail:this.histOpen,bubbles:!0,composed:!0}))}render(){let s=this.openDecs(),i=s.filter((a)=>this.decMatches(a)),r=[this.collapsed?"closed":"",s.length>0?"has":""].filter(Boolean).join(" ");return e`
			<section id="decisions" class=${r||t}>
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
					${i.map((a)=>this.renderDec(a))}
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
		`}feedErrText(){let s=this.slice.dec;if(!s.loaded||!s.err)return"";return`decision feed unavailable — last good ${s.okAt?l(Math.round((Date.now()-s.okAt)/1000)):"never"}`}histFeedErrText(){if(!this.histOpen)return"";let s=this.slice.hist;if(!s.err)return"";return`history unavailable — last good ${s.okAt?l(Math.round((Date.now()-s.okAt)/1000)):"never"}`}stateText(s){let i=this.slice.dec;if(!i.loaded)return"loading decisions...";if(i.err)return"";if(s.length)return this.slice.query||this.slice.filter?`${s.filter((r)=>this.decMatches(r)).length} of ${s.length} decisions shown`:`${s.length} decision${s.length===1?"":"s"} need you`;return`No pending decisions · checked ${l(Math.round((Date.now()-i.okAt)/1000))}`}renderDec(s){let i=s.id,r=this.requests,a=r.ansErr[i]||(s.owner_reason==="target-dead"?"The target lane is absent. Review the linked work and question; record an owner ruling or dismiss if obsolete.":s.delivery==="FAILED"?"delivery failed — press Send to retry":""),c=Boolean(s.owner_actionable),p=(s.dup_count??0)>1;return e`<div
			class="dec${r.sentOk[i]?" sent":""}"
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
				${p?e`<span class="ddup pill"
							>+${(s.dup_count??1)-1} like this</span
						>`:t}
				${s.policy?e`<span class="dpol pill block">policy</span>`:t}
				<span class="dage dim">${this.decAge(s)}</span>
			</div>
			<div class="dq">${s.question||"(no question text)"}</div>
			<div class="dblocks">${this.blocksText(s)}</div>
			${s.policy?e`<div class="dsrc dim">${g(s.policy)}</div>`:t}
			<div class="dopts">
				${(s.options??[]).map((d)=>e`<div
						class="optrow${r.selOpt[i]===d.label?" sel":""}"
					>
						<button
							type="button"
							class="opt"
							aria-pressed=${r.selOpt[i]===d.label?"true":"false"}
							@click=${()=>d.label&&this.pick(i,d.label)}
						>
							${d.label}
						</button>
						<span class="trade dim">${d.tradeoff||""}</span>
					</div>`)}
			</div>
			${this.renderAdvice(i)}
			<div class="dans">
				<input
					class="ans"
					placeholder="your decision..."
					.value=${r.drafts[i]??""}
					@input=${(d)=>{this.requests.drafts[i]=d.target.value}}
					@keydown=${(d)=>{if(d.key==="Enter")d.preventDefault(),this.send(i)}}
				/>
			</div>
			<div class="derr" role="alert">${a}</div>
			</div>
			<div class="drail" role="group" aria-label="decision actions">
				<button
					class="send"
					type="button"
					?disabled=${r.answering[i]||!1}
					@click=${()=>this.send(i)}
				>
					${r.sentOk[i]?"Sent":c?"Record ruling":"Send"}
				</button>
				<button
					class="getrec"
					type="button"
					?disabled=${r.advising[i]!==void 0||!1}
					@click=${()=>this.dispatchEvent(new y(i))}
				>
					Get recommendation
				</button>
				<button
					class="dismiss"
					type="button"
					@click=${()=>this.dispatchEvent(new P(i))}
				>
					${s.owner_reason==="target-dead"?"Dismiss if obsolete":"Cancel"}
				</button>
			</div>
		</div>`}decAge(s){if(s.age_s!=null)return l(s.age_s);if(s.created_ts)return l(Math.max(0,Math.round((Date.now()-s.created_ts)/1000)));return""}blocksText(s){return s.task_id?`linked work: ${s.task_id} · ${s.task_title||"(untitled)"}${s.task_state?` · ${s.task_state.toLowerCase()}`:" · missing from work graph"}`:"linked work: none"}renderAdvice(s){let i=this.requests,r=this.adviceFor(s);if(i.advising[s]!==void 0){let c=Math.round((Date.now()-(i.advising[s]??0))/1000);return e`<div class="dadv">
				<span class="dim"
					>${r?.advicePending==="queued"?"recommendation queued":`getting recommendation... ${c}s`}${i.advRetry[s]?" (retrying)":""}</span
				>
			</div>`}if(i.advErr[s])return e`<div class="dadv">
				<span class="risk">advice request failed: ${i.advErr[s]}</span>
				<button
					class="advretry"
					type="button"
					@click=${()=>this.dispatchEvent(new y(s))}
				>
					retry
				</button>
			</div>`;if(r?.adviceError)return e`<div class="dadv">
				<span class="risk">advice failed: ${r.adviceError}</span>
				<button
					class="advretry"
					type="button"
					@click=${()=>this.dispatchEvent(new y(s))}
				>
					retry
				</button>
			</div>`;let a=r?.advice;if(!a)return t;return e`<div class="dadv">
			<div class="rhead">
				RECOMMENDATION${a.model?e` <span class="dim">${a.model}</span>`:t}
			</div>
			<div class="rec">${a.rec||""}</div>
			${a.rationale?e`<div class="why">${a.rationale}</div>`:t}
			${a.risk?e`<div class="risk">risk: ${a.risk}</div>`:t}
			${a.panel?this.renderPanel(a.panel):t}
			${u(a.rec)?e`<button class="use" type="button" @click=${()=>this.use(s)}>
						use
					</button>`:e`<span class="risk">No usable recommendation — retry</span>
						<button
							class="advretry"
							type="button"
							@click=${()=>this.dispatchEvent(new y(s))}
						>
							retry
						</button>`}
		</div>`}renderPanel(s){let i=String(s.consensus??"");return e`<div>
			<div class="pconsensus${v(i)}">${i}</div>
			${(s.legs??[]).map((r)=>e`<div class="pleg">${b(r)}</div>
					${!r.ok&&r.error?e`<div class="plegerr dim">${r.error}</div>`:t}`)}
		</div>`}renderGated(){return(this.slice.dec.data?.gated??[]).map((i)=>this.gatedMatches(i)?e`<div class="gated" data-id=${i.id}>
						<div class="dhead">
							<span class="dproj mono">${i.project||"(unknown project)"}</span>
							<span class="dwho"
								>${i.id} · ${i.reason==="gated"?"owner-gated":"blocked"}</span
							>
							<span class="dage dim">${l(i.age_s)}</span>
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
					>${l(tt(i.answered_ts||i.ack_ts||i.created_ts))}</span
				>
			</div>`)}static styles=n`
		:host {
			display: block;
		}
	`}if(!customElements.get("klh-decisions"))customElements.define("klh-decisions",h);export{h as KlhDecisions,b as legLine,v as panelClassOf,g as policySrcOf,u as usableRec};
