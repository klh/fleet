// hooks/lib/work-report-live.ts — W1131 live lane facts for `work report`:
// per-lane last-activity + terminal hub from the buckle route_audit ledger,
// and hub-label resolution from MACHINE config (stack.yaml hub profiles +
// hubs.json candidates) — never hardcoded hosts. A hub label is what the
// brief calls the terminal hub: the target the LOCAL ledger last forwarded
// this lane's usage-bearing request to (loopback = this machine's own swarm).
// Same fail-soft rules as lane-spend.ts: an unreadable ledger yields no
// live facts — metrics never blocks on the gateway.

import { Database } from "bun:sqlite";
import { readRegistry } from "./hub-locate.ts";
import { tryLoadStack } from "./stack-config.ts";

/** One lane's live tail: the LAST usage-bearing request we served it. */
export interface LaneLive {
	sid: string;
	/** last usage-bearing request, epoch ms; null = none in the window */
	lastTs: number | null;
	/** last request that produced output tokens (the stall signal) */
	lastOutTs: number | null;
	/** terminal hub label of that last request: mac|nas|desktop|cloud:<p>|? */
	hub: string | null;
	/** the target model of that last request (wire id, unverified) */
	model: string | null;
	/** usage-bearing requests since the window opened */
	requests: number;
}

/** host:port → hub label, machine-config only. */
export type HubMap = Record<string, string>;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

/** Cloud provider alias: registrable host → short provider name. */
const PROVIDER_ALIAS: Record<string, string> = {
	"z.ai": "zai",
	"bigmodel.cn": "zai",
	"githubcopilot.com": "copilot",
	"anthropic.com": "anthropic",
	"openai.com": "openai",
	"openrouter.ai": "openrouter",
	"googleapis.com": "gemini",
};

/** host:port → label from stack.yaml hub profiles (host + buckle_port). */
function hubMapFromStack(): HubMap {
	const stack = tryLoadStack();
	const out: HubMap = {};
	if (!stack) return out;
	for (const [label, hub] of Object.entries(stack.hubs)) {
		const port = hub.buckle_port;
		if (!hub.host || !port) continue;
		out[`${String(hub.host).toLowerCase()}:${port}`] = label;
	}
	return out;
}

/** host:port → label from hubs.json candidate URLs (label → candidates[]). */
function hubMapFromRegistry(): HubMap {
	try {
		const reg = readRegistry();
		const out: HubMap = {};
		for (const [label, entry] of Object.entries(reg)) {
			for (const cand of entry?.candidates ?? []) {
				try {
					const u = new URL(cand);
					if (u.hostname && u.port)
						out[`${u.hostname.toLowerCase()}:${u.port}`] = label;
				} catch {}
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** The ONE hub map: registry candidates win (they carry the live face),
 *  stack.yaml profiles fill the rest. Deterministic per config content. */
export function buildHubMap(): HubMap {
	return { ...hubMapFromStack(), ...hubMapFromRegistry() };
}

/** Cloud provider name for a public host: alias table, else the first
 *  label after stripping a leading "api."/"gateway."/"gw.". */
export const cloudProviderOf = (host: string): string => {
	const h = host.toLowerCase();
	for (const [suffix, name] of Object.entries(PROVIDER_ALIAS))
		if (h === suffix || h.endsWith(`.${suffix}`)) return name;
	return h.replace(/^(api|gateway|gw)\./, "").split(".")[0] ?? h;
};

/** Terminal-hub label for one route_audit target. Loopback = this machine
 *  (SUSPENDERS_SELF_HUB_LABEL renames it); mapped host:port = its label;
 *  .local = its mDNS label; public = cloud:<provider>; empty = "?". */
export function hubLabelOf(
	host: string | null,
	port: number | null,
	map: HubMap = buildHubMap(),
): string {
	if (!host) return "?";
	const h = host.toLowerCase();
	if (LOOPBACK.has(h))
		return process.env.SUSPENDERS_SELF_HUB_LABEL || "mac";
	const hit = map[`${h}:${port ?? ""}`];
	if (hit) return hit;
	if (h.endsWith(".local")) return h.slice(0, -".local".length);
	if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(h))
		return "?"; // private address no config claims — unknown, never a guess
	return `cloud:${cloudProviderOf(h)}`;
}

/** Per-lane live tail from the buckle ledger: the last usage-bearing
 *  request per lane since `fromIso` (lexicographic ISO compare). */
export function laneLiveRows(dbPath: string, fromIso: string): LaneLive[] {
	const d = new Database(dbPath, { readonly: true });
	try {
		const rows = d
			.query(
				`SELECT lane, ts, target_host, target_port, target_model, in_tok, out_tok
				 FROM route_audit
				 WHERE lane <> '' AND in_tok IS NOT NULL AND ts >= ?
				 ORDER BY ts`,
			)
			.all(fromIso) as Array<Record<string, unknown>>;
		const map = buildHubMap();
		const bySid = new Map<string, LaneLive>();
		for (const r of rows) {
			const sid = String(r.lane);
			const ts = Date.parse(String(r.ts));
			if (!Number.isFinite(ts)) continue;
			const out = Number(r.out_tok) || 0;
			const cur = bySid.get(sid) ?? {
				sid,
				lastTs: null,
				lastOutTs: null,
				hub: null,
				model: null,
				requests: 0,
			};
			cur.lastTs = ts;
			cur.hub = hubLabelOf(
				r.target_host == null ? null : String(r.target_host),
				r.target_port == null ? null : Number(r.target_port),
				map,
			);
			cur.model = r.target_model ? String(r.target_model) : cur.model;
			cur.requests += 1;
			if (out > 0) cur.lastOutTs = ts;
			bySid.set(sid, cur);
		}
		return [...bySid.values()];
	} finally {
		d.close();
	}
}

/** Board deep-link base (W1131): env override → stack.yaml hub console_url →
 *  the .local default. Config-over-code — the origin lives in machine conf. */
export function reportBoardBase(): string {
	const env = process.env.SUSPENDERS_REPORT_LINK_BASE;
	if (env) return env.replace(/\/$/, "");
	try {
		const stack = tryLoadStack();
		for (const hub of Object.values(stack?.hubs ?? {}))
			if (hub.console_url) return hub.console_url.replace(/\/$/, "");
	} catch {}
	return "http://suspenders.local";
}
