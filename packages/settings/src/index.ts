// @klh/settings — the ONE per-install settings surface. Import from here.

export { type CliIo, runSettingsCli } from "./settings.cli.ts";
export {
	type DistillConfig,
	DistillConfigSchema,
	DistillWeightsSchema,
	DistillWindowSchema,
	distillDefaults,
	PressureProbeSchema,
} from "./settings.distill.ts";
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
	KNOB_FAMILY_PREFIXES,
	KNOB_REGISTRY,
	type KnobHome,
	type KnobHomeKind,
	knobHome,
} from "./settings.knob-registry.ts";
export {
	FOLD_INTO_FLEET_LOOP,
	type MigrateInput,
	type MigrateResult,
	migrate,
} from "./settings.migrate.ts";
export { renderHubSettings, stripOverlays } from "./settings.overlay.ts";
export { type PruneOutcome, pruneSettingsDoc } from "./settings.prune.ts";
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
	RunnerServiceUrlSchema,
	RunnerSettingsSchema,
} from "./settings.runner.ts";
export {
	patchSettings,
	type WriteVerdict,
	writeSettingsDoc,
} from "./settings.writer.ts";
export {
	type SettingAt,
	type SettingPath,
	type Settings,
	type SettingsInput,
	SettingsSchema,
	settingsIssues,
} from "./settings.schema.ts";
export { RoutePreflightSchema } from "./settings.stack.ts";
export { deepMerge, getPath, setPath, unsetPath } from "./settings.tree.ts";
