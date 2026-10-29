// hooks/coord/settings.ts — `coord settings …`: the per-install
// settings.json surface (get/set/unset/validate/show/schema/migrate/
// render-hub). Behaviour lives in @klh/settings (runSettingsCli); this is
// the coord face on the verb-kit.
import { runSettingsCli } from "@klh/settings";

export function cmdSettings(rest: string[]): void {
	const code = runSettingsCli(rest);
	if (code !== 0) process.exit(code);
}
