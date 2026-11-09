// hooks/board-html/klh-setup-mediator.ts — the setup family's mediator
// (W2550.3; owns what the legacy SETUP chunk did at page scope). It defines
// and subscribes the setup feed on the ONE page-wide FeedStore (boardFeeds())
// and pushes the computed slice down as a property. The feed polls only on
// the setup tab (url() gates — inactive feeds never fetch); the server's
// stale-while-revalidate seed (window.__SETUP__, W852) is honored BEFORE the
// first poll so the tab paints real cards on first paint, never a loading
// flash. Copy-fix rides the typed SetupFixCopyRequestedEvent (clipboard +
// toast, both owned here — the old chunk's copyfix contract); success and
// failure toast the same lines, and last-good age re-ticks at 1Hz without a
// fetch. Light-DOM children stay where the page put them (display:
// contents), so ids and page CSS keep working.
import { css, html, LitElement } from "lit";
import type { FeedStore } from "./feed-store.ts";
import { boardFeeds } from "./feed-store.ts";
import type { KlhSetup } from "./klh-setup.ts";
import { SetupFixCopyRequestedEvent } from "./setup-events.ts";
import type { SetupFeed } from "./setup-slice.ts";

/** One /api/setup payload (loose — the feed accept gates the wire). */
type SetupApiFeed = SetupFeed;

const setupAccept = (j: unknown): void => {
	const o = j as SetupApiFeed | null;
	if (!o || o.ok === false || !Array.isArray(o.checks))
		throw new Error("bad /api/setup payload");
};

export class KlhSetupMediator extends LitElement {
	static styles = css`
		:host {
			display: contents;
		}
	`;

	private store: FeedStore = boardFeeds();
	private unsubs: (() => void)[] = [];
	private ticker: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super();
		this.addEventListener(SetupFixCopyRequestedEvent.eventName, this.onFixCopy);
	}

	connectedCallback(): void {
		super.connectedCallback();
		this.store.define("setup", {
			everyMs: 5000, // machine wiring checks move slowly; tab switches kick at once
			url: () => (this.visTab() === "setup" ? "/api/setup" : null),
			accept: setupAccept,
			ok: () => this.push(),
			fail: () => this.push(),
		});
		// W852: the inline seed (window.__SETUP__) is the first good payload —
		// honored before the first poll, so first paint is seeded, never a flash
		const seed = (window as unknown as { __SETUP__?: SetupApiFeed }).__SETUP__;
		if (seed) this.seedSetup(seed);
		this.unsubs = [this.store.subscribe("setup", () => this.push())];
		// ages tick at 1Hz without a fetch; paused with the page
		this.ticker = setInterval(() => {
			if (!document.hidden) this.push();
		}, 1000);
		this.push();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		for (const u of this.unsubs) u();
		this.unsubs = [];
		if (this.ticker !== null) clearInterval(this.ticker);
		this.ticker = null;
	}

	/** Land the inline seed as the feed's first good payload (the old chunk's
	 * setupData = window.__SETUP__ boot). */
	private seedSetup(seed: SetupApiFeed): void {
		const st = this.store.get("setup");
		if (!st || st.loaded) return;
		st.data = seed;
		st.err = null;
		st.okAt = Number(seed.ts) || 1;
		st.loaded = true;
	}

	/** Copy-fix contract: clipboard the command, toast either way. */
	private onFixCopy(e: SetupFixCopyRequestedEvent): void {
		e.stopPropagation();
		void navigator.clipboard.writeText(e.fix).then(
			() => this.toast("copied to clipboard"),
			() => this.toast("copy failed — select the command text"),
		);
	}

	/** The old chunk's toast markup: .toast div into #toasts, 6s TTL. */
	private toast(msg: string): void {
		const host = document.getElementById("toasts");
		if (!host) return;
		const div = document.createElement("div");
		div.className = "toast";
		div.textContent = msg;
		host.appendChild(div);
		setTimeout(() => div.remove(), 6000);
	}

	private visTab(): string {
		const h = (location.hash || "").replace(/^#/, "").split("?")[0];
		return h || "decisions";
	}

	/** Data down: recompute the slice and hand it to the leaf. */
	private push(): void {
		const st = this.store.get("setup");
		const leaf = this.querySelector<KlhSetup>("klh-setup");
		if (!leaf) return;
		leaf.slice = {
			loaded: st?.loaded ?? false,
			err: st?.err ?? null,
			okAt: st?.okAt ?? 0,
			data: (st?.data as SetupApiFeed | null) ?? null,
		};
	}

	protected render() {
		return html`<slot></slot>`;
	}
}

if (!customElements.get("klh-setup-mediator"))
	customElements.define("klh-setup-mediator", KlhSetupMediator);

declare global {
	interface HTMLElementTagNameMap {
		"klh-setup-mediator": KlhSetupMediator;
	}
}
