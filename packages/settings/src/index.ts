// @klh/settings — the ONE per-install settings surface. Import from here.
export {
	coerceEnv,
	ENV_BY_NAME,
	ENV_BY_PATH,
	ENV_MAP,
	type EnvMapping,
	PLUMBING_ENV,
	SECRET_ENV,
} from "./settings.env-map.ts";
export { type Hub, HubSchema } from "./settings.hubs.ts";
export { SCHEMA_FILE, settingsJsonSchemaText } from "./settings.jsonschema.ts";
export {
	migrate,
	type MigrateInput,
	type MigrateResult,
} from "./settings.migrate.ts";
export { renderHubSettings, stripOverlays } from "./settings.overlay.ts";
export { fromLegacyProfile, toLegacyProfile } from "./settings.project.ts";
export {
	expandHome,
	type Origin,
	originOf,
	type ReadMode,
	type Resolved,
	readSettingsFile,
	resetSettingsCache,
	resolveSettings,
	SettingsError,
	setting,
	settings,
	settingsPath,
	validateDoc,
	warnDeprecated,
} from "./settings.reader.ts";
export {
	type SettingAt,
	type SettingPath,
	type Settings,
	type SettingsInput,
	SettingsSchema,
	settingsIssues,
} from "./settings.schema.ts";
export { runSettingsCli, type CliIo } from "./settings.cli.ts";
export { deepMerge, getPath, setPath, unsetPath } from "./settings.tree.ts";
