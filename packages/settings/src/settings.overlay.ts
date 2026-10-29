// settings.overlay.ts — per-hub settings rendering. Each install edits its
// own settings.json; the operator machine may also carry, per hub label, a
// deep-partial overlay at `hubs.<label>.settings`. A hub's rendered
// settings.json = deepMerge(machine document minus every hub's private
// overlay, that hub's overlay), validated through the SAME SettingsSchema.
// The topology (`hubs`) rides along so every hub knows its peers; an
// overlay may not rewrite topology.
import { SettingsSchema, settingsIssues } from "./settings.schema.ts";
import { type Doc, deepMerge, isPlainObject } from "./settings.tree.ts";

/** The machine document with every hub's private `settings` overlay
 *  stripped (overlays are the operator's, not the hub's). */
export function stripOverlays(doc: Doc): Doc {
	const out: Doc = structuredClone(doc);
	if (!isPlainObject(out.hubs)) return out;
	for (const hub of Object.values(out.hubs))
		if (isPlainObject(hub)) delete hub.settings;
	return out;
}

export type Rendered = { ok: true; doc: Doc } | { ok: false; issues: string[] };

/** Render `label`'s settings.json from the machine document. */
export function renderHubSettings(machine: Doc, label: string): Rendered {
	const hubs = isPlainObject(machine.hubs) ? machine.hubs : {};
	const hub = hubs[label];
	if (!isPlainObject(hub))
		return {
			ok: false,
			issues: [
				`hubs.${label}: unknown hub label (known: ${Object.keys(hubs).join(", ") || "none"})`,
			],
		};
	const overlay = isPlainObject(hub.settings) ? hub.settings : {};
	if ("hubs" in overlay)
		return {
			ok: false,
			issues: [
				`hubs.${label}.settings.hubs: an overlay may not rewrite topology`,
			],
		};
	const base = stripOverlays(machine);
	const doc = deepMerge(base, overlay) as Doc;
	doc.hubs = base.hubs;
	const r = SettingsSchema.safeParse(doc);
	return r.success
		? { ok: true, doc }
		: {
				ok: false,
				issues: settingsIssues(r.error).map(
					(l) => `hubs.${label}.settings → ${l}`,
				),
			};
}
