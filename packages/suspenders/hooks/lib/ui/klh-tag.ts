// hooks/lib/ui/klh-tag.ts — W581 canonical outlined tag.
// Small, uppercase, hairline outline — the restrained semantic-color chip
// every surface uses for state/provenance labels. Tones map to restrained
// semantic tokens; `dim` (default) is the neutral outline.
import { LitElement, css, html, type TemplateResult } from "lit";

const TONES = ["dim", "ok", "warn", "bad", "info", "accent"] as const;
export type TagTone = (typeof TONES)[number];

export const tagTone = (v: unknown): TagTone => {
	const s = String(v ?? "").toLowerCase();
	return (TONES as readonly string[]).includes(s) ? (s as TagTone) : "dim";
};

export class KlhTag extends LitElement {
	static properties = { tone: { type: String, reflect: true } };

	static styles = css`
		:host {
			display: inline-block;
			font: var(--klh-text-xs, 10px)/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.06em;
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
			border-radius: var(--klh-radius, 2px);
			padding: 0 6px;
			color: var(--klh-dim, #98958e);
			vertical-align: 1px;
			white-space: nowrap;
		}
		:host([tone="ok"]) {
			color: var(--klh-ok-ink, #7da652);
			border-color: var(--klh-ok, #5c7a35);
		}
		:host([tone="warn"]) {
			color: var(--klh-accent, #d8900f);
			border-color: var(--klh-accent, #d8900f);
		}
		:host([tone="bad"]) {
			color: var(--klh-danger-ink, #c96a4f);
			border-color: var(--klh-danger, #af2f12);
		}
		:host([tone="info"]) {
			color: var(--klh-info, #8cbbad);
			border-color: var(--klh-info, #8cbbad);
		}
		:host([tone="accent"]) {
			color: var(--klh-accent, #d8900f);
			border-color: var(--klh-accent, #d8900f);
		}
	`;

	declare tone: TagTone;

	constructor() {
		super();
		this.tone = "dim";
	}

	protected render(): TemplateResult {
		return html`<slot></slot>`;
	}
}

customElements.define("klh-tag", KlhTag);

declare global {
	interface HTMLElementTagNameMap {
		"klh-tag": KlhTag;
	}
}
