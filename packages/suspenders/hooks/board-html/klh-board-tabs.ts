// hooks/board-html/klh-board-tabs.ts — W695.3.6: the board's section tabs as
// a Lit component (UI law: components own their DOM, tokens own the styling).
// Replaces the server-rendered <nav class="tabs"> + its inline onmouseover
// handlers. The board SPA (tabs.ts) owns routing: it sets `current` and
// listens for `tab-select` (detail = tab id); location.hash stays the source
// of truth. Built by `bun run build:vendor`, served at
// /vendor/klh-board-tabs.js — offline, never CDN.
import { css, html, LitElement, nothing, type TemplateResult } from "lit";

export const BOARD_TABS: ReadonlyArray<readonly [string, string]> = [
	["decisions", "Decisions"],
	["tasks", "Tasks"],
	["lanes", "Lanes"],
	["activity", "Activity"],
	["governor", "Governor"],
	["setup", "Setup"],
	["usage", "Usage"],
];

class KlhBoardTabs extends LitElement {
	static properties = {
		current: { type: String, reflect: true },
		extraTabs: { type: Array, attribute: false },
	};

	static styles = css`
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
	`;

	declare current: string;
	declare extraTabs: ReadonlyArray<readonly [string, string]>;

	constructor() {
		super();
		this.current = "decisions";
		// overlay tabs (W775.1) — appended after the core set, styled with
		// the enterprise accent; empty = core SKU look, unchanged
		this.extraTabs = [];
	}

	private select(id: string): void {
		this.dispatchEvent(
			new CustomEvent("tab-select", {
				detail: id,
				bubbles: true,
				composed: true,
			}),
		);
	}

	protected render(): TemplateResult {
		return html`
			<nav aria-label="board sections">
				${BOARD_TABS.map(
					([id, label]) => html`
						<button
							type="button"
							data-tab=${id}
							aria-current=${this.current === id ? "true" : nothing}
							@click=${() => this.select(id)}
						>
							${label}
						</button>
					`,
				)}
				${this.extraTabs.map(
					([id, label]) => html`
						<button
							type="button"
							class="ent"
							data-tab=${id}
							aria-current=${this.current === id ? "true" : nothing}
							@click=${() => this.select(id)}
						>
							${label}
						</button>
					`,
				)}
			</nav>
		`;
	}
}

if (!customElements.get("klh-board-tabs"))
	customElements.define("klh-board-tabs", KlhBoardTabs);
