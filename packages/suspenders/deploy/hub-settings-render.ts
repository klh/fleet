// deploy/hub-settings-render.ts — `hubctl render <hub> --settings`: the
// hub's own settings.json, rendered from this machine's settings.json as
// deepMerge(machine doc minus private overlays, hubs.<label>.settings) and
// validated through the same SettingsSchema (@klh/settings owns the merge).
import {
	readSettingsFile,
	renderHubSettings,
	settingsPath,
} from "@klh/settings";

/** The rendered settings.json text for `label`; throws with the loud
 *  validation issues when the overlay does not render. */
export function hubSettingsText(label: string): string {
	const machine = readSettingsFile(settingsPath()) ?? {};
	const r = renderHubSettings(machine, label);
	if (!r.ok)
		throw new Error(
			`hubctl: ${label} settings do not render:\n  ${r.issues.join("\n  ")}`,
		);
	return JSON.stringify(r.doc, null, 2);
}
