// hooks/board-html/klh-setup.ts — the setup tab as a light-DOM Lit feature
// (W2550.3; replaces the legacy SETUP string chunk). It renders the W858.7.21
// grouped checklist — Local wiring (files, plists, settings) vs Remote
// reachability (network probes; REMOTE_CHECKS pins the minority, unmapped
// ids default to local, never hidden) — with copy-fix buttons that ask the
// mediator via a typed SetupFixCopyRequestedEvent. It renders into the
// page's light DOM — the section skeleton and CSS stay in the page
// (#tab-setup ids, .scard/.shead/.sok/.sdetail/.sfix/.copyfix, h3.sgroup
// classes keep every existing locator), so `createRenderRoot` returns the
// host. Properties in, events out: the mediator owns the feed and pushes
// the slice; every text lands through lit bindings (never a string HTML
// sink), and ages re-tick at 1Hz from the mediator's slice push.
import { css, html, LitElement, nothing } from "lit";
import { ago, msAgo } from "./board-format.ts";
import { SetupFixCopyRequestedEvent } from "./setup-events.ts";
import type { SetupCheck, SetupSlice } from "./setup-slice.ts";

/** W858.7.21: ids whose check verifies the far end, not this machine. */
const REMOTE_CHECKS: Record<string, 1> = { llm: 1, hubs: 1 };

export class KlhSetup extends LitElement {
	static properties = {
		slice: { attribute: false },
	};

	declare slice: SetupSlice;

	static styles = css`
		:host {
			display: block;
		}
	`;

	constructor() {
		super();
		this.slice = { loaded: false, err: null, okAt: 0, data: null };
	}

	/** Light DOM: the section skeleton and page CSS keep working. */
	protected createRenderRoot(): this {
		return this;
	}

	/** The summary line: attention count, or all passing. */
	private summaryText(): string {
		const cs = this.slice.data?.checks ?? [];
		const failures = cs.filter((c) => !c.ok).length;
		return failures
			? `${failures} checks need attention / ${cs.length} total`
			: `${cs.length} checks passing`;
	}

	/** One check card: state pill + label, detail (technical <details> for
	 * path/machine-scoped text, plain dim line otherwise), fix command with
	 * its copy button. */
	private renderCard(c: SetupCheck) {
		const detail = String(c.detail || "");
		const technical = detail.startsWith("/") || detail.includes(".generation-");
		return html`
			<div class="card scard">
				<div class="shead">
					<span class="sok ${c.ok ? "ok" : "fail"}">${c.ok ? "ok" : "fail"}</span>
					<b>${c.label || c.id || "?"}</b>
				</div>
				${
					detail
						? technical
							? html`
								<details class="sdetail">
									<summary>Technical details</summary>
									<code>${detail}</code>
								</details>
							`
							: html`<div class="sdetail dim">${detail}</div>`
						: nothing
				}
				${
					c.fix
						? html`
							<div class="sfix">
								<code>${c.fix}</code>
								<button
									type="button"
									class="copyfix"
									data-fix=${c.fix}
									@click=${() =>
										this.dispatchEvent(
											new SetupFixCopyRequestedEvent(c.fix || ""),
										)}
								>
									copy
								</button>
							</div>
						`
						: nothing
				}
			</div>
		`;
	}

	/** One group heading with its live count. */
	private renderGroup(title: string, cards: SetupCheck[]) {
		return html`
			<h3 class="sgroup">
				${title} <span class="dim">(${cards.length})</span>
			</h3>
			${cards.map((c) => this.renderCard(c))}
		`;
	}

	protected render() {
		const s = this.slice;
		if (!s.loaded && !s.err)
			return html`<div class="state dim">loading setup checks...</div>`;
		const cs = s.data?.checks ?? [];
		const local: SetupCheck[] = [];
		const remote: SetupCheck[] = [];
		for (const c of cs) (REMOTE_CHECKS[c.id || ""] ? remote : local).push(c);
		return html`
			<klh-err-banner
				id="setupErr"
				class="taberr"
				feed="setup"
				.text=${
					s.err
						? `setup checks unavailable — last good ${
								s.okAt ? ago(msAgo(s.okAt)) : "never"
							}`
						: ""
				}
			></klh-err-banner>
			<p id="setupSummary" class="setupsummary dim" aria-live="polite">
				${cs.length ? this.summaryText() : nothing}
			</p>
			<div class="grid" id="setupBody">
				${local.length ? this.renderGroup("Local wiring", local) : nothing}${
					remote.length
						? this.renderGroup("Remote reachability", remote)
						: nothing
				}${
					!local.length && !remote.length
						? html`<div class="state dim">(no checks returned)</div>`
						: nothing
				}
			</div>
		`;
	}
}

if (!customElements.get("klh-setup"))
	customElements.define("klh-setup", KlhSetup);

declare global {
	interface HTMLElementTagNameMap {
		"klh-setup": KlhSetup;
	}
}
