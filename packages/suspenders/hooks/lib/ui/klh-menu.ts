// hooks/lib/ui/klh-menu.ts — W581 canonical menu component.
// THE menu every klh service surface adopts: fine-line monochrome icons +
// labels, hairline underline on the current item, outlined badge counts.
// Items come from the `items` property (or JSON `items` attribute):
//   [{ id, label, icon?, badge?, href? }]
// Click / Enter emits `klh-menu-select` {id}; href items navigate natively.
// `active` mirrors the current item id (aria-current). Keyboard: native tab
// order + ArrowLeft/ArrowRight roving focus.
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { icon, iconLabel } from "./icons.ts";

export interface MenuItem {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly badge?: number;
	readonly href?: string;
}

export class KlhMenu extends LitElement {
	static properties = {
		items: { type: Array },
		active: { type: String, reflect: true },
	};

	static styles = css`
		:host {
			display: block;
			font: var(--klh-text-sm, 11px)/1.45 var(--klh-font-sans);
		}
		nav {
			display: flex;
			flex-wrap: wrap;
			gap: 2px;
			border-bottom: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		}
		button,
		a {
			display: inline-flex;
			align-items: center;
			gap: 7px;
			background: none;
			border: none;
			border-bottom: 2px solid transparent;
			color: var(--klh-dim, #98958e);
			font: inherit;
			font-weight: 600;
			letter-spacing: 0.04em;
			padding: 7px 12px;
			cursor: pointer;
			text-decoration: none;
		}
		button:hover,
		a:hover {
			color: var(--klh-ink, #e8e6e1);
		}
		[aria-current] {
			color: var(--klh-ink, #e8e6e1);
			border-bottom-color: var(--klh-accent, #d8900f);
		}
		.ic {
			display: inline-flex;
			color: var(--klh-dim, #98958e);
		}
		[aria-current] .ic {
			color: var(--klh-accent, #d8900f);
		}
		.badge {
			font: var(--klh-text-xs, 10px)/1 var(--klh-font-mono);
			font-variant-numeric: tabular-nums;
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
			border-radius: var(--klh-radius, 2px);
			padding: 1px 5px;
			color: var(--klh-dim, #98958e);
		}
	`;

	declare items: MenuItem[];
	declare active: string;

	constructor() {
		super();
		this.items = [];
		this.active = "";
	}

	private select(id: string): void {
		this.active = id;
		this.dispatchEvent(
			new CustomEvent("klh-menu-select", {
				detail: { id },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private rove(e: KeyboardEvent): void {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		const els = [
			...(this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []),
		];
		const at = els.indexOf(this.shadowRoot?.activeElement as HTMLButtonElement);
		if (at < 0) return;
		e.preventDefault();
		const next =
			(at + (e.key === "ArrowRight" ? 1 : els.length - 1)) % els.length;
		els[next].focus();
	}

	protected render(): TemplateResult {
		return html`<nav role="menubar" @keydown=${this.rove}>
			${this.items.map((it) =>
				it.href
					? html`<a
								href=${it.href}
								aria-current=${it.id === this.active ? "page" : nothing}
								title=${it.label}
							>
								<span class="ic">${unsafeSVG(icon(it.icon ?? "", 15))}</span>
								${it.label}
							</a>`
					: html`<button
								type="button"
								role="menuitem"
								aria-current=${it.id === this.active ? "true" : nothing}
								title=${
									iconLabel(it.icon ?? "") === it.label ? nothing : it.label
								}
								@click=${() => this.select(it.id)}
							>
								<span class="ic">${unsafeSVG(icon(it.icon ?? "", 15))}</span>
								${it.label}
								${
									it.badge
										? html`<span class="badge">${String(it.badge)}</span>`
										: nothing
								}
							</button>`,
			)}
		</nav>`;
	}
}

customElements.define("klh-menu", KlhMenu);

declare global {
	interface HTMLElementTagNameMap {
		"klh-menu": KlhMenu;
	}
}
