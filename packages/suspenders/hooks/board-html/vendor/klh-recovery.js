import{n,e,o}from"./lit-ac8284bbd881cce8.js";import{Z}from"./lit-c07b45feded0d2d0.js";import{q}from"./lit-dc0686092909f962.js";class l extends o{static properties={data:{state:!0},error:{state:!0},busy:{state:!0},now:{state:!0}};static styles=n`
		:host { display:block; margin-bottom:20px; color:var(--klh-ink); font:13px/1.5 var(--klh-font-sans); }
		header { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; border-bottom:1px solid var(--klh-edge); }
		h2 { font-size:14px; margin:0 0 8px; } h3 { font-size:12px; margin:18px 0 4px; }
		p { margin:6px 0; } .dim { color:var(--klh-dim); } .warn { color:var(--klh-danger-ink); }
		button { margin-left:auto; font:inherit; color:inherit; background:var(--klh-surface); border:1px solid var(--klh-edge); padding:4px 10px; cursor:pointer; }
		:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		.scroll { overflow:auto; } table { width:100%; border-collapse:collapse; text-align:left; }
		th { font-weight:500; color:var(--klh-dim); font-size:11px; } th, td { padding:6px 10px 6px 0; border-bottom:1px solid var(--klh-edge); vertical-align:top; }
		code { font:11px var(--klh-font-mono); overflow-wrap:anywhere; } summary { cursor:pointer; } details { margin-top:12px; }
	`;project="";stamp(t){let i=new Date(t),r=(h)=>String(h).padStart(2,"0"),s=-i.getTimezoneOffset(),a=Math.abs(s),c=`${r(i.getUTCHours())}:${r(i.getUTCMinutes())}:${r(i.getUTCSeconds())}Z`,d=`${r(i.getHours())}:${r(i.getMinutes())} UTC${s>=0?"+":"-"}${r(Math.floor(a/60))}:${r(a%60)}`;return`${c} (${d})`}generation=0;timer=null;clock=null;constructor(){super();this.data=null,this.error="",this.busy=!1,this.now=Date.now()}connectedCallback(){super.connectedCallback(),this.clock=setInterval(()=>{this.now=Date.now()},1000),document.addEventListener("change",this.projectChanged),window.addEventListener("hashchange",this.activated),this.timer=setInterval(()=>{if(!document.hidden&&!this.closest("section")?.hidden)this.refresh()},1e4),this.refresh()}disconnectedCallback(){if(super.disconnectedCallback(),this.timer)clearInterval(this.timer);if(this.clock)clearInterval(this.clock);document.removeEventListener("change",this.projectChanged),window.removeEventListener("hashchange",this.activated),this.generation++}activated=()=>{if(location.hash==="#governor")this.refresh()};projectChanged=(t)=>{if(t.target?.id==="proj")this.refresh()};async refresh(){let t=q("proj")?.value??"all";if(this.busy&&t===this.project)return;let i=++this.generation;if(t!==this.project)this.data=null,this.error="";this.project=t,this.busy=!0;try{let r=await fetch(`/api/recovery?project=${encodeURIComponent(t)}`,{cache:"no-store",signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error(`HTTP ${r.status}`);let s=await r.json();if(!Number.isFinite(s.ts)||!Array.isArray(s.incidents)||!Array.isArray(s.consults)||!s.outcomes)throw Error("Invalid recovery snapshot");if(i!==this.generation)return;this.data=s,this.error=""}catch(r){if(i===this.generation)this.error=r instanceof Error?r.message:"Request failed"}finally{if(i===this.generation)this.busy=!1}}lane(t){return t?t.length>20?`${t.slice(0,12)}…`:t:"unassigned"}render(){let t=this.data,i=t?Math.max(0,Math.round((this.now-t.ts)/1000)):null,r=!!t&&!Z(t.observation,this.now);return e`
			<header><h2>Recovery & collaboration</h2><span class="dim">last 24 hours · selected project</span><button type="button" ?disabled=${this.busy} @click=${this.refresh}>${this.busy?"Refreshing…":"Refresh recovery"}</button></header>
			<p class=${this.error||r?"warn":"dim"} role="status">${this.error?`Recovery unavailable: ${this.error}. ${t?"Last good snapshot retained.":"No snapshot loaded."}`:i!==null?`${r?"Stale snapshot":"Checked"} · ${i}s ago`:"Loading recovery evidence…"}</p>
			${t?.observation?e`<p class="dim">Evidence: ${t.observation.source} · ${t.observation.scope} · expires ${this.stamp(t.observation.expiresAt)}</p>`:""}
			${t?e`
				<p>${t.outcomes.resolved??0} resolved consults · ${t.outcomes.failed??0} failed · ${t.outcomes.unused??0} unused${!t.feedbackAvailable?" · outcome reporting not installed":""}</p>
				<details class="incidents"><summary>Governor incidents · ${t.incidents.filter((s)=>!s.resolved_at&&t.ts-s.last_at<1800000).length} need coordination · ${t.incidents.length} in this window</summary>
				${!t.incidentsAvailable?e`<p class="dim">Incident reporting is not installed.</p>`:!t.incidents.length?e`<p class="dim">No governor incidents recorded in this window.</p>`:e`
				<div class="scroll"><table><thead><tr><th scope="col">State</th><th scope="col">Lane / project</th><th scope="col">Resource</th><th scope="col">Attempts</th><th scope="col">Consult</th></tr></thead><tbody>${t.incidents.map((s)=>e`<tr>
				<td class=${!s.resolved_at&&t.ts-s.last_at<1800000?"warn":"dim"}>${s.resolved_at?"Resolved":t.ts-s.last_at>=1800000?"Inactive · unconfirmed":"Needs coordination"}</td>
				<td><code title=${s.sid}>${this.lane(s.sid)}</code><br><code>${s.project}</code></td><td><code>${s.resource}</code></td><td>${s.attempts}</td><td>${s.consult_id?`C${s.consult_id}`:"None queued"}</td>
				</tr>`)}</tbody></table></div>`}
				</details>
				<details><summary>Consult threads · ${t.consults.length} most recent</summary>
				<p class="dim">An answer is a candidate until the asker confirms the result. Open threads older than one hour await expiry; they are not active evidence.</p>
				${t.consults.map((s)=>e`<p><b>C${s.id}</b> · ${s.state==="OPEN"&&t.ts-s.created_at>=3600000?"OPEN · stale":s.state} · ${s.outcome??"Outcome unconfirmed"}<br><code>${this.lane(s.asker_sid)} → ${this.lane(s.expert_sid)} · ${s.scope??"No scope"} · ${s.project}</code></p>`)}
				${!t.consults.length?e`<p class="dim">No consult threads recorded in this window.</p>`:""}
				</details>
			`:""}
		`}}if(!customElements.get("klh-recovery"))customElements.define("klh-recovery",l);
