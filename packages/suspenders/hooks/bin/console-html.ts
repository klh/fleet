// hooks/bin/console-html.ts — W147: the console shell + server-rendered
// console pages (belt gateway view, local services view, settings). Pure
// string builders on the klh theme tokens (hooks/lib/theme.ts — var(--klh-*),
// dark/light via data-theme), inline SVG, no framework, no external deps.
//
// W658.2: the top bar retired into the klh-topbar Lit component
// (board-html/klh-topbar.ts → /vendor/klh-topbar.js): pages compose
// theme.ts fleetNav() + <klh-topbar> — server pages pass `me` as a JSON
// attribute, the component fetches /api/console/me when absent; page links
// slot into the settings panel via slot="settings-extra". topbar() and
// TOPBAR_JS (incl. its cavload fill) are gone; the avatar dropdown, theme
// radios and actor select live in the component's shadow DOM.
//
// Settings flow (config-over-code, never a code edit): form →
// /console/settings/preview (validate + diff) → confirm form →
// /console/settings/apply (mtime guard + atomic write). Invalid config is
// rejected with the parser's own error, verbatim.
import type {
	BoardSettingsState,
	PolicyGatewayParsed,
	ResolvedPolicy,
} from "../lib/board-config.ts";
import type { AdminAuditRow } from "../lib/admin-audit.ts";
import { scrub } from "../lib/servicemon.ts";
import {
	matchingRegistrations,
	registrationPort,
} from "../lib/service-inventory.ts";
import {
	FLEET_NAV_CSS,
	fleetNav,
	displayLabel,
	THEME_HEAD,
} from "../lib/theme.ts";
import type { RecoveryEntry } from "../lib/recovery-map.ts";
// W858.10.3: the Network overview payload (type-only — erased at runtime;
// the card component owns the DOM)
import type { NetworkPayload } from "../board/network-overview.ts";
// W669.11: the console data cards ride klh-console-cards (UI law) — pages
// emit static card hosts + esc(JSON) data attributes (klh-service-row
// pattern); the components render shadow DOM from the slices.
import type {
	AuditRow,
	AuditListData,
	PolicyCardData,
	RegistryCardData,
	RegistryRow,
	UpstreamsCardData,
	KnobsCardData,
} from "../board-html/klh-console-cards.ts";
import type { ExecutorEntry } from "../board/executor-catalog.ts";
import { withRecovery, type ServiceProbe } from "../board/service-probe.ts";

export interface ConsoleMe {
	actor: string;
	tags: Record<string, string>;
	actors: string[];
	defaultActor: string;
}

// ─── shared chrome ────────────────────────────────────────────────────────
export const esc = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

// ─── top bar retired (W658.2) ─────────────────────────────────────────────
// topbar()/TOPBAR_JS moved to board-html/klh-topbar.ts — pages compose
// fleetNav() + <klh-topbar>; the avatar dropdown, settings gear and the
// /api/console/me fetch live in the component.

// ─── page shell ───────────────────────────────────────────────────────────
// klh-topbar data: server pages pass `me` as a JSON attribute (esc()'d like
// klh-service-row's probe attr); absent → the component fetches
// /api/console/me itself (board SPA, /usage).
const meAttr = (me?: ConsoleMe): string =>
	me ? ` me="${esc(JSON.stringify(me))}"` : "";

// the page's settings-panel link (aria-current when the page IS settings)
const settingsExtra = (active: string): string =>
	`<a slot="settings-extra" href="/console/settings"${active === "settings" ? ' aria-current="page"' : ""}>all console settings &rarr;</a>`;

export const consolePage = (
	title: string,
	active: "belt" | "suspenders" | "local" | "settings" | "hub" | "",
	body: string,
	me?: ConsoleMe,
): string =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${THEME_HEAD}<style>body{background:var(--klh-bg);color:var(--klh-ink);font:var(--klh-text-lg)/1.6 var(--klh-font-sans);margin:0;padding:0 20px 28px;}a{color:var(--klh-accent)}.ptitle{font-size:28px;letter-spacing:0;margin:28px 0 20px;color:var(--klh-ink)}.panel{background:var(--klh-surface);border:1px solid var(--klh-edge-soft);border-radius:3px;padding:12px 14px;margin:0 0 14px}.panel h2{margin:0 0 8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--klh-dim)}.dim{color:var(--klh-dim)}.ok{color:var(--klh-ok)}.bad{color:var(--klh-danger-ink)}table.ct{width:100%;border-collapse:collapse;font-size:12px}table.ct td,table.ct th{padding:5px 8px;border-bottom:1px solid var(--klh-rule);text-align:left}table.ct th{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--klh-dim)}.num{font-variant-numeric:tabular-nums}.btn{background:var(--klh-accent);color:var(--klh-on-accent);border:1px solid var(--klh-accent);border-radius:2px;padding:5px 14px;font:inherit;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;cursor:pointer}.btn2{background:var(--klh-bg);color:var(--klh-ink);border:1px solid var(--klh-edge-strong);border-radius:2px;padding:5px 12px;font:inherit;font-size:11px;cursor:pointer;text-decoration:none;display:inline-block}input,select,textarea{background:var(--klh-bg);color:var(--klh-ink);border:1px solid var(--klh-edge);border-radius:2px;padding:5px 8px;font:12px var(--klh-font-mono)}label.k{display:block;font-size:10px;color:var(--klh-dim);text-transform:uppercase;letter-spacing:.06em;margin:8px 0 3px}input.wide{width:100%}.flash{border:1px solid var(--klh-ok);color:var(--klh-ok-hi);background:var(--klh-ok-bg);border-radius:2px;padding:7px 10px;font-size:12px;margin:0 0 14px}.errbox{border:1px solid var(--klh-danger);color:var(--klh-danger-ink);background:var(--klh-danger-bg);border-radius:2px;padding:7px 10px;font-size:12px;margin:0 0 14px;white-space:pre-wrap;word-break:break-word}pre.diff{background:var(--klh-bg);border:1px solid var(--klh-edge);border-radius:2px;padding:10px 12px;font:11px/1.5 var(--klh-font-mono);overflow:auto}pre.diff .add{color:var(--klh-ok-hi);display:block}pre.diff .del{color:var(--klh-danger-ink);display:block}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}@media (max-width:700px){.formgrid{grid-template-columns:1fr}}.cfoot{font-size:10.5px;color:var(--klh-dim);margin-top:4px}${FLEET_NAV_CSS}</style></head><body>${fleetNav("suspenders", active)}<klh-topbar${meAttr(me)}>${settingsExtra(active)}</klh-topbar><main style="max-width:1400px;margin:0 auto"><h1 class="ptitle">${esc(title)}</h1>${body}<div class="cfoot">klh console · part of the suspenders fleet board</div></main><script type="module" src="/vendor/klh-topbar.js"></script></body></html>`;

// ─── belt gateway view (/console/belt) ────────────────────────────────────
// W273: a probe row carries its recovery-map entry (null = unmapped)
export type HealthProbe = ServiceProbe & { recovery: RecoveryEntry | null };

export interface UpstreamGroup {
	name: string;
	tiers: number;
	dormant: boolean;
	source?: string;
}

export interface BeltView {
	policy: ResolvedPolicy | null;
	gateway: PolicyGatewayParsed | null;
	policyError: string | null;
	beltApi: { url: string; via: string } | null;
	health: HealthProbe[];
	groups: UpstreamGroup[] | null;
	upstreamSource?: string;
	/** W858.10.3: the /api/console/network payload — SSR seed for the
	 *  Network overview card; the card re-fetches live every 10s. */
	network: NetworkPayload | null;
}

// W669.11: the belt policy card's display slice — four states, rendered by
// <klh-policy-card> from the esc(JSON) data attribute (UI law: the server
// never builds the card DOM).
const beltPolicySlice = (v: BeltView): PolicyCardData => {
	if (!v.policy) return { kind: "missing" };
	if (v.policyError)
		return {
			kind: "error",
			path: scrub(v.policy.path),
			error: v.policyError,
		};
	if (!v.gateway) return { kind: "no-gateway" };
	return {
		kind: "policy",
		path: scrub(v.policy.path),
		source: v.policy.source,
		gateway: v.gateway,
	};
};

// settings-index variant: PolicyCur folds "no gateway section" into a
// gateway-null policy slice (the card shows the heading + shared-file foot)
const indexPolicySlice = (pol: PolicyCur): PolicyCardData => {
	if (pol.error)
		return { kind: "error", path: scrub(pol.path), error: pol.error };
	return {
		kind: "policy",
		path: scrub(pol.path),
		source: pol.source,
		gateway: pol.gateway,
	};
};

// W273: one <klh-service-row> per monitored service. The Lit component
// renders from the probe JSON attribute; the light-DOM children are the
// no-JS fallback (shadow DOM hides them once the component upgrades) —
// recovery commands are readable even if the module never loads.
const stateOf = (p: HealthProbe): string => p.state ?? (p.up ? "up" : "down");

const fallbackRecovery = (p: HealthProbe): string => {
	const r = p.recovery;
	if (!r || stateOf(p) === "up" || stateOf(p) === "idle") return "";
	return `<details${stateOf(p) === "down" ? " open" : ""}><summary>how to recover</summary><p>${esc(r.what)}</p><ul>${r.causes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul><ol>${r.recovery.map((s) => `<li><span class="dim">${esc(s.label)}</span><pre class="rcmd"><code>${esc(s.cmd)}</code></pre></li>`).join("")}</ol></details>`;
};

export const serviceRowHtml = (p: HealthProbe): string => {
	const st = stateOf(p);
	const cls = st === "idle" ? "dim" : st === "up" ? "ok" : "bad";
	const where = p.port ? ` :${p.port}` : "";
	return `<klh-service-row data-state="${st}" data-service="${esc(p.id)}" probe="${esc(JSON.stringify(p))}"><div class="srow"><span class="${cls}">${st.toUpperCase()}</span> <b>${esc(displayLabel(p.name))}</b><span class="dim">${where} · ${esc(p.detail)}</span></div>${fallbackRecovery(p)}</klh-service-row>`;
};

const healthHtml = (h: HealthProbe[], title = "Fleet services"): string => {
	const dark = h.filter(
		(p) => stateOf(p) !== "up" && stateOf(p) !== "idle",
	).length;
	const idle = h.filter((p) => stateOf(p) === "idle").length;
	return `<div class="panel"><h2>${esc(title)} · ${h.length - dark - idle}/${h.length} up${idle ? ` · ${idle} on demand` : ""}${dark ? ` · ${dark} need recovery` : ""}</h2>${h.map(serviceRowHtml).join("")}</div><script type="module" src="/vendor/klh-service-row.js"></script>`;
};

const PILL_CSS = `.tiles{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px}.tile{flex:1 1 180px;background:var(--klh-surface);border:1px solid var(--klh-edge-soft);border-radius:3px;padding:10px 14px}.tnum{font-size:16px;font-weight:600}.tkey{font-size:10px;color:var(--klh-dim);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}.tsub{font-size:10.5px;color:var(--klh-dim);margin-top:3px}.srow{padding:4px 0}.rcmd{margin:2px 0 6px;background:var(--klh-surface);border:1px solid var(--klh-edge);border-radius:2px;padding:4px 8px;font:11px/1.5 var(--klh-font-mono);white-space:pre-wrap}.pill{display:inline-block;border:1px solid var(--klh-edge);border-radius:2px;padding:1px 7px;font-size:11px;color:var(--klh-ink-2);margin:1px 3px 1px 0}`;

// ─── belt page body ───────────────────────────────────────────────────────
// the policy card host (heading + slice ride the esc(JSON) data attribute)
const policyCard = (v: BeltView): string =>
	`<klh-policy-card heading="Routing policy" data="${esc(JSON.stringify(beltPolicySlice(v)))}"></klh-policy-card>`;

const upstreamsCard = (v: BeltView): string =>
	`<klh-upstreams-card data="${esc(JSON.stringify(upstreamsSlice(v)))}"></klh-upstreams-card>`;

// the card slice for the belt view's configured upstream pool (null groups
// = unreadable upstreams.yaml — the card shows the fallback dimpl)
const upstreamsSlice = (v: BeltView): UpstreamsCardData => ({
	source: v.upstreamSource ?? "configuration",
	groups: v.groups
		? v.groups.map((g) => ({
				name: g.name,
				tiers: g.tiers,
				dormant: g.dormant,
				source: g.source ?? "configured",
			}))
		: null,
});

const PAGE_CSS = `.knobs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}.kchip{border:1px solid var(--klh-edge);border-radius:2px;padding:2px 8px;font-size:11.5px;color:var(--klh-ink-2)}.kchip b{color:var(--klh-ink)}.dimpl{color:var(--klh-dim);font-size:12px}.btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}`;
const INVENTORY_CSS = `.consoleInventory{background:var(--klh-surface);border:1px solid var(--klh-edge-soft);border-radius:3px;margin:0 0 14px;padding:10px 14px}.consoleInventory>summary{cursor:pointer;color:var(--klh-ink);font-size:12px;font-weight:600}.consoleInventory>summary:focus-visible{outline:2px solid var(--klh-accent);outline-offset:2px}.consoleInventory[open]>summary{margin-bottom:12px}`;

// W669.11: the console cards bundle — every page emitting a klh-*-card host
// loads it; the components upgrade the hosts from their data attributes
const CARDS_SCRIPT = `<script type="module" src="/vendor/klh-console-cards.js"></script>`;
// W695.3.2: the settings form widgets (executor editor, diff view) bundle
const FORMS_SCRIPT = `<script type="module" src="/vendor/klh-console-forms.js"></script>`;

export const beltPage = (v: BeltView, me?: ConsoleMe): string => {
	const body =
		`<style>${PILL_CSS}${PAGE_CSS}${INVENTORY_CSS}</style>` +
		`<p class="dimpl">Request routing, provider fallback and governed model access.</p>` +
		(v.network
			? `<klh-network-card heading="Network overview" data="${esc(JSON.stringify(v.network))}"></klh-network-card>`
			: "") +
		healthHtml(
			v.health.filter((p) =>
				["belt-gateway-4000", "litellm-4100", "buckle-4101"].includes(p.id),
			),
			"Gateway transports",
		) +
		`<details class="consoleInventory"><summary>Routing configuration · ${v.groups?.length ?? 0} model groups</summary>` +
		policyCard(v) +
		upstreamsCard(v) +
		`</details>` +
		(v.beltApi
			? `<div class="panel"><h2>belt API</h2><p>reachable at <span class="mono">${esc(scrub(v.beltApi.url))}</span> <span class="dim">(via ${esc(v.beltApi.via)})</span></p><p class="cfoot">read-only view in this item — routing edits live on the settings page</p></div>`
			: `<div class="panel"><h2>belt API</h2><p class="dimpl">belt API not reachable (env → belt.json → belt.local chain) — gateway health above is probed directly</p></div>`) +
		CARDS_SCRIPT;
	return consolePage("Belt gateway", "belt", body, me);
};

// ─── local services view (/console/local) — static registry first ─────────
export interface LocalService {
	name: string;
	port: number;
	created: string;
	upstream?: string;
}

export interface LocalView {
	services: LocalService[];
	regPath: string;
	error: string | null;
	probes: ServiceProbe[];
	source: "registry" | "probes+registry" | "probes";
}

export const localPage = (v: LocalView, me?: ConsoleMe): string => {
	const upCount = v.probes.filter((p) => p.up).length;
	const idleCount = v.probes.filter((p) => p.state === "idle").length;
	const probeRows = v.probes
		.map((p) => {
			const registrations = matchingRegistrations(p.port, v.services);
			return (
				serviceRowHtml(withRecovery(p)) +
				registrations
					.map(
						(s) =>
							`<p class="cfoot">Registered as <a href="https://${esc(s.name)}.local/">${esc(s.name)}.local</a> · since ${esc(s.created.slice(0, 10))}</p>`,
					)
					.join("")
			);
		})
		.join("");
	// the registry card's slice (scope = route kind; monitored = the local
	// probe cross-check) — the card owns the table DOM
	const registryRows: RegistryRow[] = v.services.map((s) => ({
		name: s.name,
		scope: registrationPort(s) === null ? "Remote upstream" : "Local upstream",
		upstream: s.upstream ?? String(s.port),
		monitored: v.probes.some((p) => registrationPort(s) === p.port)
			? "Monitored below"
			: "Not monitored here",
	}));
	const registryData: RegistryCardData = { rows: registryRows };
	const body =
		`<style>${PAGE_CSS}${PILL_CSS}${INVENTORY_CSS}</style><p class="dimpl">Registered .local routes, local model capacity and process observations.</p>` +
		(v.error ? `<div class="errbox">${esc(v.error)}</div>` : "") +
		`<div class="panel"><h2>Local machine · ${upCount}/${v.probes.length} up${idleCount ? ` · ${idleCount} on demand` : ""}</h2>${probeRows || '<p class="dimpl">No monitored services</p>'}<p class="cfoot">${esc(v.source)} · ${esc(scrub(v.regPath))}</p></div><script type="module" src="/vendor/klh-service-row.js"></script>` +
		`<details class="consoleInventory"><summary>Registered .local routes · ${v.services.length}</summary>` +
		`<klh-registry-card heading="Registered services · ${v.services.length}" data="${esc(JSON.stringify(registryData))}"></klh-registry-card></details>` +
		CARDS_SCRIPT;

	return consolePage("Local services", "local", body, me);
};

// ─── settings (/console/settings) — one entry per feature ─────────────────
export type Feature = "belt" | "buckle" | "suspenders";

export interface PolicyCur {
	path: string;
	source: string;
	gateway: PolicyGatewayParsed | null;
	error: string | null;
}

// ─── settings form pages ──────────────────────────────────────────────────
export interface FormCur {
	gateway: PolicyGatewayParsed | null;
	polError: string | null;
	target: string;
	set: BoardSettingsState;
	// W183.2 — the suspenders form's add-picker rides the merged catalog
	executors?: ExecutorEntry[];
}

const numField = (
	label: string,
	name: string,
	val: number | undefined,
	hint: string,
): string =>
	`<div><label class="k" for="f_${name}">${label}</label><input id="f_${name}" name="${name}" type="number" step="1" min="0" value="${val ?? ""}"><div class="cfoot">${hint}</div></div>`;

const textField = (
	label: string,
	name: string,
	val: string,
	hint: string,
): string =>
	`<div><label class="k" for="f_${name}">${label}</label><input class="wide" id="f_${name}" name="${name}" type="text" value="${esc(val)}"><div class="cfoot">${hint}</div></div>`;

const FORM_CSS = `.cfield-hint{font-size:10.5px;color:var(--klh-dim);margin:2px 0 8px}`;

const ladderFields = (gw: PolicyGatewayParsed): string =>
	Object.entries(gw.fallbacks)
		.map(
			([m, tiers]) =>
				`<label class="k" for="l_${esc(m)}">ladder · ${esc(m)} (comma-separated, order = priority)</label><input class="wide" id="l_${esc(m)}" name="ladder_${esc(m)}" value="${esc(tiers.join(", "))}"><div class="cfield-hint">tiers listed are ON; removing a tier switches it off (flashx is refused outright)</div>`,
		)
		.join("");

const formFoot = `<p class="cfoot">Writes are config-over-code. belt+buckle share the policy file: belt activates at the next gateway-config emit + launchctl kickstart (between fan-outs — a reload drops in-flight streams); buckle loads the policy at boot.</p>`;

const formFrame = (
	title: string,
	head: string,
	form: string,
	me?: ConsoleMe,
): string =>
	consolePage(
		title,
		"settings",
		`<style>${FORM_CSS}</style>${head}<form method="post" action="/console/settings/preview">${form}<div class="btnrow"><button class="btn" type="submit">preview diff</button><a class="btn2" href="/console/settings">cancel</a></div></form>${formFoot}`,
		me,
	);

const HIDDEN_FEATURE = (f: Feature): string =>
	`<input type="hidden" name="feature" value="${f}">`;

// W695.3.2 — the executor-preference editor rides <klh-executor-editor>
// (board-html/klh-console-forms.ts); see executorPrefsEditor below.

const executorPrefsEditor = (
	executors: ExecutorEntry[],
	current: string[],
): string => {
	const opts = Array.from(
		new Map(
			executors.map((e) => [
				e.value,
				{
					value: e.value,
					label: e.label,
					group:
						e.plane === "local"
							? "This Mac"
							: e.plane === "user"
								? "Personal models"
								: e.plane === "hub"
									? "Hubs"
									: e.value.startsWith("llm:")
										? "Remote models"
										: "Agent clients",
				},
			]),
		).values(),
	);
	return `<klh-executor-editor options="${esc(JSON.stringify(opts))}"><input type="hidden" name="default_executors" value="${esc(current.join(","))}"></klh-executor-editor>${FORMS_SCRIPT}`;
};

export const settingsFormPage = (
	feature: Feature,
	cur: FormCur,
	me?: ConsoleMe,
): string => {
	const head = `<p class="dimpl">Target file: <span class="mono">${esc(cur.target)}</span>. Every write previews a diff and needs an explicit confirm.</p>`;
	if (feature === "suspenders") {
		const s = cur.set.settings;
		const body =
			`<div class="panel"><h2>board knobs · suspenders-board.json</h2>` +
			(cur.set.error
				? `<div class="errbox">current file does not parse: ${esc(cur.set.error)}</div>`
				: "") +
			`<div class="formgrid">` +
			numField(
				"STATUS_REFRESH_S",
				"status_refresh_s",
				s.status_refresh_s,
				"servicemon /status TTL seconds; 0 = always fresh; file beats env at board start",
			) +
			numField(
				"harvest TTL (s)",
				"harvest_ttl_s",
				s.harvest_ttl_s,
				"usage harvest runs at most once per this many seconds (maybeHarvest default TTL)",
			) +
			`</div>` +
			textField(
				"default actor (demo switch preselect)",
				"default_actor",
				s.default_actor ?? "",
				"preselects the avatar dropdown's demo switch; coord bootstrap default is a follow-up",
			) +
			executorPrefsEditor(cur.executors ?? [], s.default_executors ?? []) +
			`</div>`;
		return formFrame(
			"SETTINGS · SUSPENDERS",
			head,
			HIDDEN_FEATURE("suspenders") + body,
			me,
		);
	}
	if (!cur.gateway)
		return consolePage(
			`SETTINGS · ${feature.toUpperCase()}`,
			"settings",
			`<style>${FORM_CSS}</style>${head}<div class="errbox">no parsable policy on the belt chain — resolve that first (see /console/belt): ${esc(cur.polError ?? "not found")}</div><div class="btnrow"><a class="btn2" href="/console/settings">back</a></div>`,
			me,
		);
	const gw = cur.gateway;
	const fields =
		feature === "belt"
			? numField(
					"num_retries",
					"num_retries",
					gw.num_retries,
					"per-call retries before the ladder is tried (native retry-after backoff)",
				) +
				numField(
					"allowed_fails",
					"allowed_fails",
					gw.allowed_fails,
					"consecutive failures that bench a deployment into cooldown",
				)
			: ladderFields(gw);
	const ttl = numField(
		"cooldown_time (s)",
		"cooldown_time",
		gw.cooldown_time,
		"cooldown TTL — bench duration after allowed_fails consecutive failures",
	);
	const wrap =
		feature === "belt"
			? `<div class="formgrid">${fields}${ttl}</div>`
			: `${fields}${ttl}`;
	return formFrame(
		`SETTINGS · ${feature.toUpperCase()}`,
		head,
		HIDDEN_FEATURE(feature) +
			`<div class="panel"><h2>routing-policy.yaml · gateway</h2>${wrap}<p class="cfield-hint">shared with ${feature === "belt" ? "buckle" : "belt"} — one file, both processes read it</p></div>`,
		me,
	);
};

export interface SettingsIndexArgs {
	pol: PolicyCur | null;
	set: BoardSettingsState;
	me?: ConsoleMe;
	// W174: recent admin actions — settings/policy applies + key revocations
	audit: AdminAuditRow[];
}

export const settingsIndexPage = (a: SettingsIndexArgs): string => {
	const pol = a.pol;
	const polCard = pol
		? `<klh-policy-card heading="routing-policy.yaml" compact foot="belt + buckle share this file — edits apply to both (belt at the next gateway-config emit + kickstart, buckle at restart)" data="${esc(JSON.stringify(indexPolicySlice(pol)))}"></klh-policy-card>`
		: `<klh-policy-card heading="routing-policy.yaml" data="${esc(JSON.stringify({ kind: "missing" as const }))}"></klh-policy-card>`;
	const s = a.set;
	const knobs: KnobsCardData = {
		error: s.error,
		knobs: [
			{
				k: "STATUS_REFRESH_S",
				v: String(s.settings.status_refresh_s ?? "default (5s)"),
			},
			{
				k: "harvest TTL",
				v: s.settings.harvest_ttl_s
					? `${s.settings.harvest_ttl_s}s`
					: "default (300s)",
			},
			{ k: "default actor", v: s.settings.default_actor ?? "unset" },
			{
				k: "executors",
				v: s.settings.default_executors?.length
					? s.settings.default_executors.join(" → ")
					: "claude (default)",
			},
		],
	};
	const setCard = `<klh-knobs-card heading="suspenders-board.json · ${esc(s.path)}${s.exists ? "" : " · not created yet"}" data="${esc(JSON.stringify(knobs))}"></klh-knobs-card>`;
	// W174: the who/when trail — settings/policy applies + key revocations,
	// newest first, block-mode chips (the card's empty state covers zero rows)
	const auditRows: AuditRow[] = a.audit.map((r) => ({
		action: r.action,
		actor: r.actor ?? "unknown",
		when: new Date(r.ts).toISOString().replace("T", " ").slice(0, 19),
		target: r.target ?? "",
		detail: r.detail ?? "",
	}));
	const auditData: AuditListData = { rows: auditRows };
	const auditCard = `<klh-audit-list heading="admin audit" data="${esc(JSON.stringify(auditData))}"></klh-audit-list>`;
	return consolePage(
		"SETTINGS",
		"settings",
		`<style>${PAGE_CSS}</style><p class="dimpl">One entry per feature, each with its real config surface. Writes are config-over-code: YAML/JSON in known paths, never code. Every write previews a diff and needs an explicit confirm; invalid config is rejected with the parser's error.</p>` +
			polCard +
			`<div class="panel"><h2>edit</h2><div class="btnrow"><a class="btn2" href="/console/settings/belt">belt · budgets</a> <a class="btn2" href="/console/settings/buckle">buckle · ladder + cooldowns</a> <a class="btn2" href="/console/settings/suspenders">suspenders · board</a></div></div>` +
			setCard +
			auditCard +
			CARDS_SCRIPT,
		a.me,
	);
};

// ─── preview + confirm (the write guard) ──────────────────────────────────
export interface PreviewArgs {
	feature: Feature;
	diff: string[];
	valuesJson: string;
	mtimeMs: string;
	target: string;
	flash?: string;
	error?: string | null;
}

export const previewPage = (a: PreviewArgs, me?: ConsoleMe): string => {
	// values ride base64 (not HTML-escaped JSON) so the confirm round-trip is
	// lossless regardless of quoting; apply decodes + revalidates server-side
	const vB64 = Buffer.from(a.valuesJson, "utf8").toString("base64");
	const confirmForm =
		`<form method="post" action="/console/settings/apply">` +
		`<input type="hidden" name="feature" value="${a.feature}">` +
		`<input type="hidden" name="values" value="${vB64}">` +
		`<input type="hidden" name="mtime" value="${a.mtimeMs}">` +
		`<div class="btnrow"><button class="btn" type="submit">apply</button><a class="btn2" href="/console/settings">cancel</a></div></form>`;
	return consolePage(
		"SETTINGS · PREVIEW",
		"settings",
		`<style>${PILL_CSS}</style>` +
			(a.flash ? `<div class="flash">${esc(a.flash)}</div>` : "") +
			(a.error ? `<div class="errbox">${esc(a.error)}</div>` : "") +
			`<klh-diff-view heading="target · ${esc(a.target)}" lines="${esc(JSON.stringify(a.diff))}"><pre class="diff">${a.diff.map((l) => (l.startsWith("+ ") ? `<span class="add">${esc(l)}</span>` : l.startsWith("- ") ? `<span class="del">${esc(l)}</span>` : esc(l))).join("\n") || "no textual change"}</pre></klh-diff-view>${FORMS_SCRIPT}` +
			confirmForm,
		me,
	);
};
