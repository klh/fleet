// hooks/board-html/klh-hub-admin.ts — W231 hub admin plane: the Lit admin
// surface behind /console/hub. Three panels — tokens (issue/revoke per
// user+machine), provider keys (masked), federation status — fed by
// same-origin /api/hub/* (the board's write cookie rides automatically).
// UI law: Lit + shadow DOM, design tokens, native elements first, klh-tag
// state chips; raw token material is shown exactly once with an explicit
// one-shot warning.
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
// klh-tag.ts self-registers <klh-tag> at import (side effect)
import { tagTone } from "../lib/ui/klh-tag.ts";
interface TokenRow {
	key_id: string;
	actor: string | null;
	team: string | null;
	token_type: string;
	class: "app-role" | "delegated";
	label: string | null;
	scopes: string[];
	expires_at: number | null;
	rotated_at: number | null;
	revoked_at: number | null;
	created_at: number;
	state: string;
}

interface IssuedToken {
	jti: string;
	access: string;
	refresh: string;
	expires_at: number | null;
	refresh_expires_at: number | null;
}

interface ProviderKeyRow {
	name: string;
	source: string;
	set: boolean;
	masked: string | null;
}
interface PeerStatus {
	label: string;
	state: string;
	version: string | null;
	pulled_at: string | null;
	last_known_at: number | null;
	url: string | null;
	via: string | null;
	rules: number | null;
	cr_queue: number | null;
}

const fmtWhen = (ms: number | null): string =>
	ms === null
		? "forever"
		: new Intl.DateTimeFormat("da-DK", {
				day: "2-digit",
				month: "2-digit",
				year: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).format(new Date(ms));

const isoWhen = (s: string | null): string =>
	s === null ? "—" : s.replace("T", " ").slice(0, 19);
class KlhHubAdmin extends LitElement {
	static properties = {
		tokens: { state: true },
		issued: { state: true },
		pkeys: { state: true },
		peers: { state: true },
		fedme: { state: true },
		fedidle: { state: true },
		busy: { state: true },
		err: { state: true },
		tokenFilter: { state: true },
		tokenSearch: { state: true },
		tokenPage: { state: true },
	};

	declare tokens: TokenRow[] | null;
	declare issued: IssuedToken | null;
	declare pkeys: {
		home: string;
		files: string[];
		keys: ProviderKeyRow[];
	} | null;
	declare peers: PeerStatus[] | null;
	declare fedme: string | null;
	declare fedidle: boolean;
	declare busy: boolean;
	declare err: string | null;
	declare tokenFilter: string;
	declare tokenSearch: string;
	declare tokenPage: number;

	constructor() {
		super();
		this.tokens = null;
		this.issued = null;
		this.pkeys = null;
		this.peers = null;
		this.fedme = null;
		this.fedidle = true;
		this.busy = false;
		this.err = null;
		this.tokenFilter = "active";
		this.tokenSearch = "";
		this.tokenPage = 0;
	}
	connectedCallback(): void {
		super.connectedCallback();
		void this.refresh();
	}

	async refresh(): Promise<void> {
		this.busy = true;
		this.err = null;
		try {
			const [t, p, f] = await Promise.all([
				fetch("/api/hub/tokens").then((r) => r.json()),
				fetch("/api/hub/provider-keys").then((r) => r.json()),
				fetch("/api/hub/federation").then((r) => r.json()),
			]);
			this.tokens = t.tokens ?? [];
			this.pkeys =
				p.home !== undefined
					? { home: p.home, files: p.files ?? [], keys: p.keys ?? [] }
					: null;
			this.peers = f.peers ?? null;
			this.fedme = f.me ?? null;
			this.fedidle = f.idle !== false;
		} catch (e) {
			this.err = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy = false;
		}
	}
	async issue(form: HTMLFormElement): Promise<void> {
		const fd = new FormData(form);
		this.busy = true;
		this.err = null;
		try {
			const r = await fetch("/api/hub/tokens", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					actor: fd.get("actor"),
					label: fd.get("label"),
					team: fd.get("team"),
					token_class: fd.get("token_class"),
					scopes: String(fd.get("scopes") ?? "")
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
					access_ttl_days: Number(fd.get("access_ttl_days") ?? 0) || null,
					refresh_ttl_days: Number(fd.get("refresh_ttl_days") ?? 0) || null,
				}),
			});
			const d = await r.json();
			if (!r.ok || !d.ok)
				throw new Error(d.error ?? `HTTP ${String(r.status)}`);
			this.issued = d.token;
			form.reset();
			await this.refresh();
		} catch (e) {
			this.err = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy = false;
		}
	}
	async revoke(actor: string): Promise<void> {
		if (actor.length === 0) return;
		const q = `Revoke ALL token rows for actor "${actor}"? The actor's access dies at once.`;
		if (!window.confirm(q)) return;
		this.busy = true;
		this.err = null;
		try {
			const r = await fetch("/api/hub/tokens/revoke", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ actor }),
			});
			const d = await r.json();
			if (!r.ok || !d.ok)
				throw new Error(d.error ?? `HTTP ${String(r.status)}`);
			await this.refresh();
		} catch (e) {
			this.err = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy = false;
		}
	}
	static styles = [
		css`
		:host {
			display: block;
			max-width: 1000px;
			font: var(--klh-text-lg, 14px)/1.6 var(--klh-font-sans);
			color: var(--klh-ink, #e8e4da);
		}
		h2 {
			font: 600 11px/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
			margin: 18px 0 8px;
		}
		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		th,
		td {
			padding: 4px 8px;
			text-align: left;
			vertical-align: top;
		}
		th {
			font: 600 10px/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
			border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.12));
		}
		td {
			border-bottom: 1px solid var(--klh-edge-faint, rgba(255, 255, 255, 0.06));
		}
	`,

		css`
		.mono {
			font: 11px/1.5 var(--klh-font-mono);
		}
		.dim {
			color: var(--klh-dim, #98958e);
		}
		button {
			font: 600 11px/1.6 var(--klh-font-mono);
			padding: 3px 12px;
			cursor: pointer;
			border-radius: 2px;
			background: var(--klh-bg, #16150f);
			color: var(--klh-ink, #e8e4da);
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
		}
		button.danger {
			color: var(--klh-danger-ink, #c96a4f);
			border-color: var(--klh-danger, #af2f12);
		}
	`,

		css`
		button {
			font: 600 11px/1.6 var(--klh-font-mono);
			padding: 3px 12px;
			cursor: pointer;
			border-radius: 2px;
			background: var(--klh-bg, #16150f);
			color: var(--klh-ink, #e8e4da);
			border: 1px solid var(--klh-edge-strong, rgba(255, 255, 255, 0.24));
		}
		button.danger {
			color: var(--klh-danger-ink, #c96a4f);
			border-color: var(--klh-danger, #af2f12);
		}
		input,
		select {
			font: 12px var(--klh-font-mono);
			padding: 4px 8px;
			border-radius: 2px;
			background: var(--klh-bg, #16150f);
			color: var(--klh-ink, #e8e4da);
			border: 1px solid var(--klh-edge, #8a8577);
		}
		label.k {
			display: block;
			font: 600 10px/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--klh-dim, #98958e);
			margin: 8px 0 2px;
		}
		.token-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 10px; }
		.token-controls label { display:flex; align-items:center; gap:6px; color:var(--klh-dim); font:11px var(--klh-font-mono); }
		.token-controls input { min-width:180px; }
		.token-count { color:var(--klh-dim); font:11px var(--klh-font-mono); }
		.token-pages { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin:8px 0; color:var(--klh-dim); font:11px var(--klh-font-mono); }
		.token-pages button:disabled { opacity:.4; cursor:default; }
		details {
			border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.1));
			border-radius: 3px;
			padding: 8px 12px;
			margin: 0 0 14px;
			background: var(--klh-surface, #23211d);
		}
		summary {
			cursor: pointer;
			font: 600 11px/1.6 var(--klh-font-mono);
			text-transform: uppercase;
			letter-spacing: 0.06em;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
			gap: 0 16px;
		}
		.once {
			border: 1px solid var(--klh-accent, #d8900f);
			background: var(--klh-bg, #16150f);
			border-radius: 2px;
			padding: 8px 10px;
			margin: 8px 0;
		}
		.once code {
			font: 11px/1.5 var(--klh-font-mono);
			word-break: break-all;
		}
		.err {
			border: 1px solid var(--klh-danger, #af2f12);
			color: var(--klh-danger-ink, #c96a4f);
			border-radius: 2px;
			padding: 6px 10px;
			font-size: 12px;
			margin: 8px 0;
		}
		.foot,
		.dim,
		.mono {
			font-size: 11px;
			color: var(--klh-dim, #98958e);
		}
		.mono {
			font-family: var(--klh-font-mono);
		}
	`,
	];
	protected render(): TemplateResult {
		return html`
			<p class="dim intro">
				Tokens, provider keys and federation for this hub — enforcement rides
				the identity layer (scoped, expiring bearer tokens) and every GUI
				mutation lands in the audit trail.
			</p>
			${
				this.err === null
					? nothing
					: html`<div class="err" role="alert">${this.err}</div>`
			}
			${this.renderTokens()} ${this.renderKeys()} ${this.renderFederation()}
		`;
	}
	renderTokens(): TemplateResult {
		const rows = this.tokens ?? [];
		const active = rows.filter((r) => r.state === "active").length;
		const search = this.tokenSearch.trim().toLowerCase();
		const matched = rows.filter(
			(r) =>
				(this.tokenFilter === "all" || r.state === this.tokenFilter) &&
				(!search ||
					[r.key_id, r.actor, r.team, r.label, ...r.scopes]
						.filter(Boolean)
						.join(" ")
						.toLowerCase()
						.includes(search)),
		);
		const pageCount = Math.max(1, Math.ceil(matched.length / 12));
		const page = Math.min(this.tokenPage, pageCount - 1);
		const shown = matched.slice(page * 12, (page + 1) * 12);
		return html`
			<details>
				<summary>Issue a token</summary>
				<form @submit=${this.onIssue}>
					<div class="grid">
						<div>
							<label class="k" for="ha-actor">actor (user or machine)</label>
							<input id="ha-actor" name="actor" required maxlength="120" />
						</div>
						<div>
							<label class="k" for="ha-class">class</label>
							<select id="ha-class" name="token_class">
								<option value="app-role">app-role (machine)</option>
								<option value="delegated">delegated (user)</option>
							</select>
						</div>
						<div>
							<label class="k" for="ha-team">team (optional)</label>
							<input id="ha-team" name="team" maxlength="120" />
						</div>
						<div>
							<label class="k" for="ha-label">label (optional)</label>
							<input id="ha-label" name="label" maxlength="120" />
						</div>
						<div>
							<label class="k" for="ha-scopes">scopes (comma-separated)</label>
							<input id="ha-scopes" name="scopes" value="buckle:admin" />
						</div>
						<div>
							<label class="k" for="ha-at">access ttl days (empty = forever)</label>
							<input id="ha-at" name="access_ttl_days" inputmode="numeric" />
						</div>
						<div>
							<label class="k" for="ha-rt">refresh ttl days (empty = forever)</label>
							<input id="ha-rt" name="refresh_ttl_days" inputmode="numeric" />
						</div>
					</div>
					<p><button type="submit" ?disabled=${this.busy}>Issue token</button></p>
				</form>
			</details>
			${this.issued === null ? nothing : this.renderIssued()}
			<h2>Tokens</h2>
			<div class="token-controls">
				<label>state
					<select aria-label="token state" .value=${this.tokenFilter} @change=${(
						e: Event,
					) => {
						this.tokenFilter = (e.target as HTMLSelectElement).value;
						this.tokenPage = 0;
					}}>
						<option value="active">active</option><option value="revoked">revoked</option><option value="expired">expired</option><option value="rotated">rotated</option><option value="all">all</option>
					</select>
				</label>
				<label>find
					<input type="search" aria-label="find token" placeholder="actor, team, scope, ID" .value=${this.tokenSearch} @input=${(
						e: Event,
					) => {
						this.tokenSearch = (e.target as HTMLInputElement).value;
						this.tokenPage = 0;
					}} />
				</label>
				<span class="token-count">${active} active · ${rows.length - active} inactive · ${matched.length ? page * 12 + 1 : 0}–${page * 12 + shown.length} of ${matched.length}</span>
			</div>
			<table>
				<thead>
					<tr>
						<th>token</th>
						<th>actor</th>
						<th>class</th>
						<th>team</th>
						<th>scopes</th>
						<th>expires</th>
						<th>state</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					${
						shown.length === 0
							? html`<tr><td colspan="8" class="dim">${rows.length ? "no tokens match this view" : "no tokens yet"}</td></tr>`
							: shown.map((r) => this.tokenRow(r))
					}
				</tbody>
			</table>
			${
				pageCount > 1
					? html`<nav class="token-pages" aria-label="Token pages">
				<button type="button" ?disabled=${page === 0} @click=${() => {
					this.tokenPage = page - 1;
				}}>Previous</button>
				<span>Page ${page + 1} of ${pageCount}</span>
				<button type="button" ?disabled=${page + 1 >= pageCount} @click=${() => {
					this.tokenPage = page + 1;
				}}>Next</button>
			</nav>`
					: nothing
			}
			<p class="foot">
				Listing is masked (8-char id, no material). Every issue/revoke lands
				in the console audit trail (governor.db).
			</p>
		`;
	}
	tokenRow(r: TokenRow): TemplateResult {
		const active = r.state === "active";
		return html`
			<tr>
				<td class="mono">${r.key_id}</td>
				<td>${r.actor ?? "—"}</td>
				<td>${r.class === "delegated" ? "user" : "machine"}</td>
				<td>${r.team ?? "—"}</td>
				<td class="mono">${r.scopes.join(", ")}</td>
				<td class="mono" title=${r.expires_at === null ? "" : new Date(r.expires_at).toISOString()}>${fmtWhen(r.expires_at)}</td>
				<td>
					<klh-tag
						tone=${tagTone(active ? "ok" : r.state === "revoked" ? "bad" : "dim")}
						>${r.state}</klh-tag
					>
				</td>
				<td>
					${
						active
							? html`<button
								class="danger"
								@click=${() => this.revoke(r.actor ?? "")}
							>revoke actor</button>`
							: nothing
					}
				</td>
			</tr>
		`;
	}

	renderIssued(): TemplateResult {
		const t = this.issued;
		if (t === null) return nothing;
		return html`
			<div class="once" role="status">
				<p><strong>Token minted — shown once, copy now.</strong></p>
				<p class="mono">access: <code>${t.access}</code></p>
				<p class="mono">refresh: <code>${t.refresh}</code></p>
				<p class="foot">
					jti ${t.jti} · access ${fmtWhen(t.expires_at)} · refresh
					${fmtWhen(t.refresh_expires_at)}
				</p>
			</div>
		`;
	}
	renderKeys(): TemplateResult {
		const p = this.pkeys;
		return html`
			<h2>Provider keys (masked)</h2>
			${
				p === null
					? html`<p class="dim">loading…</p>`
					: html`
						<table>
							<thead>
								<tr><th>env name</th><th>source</th><th>value</th></tr>
							</thead>
							<tbody>
								${
									p.keys.length === 0
										? html`<tr><td colspan="3" class="dim">no provider keys found</td></tr>`
										: p.keys.map(
												(k) => html`<tr>
												<td class="mono">${k.name}</td>
												<td>${k.source}</td>
												<td class="mono">${k.masked ?? "—"}</td>
											</tr>`,
											)
								}
							</tbody>
						</table>
						<p class="foot">sources: ${p.home} · ${p.files.join(", ")}</p>
					`
			}
		`;
	}
	renderFederation(): TemplateResult {
		const peers = this.peers ?? [];
		return html`
			<h2>Federation</h2>
			${
				this.fedidle
					? html`<p class="dim">
						no peer edges declared (HUB_PEERS / stack.json hubs.&lt;me&gt;.peers)
						— idle
					</p>`
					: html`
						<table>
							<thead>
								<tr>
									<th>peer</th><th>state</th><th>policy version</th>
									<th>last pull</th><th>via</th>
								</tr>
							</thead>
							<tbody>
								${peers.map(
									(p) => html`<tr>
										<td>${p.label}</td>
										<td>
											<klh-tag
												tone=${tagTone(p.state === "live" ? "ok" : p.state === "stale" ? "warn" : "bad")}
												>${p.state}</klh-tag
											>
										</td>
										<td class="mono">${p.version ?? "—"}</td>
										<td class="mono">${isoWhen(p.pulled_at)}</td>
										<td class="dim mono">${p.via ?? "—"}</td>
									</tr>`,
								)}
							</tbody>
						</table>
					`
			}
			<p class="foot">
				Peer edges propagate the hub policy manifest peer-to-peer; last-known
				stays in force when a peer degrades.
			</p>
		`;
	}

	onIssue(e: Event): void {
		e.preventDefault();
		void this.issue(e.target as HTMLFormElement);
	}
}

customElements.define("klh-hub-admin", KlhHubAdmin);
