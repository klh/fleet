// hooks/lib/ui/klh-tree.ts — W581 fine-line tree.
// Simple hairline-guided tree (fleet overview, hub → leaves): 1px connectors
// in --klh-edge-faint, rotating chevron, LED state dot, outlined detail tag.
// `nodes` property:
//   [{ id, label, state?, detail?, open?, children? }]
// state: ok | warn | bad | off (undefined = plain). Expand/collapse is local
// UI state; `open` (default true) seeds it. Selecting a node emits
// `klh-node-select` {id}.
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { icon } from "./icons.ts";

export interface TreeNode {
	readonly id: string;
	readonly label: string;
	readonly state?: string;
	readonly detail?: string;
	readonly icon?: string;
	readonly open?: boolean;
	readonly children?: readonly TreeNode[];
}

export class KlhTree extends LitElement {
	static properties = {
		nodes: { type: Array },
		_open: { state: true },
	};

	static styles = css`
		:host {
			display: block;
			font: var(--klh-text-md, 12.5px)/1.7 var(--klh-font-sans);
			color: var(--klh-ink, #e8e6e1);
		}
		ul {
			list-style: none;
			margin: 0;
			padding: 0;
		}
		li {
			position: relative;
			padding-left: 14px;
		}
		li ul {
			padding-left: 8px;
		}
		li::before {
			content: "";
			position: absolute;
			left: 5px;
			top: 0;
			width: 1px;
			height: 100%;
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.07));
		}
		li:last-child::before {
			height: 15px;
		}
		li::after {
			content: "";
			position: absolute;
			left: 5px;
			top: 15px;
			width: 8px;
			height: 1px;
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.07));
		}
		ul.roots li::before,
		ul.roots li::after {
			display: none;
		}
		.row {
			display: flex;
			align-items: center;
			gap: 7px;
			padding: 1px 0;
			min-height: 22px;
		}
		.tw {
			flex: none;
			width: 18px;
			height: 18px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			background: none;
			border: none;
			padding: 0;
			color: var(--klh-dim, #98958e);
			cursor: pointer;
		}
		.tw svg {
			transition: transform 0.12s ease;
		}
		.tw[aria-expanded="true"] svg {
			transform: rotate(90deg);
		}
		.leafmark {
			flex: none;
			width: 18px;
			text-align: center;
			color: var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
		}
		.ic {
			flex: none;
			display: inline-flex;
			color: var(--klh-dim, #98958e);
		}
		.lbl {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.det {
			flex: none;
			font: var(--klh-text-xs, 10px)/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--klh-dim, #98958e);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: var(--klh-radius, 2px);
			padding: 0 5px;
		}
		.led {
			flex: none;
			width: 7px;
			height: 7px;
			border-radius: 50%;
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
		}
		.ok .led {
			background: var(--klh-ok, #5c7a35);
			border-color: var(--klh-ok, #5c7a35);
		}
		.warn .led {
			border-color: var(--klh-accent, #d8900f);
		}
		.bad .led {
			background: var(--klh-danger, #af2f12);
			border-color: var(--klh-danger, #af2f12);
		}
		.off {
			color: var(--klh-dim, #98958e);
		}
		button.rowbtn {
			background: none;
			border: none;
			padding: 0;
			font: inherit;
			color: inherit;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 7px;
			min-width: 0;
		}
		button.rowbtn:hover .lbl {
			text-decoration: underline;
			text-underline-offset: 3px;
		}
	`;

	declare nodes: TreeNode[];
	declare _open: Set<string>;

	constructor() {
		super();
		this.nodes = [];
		this._open = new Set();
	}

	private openKey(n: TreeNode): boolean {
		if (this._open.has(n.id)) return true;
		if (this._open.has(`!${n.id}`)) return false;
		return n.open !== false;
	}

	private toggle(id: string, currentlyOpen: boolean): void {
		// explicit override wins over the node's seed default
		this._open.delete(id);
		this._open.delete(`!${id}`);
		if (!currentlyOpen) this._open.add(id);
		this.requestUpdate();
	}

	private row(n: TreeNode, kids: readonly TreeNode[]): TemplateResult {
		const st = n.state ? ` ${n.state}` : "";
		const open = kids.length ? this.openKey(n) : false;
		return html`<div class="row">
			${kids.length
				? html`<button
						type="button"
						class="tw"
						aria-expanded=${open ? "true" : "false"}
						aria-label=${open ? `collapse ${n.label}` : `expand ${n.label}`}
						@click=${() => this.toggle(n.id, open)}
					>
						${unsafeSVG(icon("chevron", 12))}
					</button>`
				: html`<span class="leafmark" aria-hidden="true">·</span>`}
			<button
				type="button"
				class="rowbtn${st}"
				@click=${() =>
					this.dispatchEvent(
						new CustomEvent("klh-node-select", {
							detail: { id: n.id },
							bubbles: true,
							composed: true,
						}),
					)}
			>
				${n.state ? html`<span class="led" aria-hidden="true"></span>` : nothing}
				${n.icon
					? html`<span class="ic">${unsafeSVG(icon(n.icon, 14))}</span>`
					: nothing}
				<span class="lbl">${n.label}</span>
				${n.detail ? html`<span class="det">${n.detail}</span>` : nothing}
			</button>
		</div>`;
	}

	private item(n: TreeNode): TemplateResult {
		const kids = n.children ?? [];
		return html`<li>
			${this.row(n, kids)}
			${kids.length && this.openKey(n)
				? html`<ul>
						${kids.map((k) => this.item(k))}
					</ul>`
				: nothing}
		</li>`;
	}

	protected render(): TemplateResult {
		if (!this.nodes.length)
			return html`<p class="off">nothing in scope</p>`;
		return html`<ul class="roots">
			${this.nodes.map((n) => this.item(n))}
		</ul>`;
	}
}

customElements.define("klh-tree", KlhTree);

declare global {
	interface HTMLElementTagNameMap {
		"klh-tree": KlhTree;
	}
}
