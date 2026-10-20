import{r,e,t,s}from"./lit-sq0mv1by.js";var i=[["decisions","Decisions"],["tasks","Tasks"],["lanes","Lanes"],["activity","Activity"],["governor","Governor"],["setup","Setup"],["usage","Usage"]];class o extends s{static properties={current:{type:String,reflect:!0},extraTabs:{type:Array,attribute:!1}};static styles=r`
		:host {
			display: block;
		}
		:focus-visible {
			outline: 2px solid var(--klh-accent);
			outline-offset: 2px;
		}
		nav {
			display: flex;
			gap: 2px;
			margin: 2px 0 16px;
			border-bottom: 1px solid var(--klh-edge);
		}
		button,
		a {
			background: none;
			border: none;
			border-bottom: 2px solid transparent;
			color: var(--klh-dim);
			font: inherit;
			font-size: 12px;
			font-weight: 600;
			letter-spacing: 0.04em;
			padding: 7px 12px;
			cursor: pointer;
		}
		a {
			align-self: center;
			text-decoration: none;
			border-bottom: none;
		}
		button:hover,
		a:hover {
			color: var(--klh-ink);
		}
		button[aria-current] {
			color: var(--klh-ink);
			border-bottom-color: var(--klh-accent);
		}
		button.ent[aria-current] {
			border-bottom-color: var(--klh-ent-accent, var(--klh-accent));
			color: var(--klh-ink);
		}
		button.ent:hover {
			color: var(--klh-ent-accent, var(--klh-accent));
		}
		@media (max-width: 700px) {
			nav {
				flex-wrap: wrap;
			}
			button {
				padding: 7px 9px;
			}
		}
	`;constructor(){super();this.current="decisions",this.extraTabs=[]}select(a){this.dispatchEvent(new CustomEvent("tab-select",{detail:a,bubbles:!0,composed:!0}))}render(){return e`
			<nav aria-label="board sections">
				${i.map(([a,n])=>e`
						<button
							type="button"
							data-tab=${a}
							aria-current=${this.current===a?"true":t}
							@click=${()=>this.select(a)}
						>
							${n}
						</button>
					`)}
				${this.extraTabs.map(([a,n])=>e`
						<button
							type="button"
							class="ent"
							data-tab=${a}
							aria-current=${this.current===a?"true":t}
							@click=${()=>this.select(a)}
						>
							${n}
						</button>
					`)}
			</nav>
		`}}if(!customElements.get("klh-board-tabs"))customElements.define("klh-board-tabs",o);export{i as BOARD_TABS};
