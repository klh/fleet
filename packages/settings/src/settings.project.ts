// settings.project.ts — the two-way bridge between a settings `hubs.<label>`
// entry and the legacy flat stack.json hub profile (buckle_port, bind,
// board_health_port, token…). toLegacyProfile feeds hubctl / resolveHub
// unchanged during the transition; fromLegacyProfile is the migration
// direction. The flat⇄grouped field table is the single source of both.
import type { Hub } from "./settings.hubs.ts";
import { type Doc, isPlainObject } from "./settings.tree.ts";

/** [flat legacy key, group, grouped key] */
const GROUPED: ReadonlyArray<
	readonly [string, "ports" | "health_ports" | "binds", string]
> = [
	["buckle_port", "ports", "buckle"],
	["board_port", "ports", "board"],
	["store_port", "ports", "store"],
	["belt_port", "ports", "belt"],
	["model_store_port", "ports", "model_store"],
	["buckle_ready_port", "ports", "buckle_ready"],
	["buckle_health_port", "health_ports", "buckle"],
	["board_health_port", "health_ports", "board"],
	["store_health_port", "health_ports", "store"],
	["belt_health_port", "health_ports", "belt"],
	["model_store_health_port", "health_ports", "model_store"],
	["bind", "binds", "buckle"],
	["board_bind", "binds", "board"],
	["belt_bind", "binds", "belt"],
];

/** Settings hub → legacy flat profile (token_file stays a path; readers
 *  resolve it — the value never enters the document). */
export function toLegacyProfile(hub: Hub): Doc {
	const out: Doc = {};
	for (const [k, v] of Object.entries(hub)) {
		if (
			k === "ports" ||
			k === "health_ports" ||
			k === "binds" ||
			k === "settings"
		)
			continue;
		if (v !== undefined) out[k] = v;
	}
	for (const [flat, group, key] of GROUPED) {
		const g = hub[group] as Doc | undefined;
		const v = g?.[key];
		if (v !== undefined) out[flat] = v;
	}
	return out;
}

export interface LegacyConversion {
	hub: Doc;
	/** Inline secret values lifted out: field → value (caller writes 0600). */
	secrets: Record<string, string>;
}

/** Legacy flat profile → settings hub shape. Inline `token` values are
 *  lifted into `secrets` for the caller to persist as a 0600 file. */
export function fromLegacyProfile(profile: Doc): LegacyConversion {
	const hub: Doc = {};
	const secrets: Record<string, string> = {};
	const flatKeys = new Set(GROUPED.map(([flat]) => flat));
	for (const [k, v] of Object.entries(profile)) {
		if (flatKeys.has(k)) continue;
		if (k === "token") {
			if (typeof v === "string" && v) secrets.token = v;
			continue;
		}
		hub[k] = v;
	}
	for (const [flat, group, key] of GROUPED) {
		const v = profile[flat];
		if (v === undefined) continue;
		const g: Doc = isPlainObject(hub[group]) ? (hub[group] as Doc) : {};
		g[key] = v;
		hub[group] = g;
	}
	return { hub, secrets };
}
