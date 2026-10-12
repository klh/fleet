import{r,e,t,s}from"./lit-sq0mv1by.js";var i=[["decisions","Decisions"],["tasks","Tasks"],["lanes","Lanes"],["activity","Activity"],["governor","Governor"],["setup","Setup"]];class n extends s{static properties={current:{type:String,reflect:!0}};static styles=r`
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
		@media (max-width: 700px) {
			nav {
				flex-wrap: wrap;
			}
			button {
				padding: 7px 9px;
			}
		}
	`;constructor(){super();this.current="decisions"}select(o){this.dispatchEvent(new CustomEvent("tab-select",{detail:o,bubbles:!0,composed:!0}))}render(){return e`
			<nav aria-label="board sections">
				${i.map(([o,a])=>e`
						<button
							type="button"
							data-tab=${o}
							aria-current=${this.current===o?"true":t}
							@click=${()=>this.select(o)}
						>
							${a}
						</button>
					`)}
				<a href="/usage">Usage</a>
			</nav>
		`}}if(!customElements.get("klh-board-tabs"))customElements.define("klh-board-tabs",n);export{i as BOARD_TABS};
