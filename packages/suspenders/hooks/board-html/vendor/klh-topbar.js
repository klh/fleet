import{a,r,e,s}from"./lit-068t0yrb.js";import{i,n,l}from"./lit-bc0syz5r.js";var p=(t)=>t&&t!=="unassigned"?t.charAt(0).toUpperCase():"?",v=(t)=>["team","department"].filter((o)=>t[o]).join(" · ")||"no team tags";class h extends s{static properties={me:{type:Object},open:{state:!0},themePref:{state:!0}};static styles=r`
		${a(l)}
		:host {
			display: block;
		}
		:focus-visible {
			outline: 2px solid var(--klh-accent);
			outline-offset: 2px;
		}
		#cbar {
			display: flex;
			align-items: center;
			gap: 14px;
			padding: 7px 16px;
			border-bottom: 1px solid var(--klh-edge-soft);
			background: var(--klh-panel);
			position: sticky;
			top: 0;
			z-index: 50;
		}
		.cw {
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.1em;
			color: var(--klh-ink);
			text-decoration: none;
			white-space: nowrap;
		}
		.cwdot {
			color: var(--klh-accent);
		}
		.cend {
			margin-left: auto;
			display: flex;
			align-items: center;
			gap: 12px;
		}
		@media (max-width: 600px) {
			#cbar {
				flex-wrap: wrap;
				gap: 4px 12px;
			}
			.cend {
				margin-left: 0;
				width: 100%;
				justify-content: flex-end;
			}
		}
		.cavwrap {
			position: relative;
		}
		.cavbtn {
			width: 26px;
			height: 26px;
			border-radius: 50%;
			border: 1px solid var(--klh-edge-strong);
			background: var(--klh-surface-hi);
			color: var(--klh-ink);
			font: 600 11px/1 var(--klh-font-sans);
			cursor: pointer;
			padding: 0;
		}
		.cavbtn:hover,
		.cavbtn[aria-expanded="true"] {
			border-color: var(--klh-accent);
			color: var(--klh-accent);
		}
		.cavdrop {
			position: absolute;
			right: 0;
			top: 32px;
			width: 260px;
			background: var(--klh-surface);
			border: 1px solid var(--klh-edge);
			border-radius: 3px;
			padding: 10px 12px;
			box-shadow: 0 4px 18px var(--klh-shadow);
		}
		.cavhead {
			display: flex;
			gap: 9px;
			align-items: center;
		}
		.cavbig {
			width: 30px;
			height: 30px;
			border-radius: 50%;
			border: 1px solid var(--klh-edge-strong);
			background: var(--klh-surface-hi);
			color: var(--klh-ink);
			font: 600 13px/30px var(--klh-font-sans);
			text-align: center;
			flex: none;
		}
		.cavname {
			font-size: 12.5px;
			color: var(--klh-ink);
			font-weight: 600;
			word-break: break-all;
		}
		.cavsub {
			font-size: 10.5px;
			color: var(--klh-dim);
		}
		.cavsec {
			margin-top: 9px;
			font-size: 10px;
			color: var(--klh-dim);
			text-transform: uppercase;
			letter-spacing: 0.06em;
		}
		.cavdrop select {
			width: 100%;
			margin-top: 4px;
			background: var(--klh-bg);
			color: var(--klh-ink);
			border: 1px solid var(--klh-edge);
			border-radius: 2px;
			padding: 5px 8px;
			font: 12px var(--klh-font-mono);
		}
		.cavnote {
			margin-top: 7px;
			font-size: 10.5px;
			color: var(--klh-dim);
		}
	`;constructor(){super();this.open=!1,this.themePref="system",this.onDocClick=this.onDocClick.bind(this),this.onDocKeydown=this.onDocKeydown.bind(this),this.onThemeChange=this.onThemeChange.bind(this)}connectedCallback(){if(super.connectedCallback(),document.addEventListener("click",this.onDocClick),document.addEventListener("keydown",this.onDocKeydown),document.addEventListener("klh-themechange",this.onThemeChange),this.themePref=window.klhTheme?.pref()??"system",!this.me)this.hydrate()}disconnectedCallback(){super.disconnectedCallback(),document.removeEventListener("click",this.onDocClick),document.removeEventListener("keydown",this.onDocKeydown),document.removeEventListener("klh-themechange",this.onThemeChange)}async hydrate(){try{let t=await fetch("/api/console/me");if(!t.ok)return;let o=await t.json();if(!o.ok)return;this.me=o,window.__execPrefs=o.executor_prefs??[]}catch{}}onDocClick(t){if(this.open&&!t.composedPath().includes(this))this.open=!1}onDocKeydown(t){if(this.open&&t.key==="Escape")this.open=!1,this.renderRoot.querySelector(".cavbtn")?.focus()}onThemeChange(t){let o=t.detail;if(o)this.themePref=o.pref}toggle(){this.open=!this.open}setTheme(t){let o=t.target.value;window.klhTheme?.set(o)}actorOptions(){let t=this.me;if(!t)return[];let o=t.defaultActor??t.default_actor??"",c=t.actors.slice();if(o&&!c.includes(o))c.unshift(o);return c.length?c:["unassigned"]}mePanel(){let t=this.me,o=t.actor||"unassigned",c=t.defaultActor??t.default_actor??"";return e`
			<div class="cavhead">
				<span class="cavbig">${p(o)}</span>
				<span>
					<span class="cavname">${o}</span><br />
					<span class="cavsub">${v(t.tags??{})}</span>
				</span>
			</div>
			<div class="cavsec">switch actor (demo preview)</div>
			<select aria-label="switch actor (demo preview)">
				${this.actorOptions().map((d)=>e`<option value=${d} ?selected=${d===c}>
							${d}
						</option>`)}
			</select>
			<div class="cavnote">
				demo preview — stamps nothing live; live switching is a follow-up item
			</div>
		`}settingsPanel(){return e`
			<details class="klh-settings">
				<summary aria-label="settings" title="settings">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>
				</summary>
				<div class="klh-settings-panel" role="group" aria-label="settings">
					<fieldset class="klh-theme">
						<legend>theme</legend>
						${n.map((t)=>e`
								<label>
									<input
										type="radio"
										name=${i}
										value=${t}
										?checked=${this.themePref===t}
										@change=${this.setTheme}
									/>
									${t}
								</label>
							`)}
					</fieldset>
					<slot name="settings-extra"></slot>
				</div>
			</details>
		`}render(){return e`
			<nav id="cbar" aria-label="klh console">
				<a class="cw" href="/">klh<span class="cwdot">·</span>console</a>
				<span class="cend">
					${this.settingsPanel()}
					<span class="cavwrap">
						<button
							type="button"
							class="cavbtn"
							aria-haspopup="true"
							aria-expanded=${this.open?"true":"false"}
							aria-label="current actor"
							@click=${this.toggle}
						>
							${p(this.me?.actor??"")}
						</button>
						<div class="cavdrop" ?hidden=${!this.open}>
							${this.me?this.mePanel():e`<div class="cavname">loading actor…</div>`}
						</div>
					</span>
				</span>
			</nav>
		`}}customElements.define("klh-topbar",h);
