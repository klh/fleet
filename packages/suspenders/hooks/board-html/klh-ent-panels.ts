// hooks/board-html/klh-ent-panels.ts — W775.1: the enterprise panel
// family. Seven panels over the ent-seam slices (Identity Governance,
// Federation Topology, Audit & Compliance, Usage & Quotas, Policy
// Manifest, Secrets Vault, M&A Operations), each a KlhEntPanel subclass
// pinning its spec and rendering its typed rows with the shared helpers
// (chip/when). Honest empty-states: a failed slice (ok:false) renders the
// provider's why + the pending-wiring note from the base chrome.
import { html, type TemplateResult } from "lit";
import type {
	AuditSlice,
	IdentitySlice,
	FederationSlice,
	UsageSlice,
	PolicySlice,
	VaultSlice,
	MaSlice,
} from "../board/ent-seam.ts";
import { KlhEntPanel, chip, when, fmtTok } from "./klh-ent-base.ts";

/** Identity Governance — users, roles, contractor/employee tags, MFA
 *  posture (entitlements + OIDC). */
class KlhEntIdentity extends KlhEntPanel {
	constructor() {
		super();
		this.spec = { title: "Identity Governance", glyph: "◇" };
	}

	protected override count(): number | null {
		return this.sliceOf<IdentitySlice>().users.length;
	}

	protected override body(): TemplateResult | null {
		const s = this.sliceOf<IdentitySlice>();
		if (s === null) return null;
		return html`
			<table>
				<thead>
					<tr><th>user</th><th>roles</th><th>mfa</th><th>entitled</th></tr>
				</thead>
				<tbody>
					${s.users.map((u) => {
						const mfaTone = u.mfa === "enforced" ? "ok" : u.mfa === "off" ? "bad" : "muted";
						return html`
							<tr>
								<td>
									${u.label}
									${chip(u.kind === "contractor" ? "ent" : "muted", u.kind)}
								</td>
								<td>${u.roles.length === 0 ? "—" : u.roles.join(", ")}</td>
								<td>${chip(mfaTone, u.mfa)}</td>
								<td>${chip(u.entitled ? "ok" : "muted", u.entitled ? "yes" : "no")}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
			${s.roles.length === 0
				? ""
				: html`<div class="state">
						roles:
						${s.roles.map((r) => `${r.id}(${r.members})`).join(" · ")}
					</div>`}
		`;
	}
}

if (!customElements.get("klh-ent-identity"))
	customElements.define("klh-ent-identity", KlhEntIdentity);

/** Federation Topology — peers, spoke health, residency region
 *  (route_audit + spoke enrollment). */
class KlhEntFederation extends KlhEntPanel {
	constructor() {
		super();
		this.spec = { title: "Federation Topology", glyph: "◈" };
	}

	protected override count(): number | null {
		return this.sliceOf<FederationSlice>()?.peers.length ?? null;
	}

	protected override body(): TemplateResult | null {
		const s = this.sliceOf<FederationSlice>();
		if (s === null) return null;
		return html`
			<table>
				<thead>
					<tr><th>spoke</th><th>state</th><th>region</th><th>seen</th></tr>
				</thead>
				<tbody>
					${s.peers.map((p) => {
						const tone =
							p.state === "enrolled" ? "ok" : p.state === "stale" ? "bad" : "muted";
						return html`
							<tr>
								<td>${p.spoke_id}</td>
								<td>${chip(tone, p.state)}</td>
								<td>${p.region ?? "—"}</td>
								<td>${when(p.last_seen)}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
		`;
	}
}

if (!customElements.get("klh-ent-federation"))
	customElements.define("klh-ent-federation", KlhEntFederation);

/** Audit & Compliance — events + admin_audit (policy changes, key
 *  rotations, failed auth, consent flags). */
class KlhEntAudit extends KlhEntPanel {
	constructor() {
		super();
		this.spec = { title: "Audit & Compliance", glyph: "≡" };
	}

	protected override count(): number | null {
		return this.sliceOf<AuditSlice>()?.entries.length ?? null;
	}

	protected override body(): TemplateResult | null {
		const s = this.sliceOf<AuditSlice>();
		if (s === null) return null;
		return html`
			<table>
				<thead>
					<tr><th>when</th><th>actor</th><th>action</th><th>outcome</th></tr>
				</thead>
				<tbody>
					${s.entries.map((e) => {
						const tone = e.outcome === "ok" ? "ok" : "bad";
						return html`
							<tr>
								<td>${when(e.ts)}</td>
								<td>${e.actor}</td>
								<td>${e.action} → ${e.target}</td>
								<td>${chip(tone, e.outcome)}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
		`;
	}
}

if (!customElements.get("klh-ent-audit"))
	customElements.define("klh-ent-audit", KlhEntAudit);

/** Usage & Quotas — per-department spend vs caps, anomalies (usage
 *  ingest + teams/ceilings). */
class KlhEntUsage extends KlhEntPanel {
	constructor() {
		super();
		this.spec = { title: "Usage & Quotas", glyph: "▤" };
	}

	protected override count(): number | null {
		return this.sliceOf<UsageSlice>()?.departments.length ?? null;
	}

	protected override body(): TemplateResult | null {
		const s = this.sliceOf<UsageSlice>();
		if (s === null) return null;
		return html`
			<table>
				<thead>
					<tr><th>department</th><th>spend/cap</th><th>anomaly</th></tr>
				</thead>
				<tbody>
					${s.departments.map((d) => {
						const pct =
							d.cap_tok === null || d.cap_tok === 0
								? null
								: Math.round((d.spend_tok / d.cap_tok) * 100);
						return html`
							<tr>
								<td>${d.label}</td>
								<td>
									${fmtTok(d.spend_tok)}
									${d.cap_tok === null ? "" : ` / ${fmtTok(d.cap_tok)}`}
									${pct === null ? "" : ` (${pct}%)`}
								</td>
								<td>${chip(d.anomaly ? "bad" : "ok", d.anomaly ? "flag" : "clear")}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
		`;
	}
}

if (!customElements.get("klh-ent-usage"))
	customElements.define("klh-ent-usage", KlhEntUsage);

/** Policy Manifest — active versions, rollout, signed integrity,
 *  overrides (policy manifest + CR queue). */
class KlhEntPolicy extends KlhEntPanel {
	constructor() {
		super();
		this.spec = { title: "Policy Manifest", glyph: "§" };
	}

	protected override count(): number | null {
		return this.sliceOf<PolicySlice>()?.versions.length ?? null;
	}

	protected override body(): TemplateResult | null {
		const s = this.sliceOf<PolicySlice>();
		if (s === null) return null;
		return html`
			<div class="state">
				CR queue: ${s.cr_queue} · overrides: ${s.overrides.length}
			</div>
			<table>
				<thead>
					<tr><th>version</th><th>rollout</th><th>signed</th><th>pinned</th></tr>
				</thead>
				<tbody>
					${s.versions.map((v) => {
						const tone = v.rollout === "active" ? "ok" : v.rollout === "canary" ? "ent" : "muted";
						return html`
							<tr>
								<td>${v.version}</td>
								<td>${chip(tone, v.rollout)}</td>
								<td>${chip(v.signed ? "ok" : "bad", v.signed ? "yes" : "no")}</td>
								<td>${v.pinned_by === null ? "—" : String(v.pinned_by)}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
		`;
	}
}

if (!customElements.get("klh-ent-policy"))
	customElements.define("klh-ent-policy", KlhEntPolicy);

/** Secrets Vault — rotation schedules, freshness, access patterns
 *  (KV/vault). */
class KlhEntVault extends KlhEntPanel {
	constructor() {
		super();
		this.spec = { title: "Secrets Vault", glyph: "⛨" };
	}

	protected override count(): number | null {
		return this.sliceOf<VaultSlice>()?.secrets.length ?? null;
	}

	protected override body(): TemplateResult | null {
		const s = this.sliceOf<VaultSlice>();
		if (s === null) return null;
		return html`
			<table>
				<thead>
					<tr><th>secret</th><th>age</th><th>next rotation</th><th>24h access</th></tr>
				</thead>
				<tbody>
					${s.secrets.map((v) => {
						const tone = v.age_days === null || v.age_days > 90 ? "bad" : "ok";
						return html`
							<tr>
								<td>${v.name}</td>
								<td>${chip(tone, v.age_days === null ? "never" : `${v.age_days}d`)}</td>
								<td>${when(v.next_rotation)}</td>
								<td>${String(v.accesses_24h)}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
		`;
	}
}

if (!customElements.get("klh-ent-vault"))
	customElements.define("klh-ent-vault", KlhEntVault);

/** M&A Operations — department transfers, revocation lists (entitlements
 *  + ledger). */
class KlhEntMa extends KlhEntPanel {
	constructor() {
		super();
		this.spec = { title: "M&A Operations", glyph: "⇄" };
	}

	protected override count(): number | null {
		const s = this.sliceOf<MaSlice>();
		if (s === null) return null;
		return s.transfers.length + s.revocations.length;
	}

	protected override body(): TemplateResult | null {
		const s = this.sliceOf<MaSlice>();
		if (s === null) return null;
		return html`
			<table>
				<thead>
					<tr><th>when</th><th>dept</th><th>spoke</th><th>outcome</th></tr>
				</thead>
				<tbody>
					${s.transfers.map((t) => {
						const tone = t.outcome === "done" ? "ok" : t.outcome === "pending" ? "ent" : "bad";
						return html`
							<tr>
								<td>${when(t.ts)}</td>
								<td>${t.dept}</td>
								<td>${t.spoke_id}</td>
								<td>${chip(tone, t.outcome)}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
			${s.revocations.length === 0
				? ""
				: html`<div class="state">
						revoked:
						${s.revocations.map((r) => `${r.id} (${r.dept})`).join(", ")}
					</div>`}
		`;
	}
}

if (!customElements.get("klh-ent-ma"))
	customElements.define("klh-ent-ma", KlhEntMa);
