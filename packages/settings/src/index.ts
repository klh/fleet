// @klh/settings — the ONE per-install settings surface. Import from here.

export { type CliIo, runSettingsCli } from "./settings.cli.ts";
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
	type DistillConfig,
	DistillConfigSchema,
	distillDefaults,
	DistillWeightsSchema,
	DistillWindowSchema,
	PressureProbeSchema,
} from "./settings.distill.ts";
export {
	KNOB_FAMILY_PREFIXES,
	KNOB_REGISTRY,
	type KnobHome,
	type KnobHomeKind,
	knobHome,
} from "./settings.knob-registry.ts";
export {
	jsonSiblingOf,
	type LlmConfEnv,
	type LlmConfSource,
	resolvePolicyDoc,
	resolveUpstreamsDoc,
} from "./settings.llm-conf.ts";
export {
	FOLD_INTO_FLEET_LOOP,
	type MigrateInput,
	type MigrateResult,
	migrate,
} from "./settings.migrate.ts";
export { renderHubSettings, stripOverlays } from "./settings.overlay.ts";
export { fromLegacyProfile, toLegacyProfile } from "./settings.project.ts";
export { RoutePreflightSchema } from "./settings.stack.ts";
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
export { deepMerge, getPath, setPath, unsetPath } from "./settings.tree.ts";
