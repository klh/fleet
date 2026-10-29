// settings.schema.ts — THE root SettingsSchema: one strict object composed
// from the named sections. `settings.json` is nested objects only
// ({"consult":{"feedback":{"require_on_done":true}}}), validated here; an
// unknown key anywhere fails loud with the prettified zod error.
import { z } from "zod";
import { HubsSchema } from "./settings.hubs.ts";
import {
	BoardSchema,
	BuckleSchema,
	ConsultSchema,
	DispatchSchema,
	FleetLoopSchema,
	GatesSchema,
	KnowledgeSchema,
	PathsSchema,
	SteerSchema,
	TelemetrySchema,
} from "./settings.sections.ts";
import { StackSections } from "./settings.stack.ts";

export const SettingsSchema = z
	.object({
		$schema: z
			.string()
			.optional()
			.describe("JSON Schema pointer for editors (settings.schema.json)"),
		...StackSections,
		hubs: HubsSchema,
		fleet_loop: FleetLoopSchema,
		consult: ConsultSchema,
		knowledge: KnowledgeSchema,
		board: BoardSchema,
		gates: GatesSchema,
		steer: SteerSchema,
		buckle: BuckleSchema,
		dispatch: DispatchSchema,
		paths: PathsSchema,
		telemetry: TelemetrySchema,
	})
	.strict()
	.describe("klh fleet per-install settings (~/.config/klh/settings.json)");

/** The resolved, defaults-filled settings value. */
export type Settings = z.infer<typeof SettingsSchema>;
/** What a settings.json file may contain (every defaulted key optional). */
export type SettingsInput = z.input<typeof SettingsSchema>;

type Leafish =
	| string
	| number
	| boolean
	| null
	| undefined
	| readonly unknown[];

/** Dotted paths into Settings. Records (hubs, providers…) and arrays stop
 *  the walk — their members are addressed as `<path>.<key>` strings at
 *  runtime (getPath) but typed as the container. */
export type SettingPath<T = Settings> = T extends Leafish
	? never
	: {
			[K in keyof T & string]: NonNullable<T[K]> extends Leafish
				? K
				: string extends keyof NonNullable<T[K]>
					? K
					: K | `${K}.${SettingPath<NonNullable<T[K]>>}`;
		}[keyof T & string];

/** The value type at a dotted path. */
export type SettingAt<
	P extends string,
	T = Settings,
> = P extends `${infer H}.${infer R}`
	? H extends keyof T
		? SettingAt<R, NonNullable<T[H]>>
		: never
	: P extends keyof T
		? T[P]
		: never;

/** Render a zod error as `path: message` lines (the loud-failure text). */
export function settingsIssues(err: z.ZodError): string[] {
	return err.issues.map(
		(i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`,
	);
}
