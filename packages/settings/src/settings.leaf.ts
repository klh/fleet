// settings.leaf.ts — the leaf builders every section schema composes from.
// One shape per leaf kind, so every knob carries the same three things the
// settings law requires: bounds, a .default(), and a .describe() (the JSON
// Schema description editors show). Section objects are .strict() — an
// unknown key fails LOUD — and .prefault({}) so an absent section still
// parses through its leaf defaults (zod v4: .default() short-circuits the
// inner parse; .prefault() feeds the value through it).
import { z } from "zod";

/** Bounded integer knob with a default. */
export const int = (min: number, max: number, def: number, desc: string) =>
	z.number().int().min(min).max(max).default(def).describe(desc);

/** Bounded finite number knob with a default (shares, ratios). */
export const num = (min: number, max: number, def: number, desc: string) =>
	z.number().min(min).max(max).default(def).describe(desc);

/** Boolean switch with a default. */
export const bool = (def: boolean, desc: string) =>
	z.boolean().default(def).describe(desc);

/** Non-empty string with a default. */
export const str = (def: string, desc: string) =>
	z.string().min(1).max(4096).default(def).describe(desc);

/** One of a closed set, with a default. */
export const oneOf = <const T extends readonly [string, ...string[]]>(
	values: T,
	def: T[number],
	desc: string,
) => z.enum(values).default(def).describe(desc);

/** A genuinely-absent-by-default value (a URL or path that has no sane
 *  universal default). Absence IS the default: readers treat undefined as
 *  "feature off / fall through". */
export const opt = (desc: string) =>
	z.string().min(1).max(4096).optional().describe(desc);

/** A filesystem path (`~/` expands at read time) with a default. */
export const path = (def: string, desc: string) =>
	z
		.string()
		.min(1)
		.max(4096)
		.default(def)
		.describe(`${desc} (path; ~/ expands)`);

/** A port number, optional (hub profiles declare only what they serve). */
export const port = (desc: string) =>
	z.number().int().min(1).max(65_535).optional().describe(desc);

/** A string list with a default. */
export const list = (def: string[], desc: string) =>
	z.array(z.string().min(1).max(4096)).max(256).default(def).describe(desc);

/** A strict section object that parses `{}` through its leaf defaults. */
export const section = <S extends z.ZodRawShape>(shape: S, desc: string) =>
	z.object(shape).strict().prefault({}).describe(desc);
