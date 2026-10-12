// hooks/board-html/klh-topbar.ts — W658.2: the shared Lit topbar base (UI
// law: components own their DOM, tokens own the styling). Owns the console
// bar — wordmark, settings gear (theme radios + slotted page links), avatar
// button with the keyboard-reachable actor dropdown. The fleet strip ABOVE
// the bar stays server-rendered theme.ts fleetNav() (one source shared with
// the belt/bar dashboards); pages compose it themselves and slot page links
// into the settings panel.
//
// me data: `me` attribute (server-rendered console pages, JSON like
// klh-service-row's probe attr) or one /api/console/me fetch (board SPA,
// /usage) — the fetch also stamps window.__execPrefs for the board's
// dispatch dropdown. Every dynamic string is a lit text binding. Built by
// `bun run build:vendor` into board-html/vendor/ (shared lit chunk), served
// at /vendor/klh-topbar.js — offline, never CDN.
import { LitElement, css, html, unsafeCSS, type TemplateResult } from "lit";
import { THEME_KEY, THEME_PREFS, THEME_SETTINGS_CSS } from "../lib/theme.ts";

// wire shape: server ConsoleMe or the /api/console/me response body (the
// API spells default_actor + executor_prefs; the server type is camelCase)
type TopbarMe = {
	actor: string;
	tags: Record<string, string>;
	actors: string[];
	defaultActor?: string;
	default_actor?: string;
	executor_prefs?: string[];
};

const initialOf = (actor: string): string =>
	actor && actor !== "unassigned" ? actor.charAt(0).toUpperCase() : "?";

// lit text bindings escape; no esc() needed here
const tagLine = (tags: Record<string, string>): string =>
	["team", "department"].filter((k) => tags[k]).join(" · ") || "no team tags";

type KlhTheme = {
	pref: () => string;
	set: (p: string) => string;
};
declare global {
	interface Window {
		klhTheme?: KlhTheme;
		__execPrefs?: string[];
	}
}

class KlhTopbar extends LitElement {
	static properties = {
		me: { type: Object },
		open: { state: true },
		themePref: { state: true },
	};

	static styles = css`
		${unsafeCSS(THEME_SETTINGS_CSS)}
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
	`;

	declare me: TopbarMe | undefined;

	constructor() {
		super();
		// reactive props init in the constructor — class-field initializers
		// shadow Lit's accessors and silently kill re-render (W658.2 probe)
		this.open = false;
		this.themePref = "system";
		this.onDocClick = this.onDocClick.bind(this);
		this.onDocKeydown = this.onDocKeydown.bind(this);
		this.onThemeChange = this.onThemeChange.bind(this);
	}

	connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("click", this.onDocClick);
		document.addEventListener("keydown", this.onDocKeydown);
		document.addEventListener("klh-themechange", this.onThemeChange);
		this.themePref = window.klhTheme?.pref() ?? "system";
		if (!this.me) void this.hydrate();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener("click", this.onDocClick);
		document.removeEventListener("keydown", this.onDocKeydown);
		document.removeEventListener("klh-themechange", this.onThemeChange);
	}

	private async hydrate(): Promise<void> {
		try {
			const r = await fetch("/api/console/me");
			if (!r.ok) return;
			const d = (await r.json()) as TopbarMe & { ok?: boolean };
			if (!d.ok) return;
			this.me = d;
			window.__execPrefs = d.executor_prefs ?? [];
		} catch {
			// feed unavailable — the bar still renders, "?" avatar
		}
	}

	private onDocClick(e: Event): void {
		if (this.open && !e.composedPath().includes(this)) this.open = false;
	}

	private onDocKeydown(e: KeyboardEvent): void {
		if (this.open && e.key === "Escape") {
			this.open = false;
			this.renderRoot.querySelector<HTMLButtonElement>(".cavbtn")?.focus();
		}
	}

	private onThemeChange(e: Event): void {
		const t = (e as CustomEvent<{ theme: string; pref: string }>).detail;
		if (t) this.themePref = t.pref;
	}

	private toggle(): void {
		this.open = !this.open;
	}

	private setTheme(e: Event): void {
		const v = (e.target as HTMLInputElement).value;
		void window.klhTheme?.set(v);
	}

	private actorOptions(): string[] {
		const m = this.me;
		if (!m) return [];
		const def = m.defaultActor ?? m.default_actor ?? "";
		const opts = m.actors.slice();
		if (def && !opts.includes(def)) opts.unshift(def);
		return opts.length ? opts : ["unassigned"];
	}

	private mePanel(): TemplateResult {
		const m = this.me as TopbarMe;
		const actor = m.actor || "unassigned";
		const def = m.defaultActor ?? m.default_actor ?? "";
		return html`
			<div class="cavhead">
				<span class="cavbig">${initialOf(actor)}</span>
				<span>
					<span class="cavname">${actor}</span><br />
					<span class="cavsub">${tagLine(m.tags ?? {})}</span>
				</span>
			</div>
			<div class="cavsec">switch actor (demo preview)</div>
			<select aria-label="switch actor (demo preview)">
				${this.actorOptions().map(
					(a) =>
						html`<option value=${a} ?selected=${a === def}>
							${a}
						</option>`,
				)}
			</select>
			<div class="cavnote">
				demo preview — stamps nothing live; live switching is a follow-up item
			</div>
		`;
	}

	private settingsPanel(): TemplateResult {
		return html`
			<details class="klh-settings">
				<summary aria-label="settings" title="settings">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>
				</summary>
				<div class="klh-settings-panel" role="group" aria-label="settings">
					<fieldset class="klh-theme">
						<legend>theme</legend>
						${THEME_PREFS.map(
							(p) => html`
								<label>
									<input
										type="radio"
										name=${THEME_KEY}
										value=${p}
										?checked=${this.themePref === p}
										@change=${this.setTheme}
									/>
									${p}
								</label>
							`,
						)}
					</fieldset>
					<slot name="settings-extra"></slot>
				</div>
			</details>
		`;
	}

	protected render(): TemplateResult {
		return html`
			<nav id="cbar" aria-label="klh console">
				<a class="cw" href="/">klh<span class="cwdot">·</span>console</a>
				<span class="cend">
					${this.settingsPanel()}
					<span class="cavwrap">
						<button
							type="button"
							class="cavbtn"
							aria-haspopup="true"
							aria-expanded=${this.open ? "true" : "false"}
							aria-label="current actor"
							@click=${this.toggle}
						>
							${initialOf(this.me?.actor ?? "")}
						</button>
						<div class="cavdrop" ?hidden=${!this.open}>
							${
								this.me
									? this.mePanel()
									: html`<div class="cavname">loading actor…</div>`
							}
						</div>
					</span>
				</span>
			</nav>
		`;
	}
}

customElements.define("klh-topbar", KlhTopbar);
