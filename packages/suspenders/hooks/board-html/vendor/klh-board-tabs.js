import{n,e,t,o}from"./lit-ac8284bbd881cce8.js";var i=[["decisions","Decisions"],["tasks","Tasks"],["lanes","Lanes"],["activity","Activity"],["report","Report"],["governor","Governor"],["setup","Setup"],["usage","Usage"]];class s extends o{static properties={current:{type:String,reflect:!0},extraTabs:{type:Array,attribute:!1}};static styles=n`
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
			margin: 0 0 14px;
			border-bottom: 1px solid var(--klh-edge);
		}
		button,
		a {
			background: none;
			border: none;
			border-bottom: 2px solid transparent;
			color: var(--klh-dim);
			font: inherit;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.09em;
			text-transform: uppercase;
			padding: 8px 12px 7px;
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
	`;constructor(){super();this.current="decisions",this.extraTabs=[]}select(r){this.dispatchEvent(new CustomEvent("tab-select",{detail:r,bubbles:!0,composed:!0}))}render(){return e`
			<nav aria-label="board sections">
				${i.map(([r,a])=>e`
						<button
							type="button"
							data-tab=${r}
							aria-current=${this.current===r?"true":t}
							@click=${()=>this.select(r)}
						>
							${a}
						</button>
					`)}
				${this.extraTabs.map(([r,a])=>e`
						<button
							type="button"
							class="ent"
							data-tab=${r}
							aria-current=${this.current===r?"true":t}
							@click=${()=>this.select(r)}
						>
							${a}
						</button>
					`)}
			</nav>
		`}}if(!customElements.get("klh-board-tabs"))customElements.define("klh-board-tabs",s);export{i as BOARD_TABS};
