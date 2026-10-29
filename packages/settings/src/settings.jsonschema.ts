// settings.jsonschema.ts — the generated JSON Schema (zod v4 toJSONSchema,
// input view: every defaulted key optional, defaults + descriptions carried)
// that settings.json's `$schema` points editors at. One generator for the
// committed copy (scripts/gen-schema.ts) and the per-install copy written
// next to the user's file (`coord settings schema --write`).
import { z } from "zod";
import { SettingsSchema } from "./settings.schema.ts";

export const SCHEMA_FILE = "settings.schema.json";

export function settingsJsonSchemaText(): string {
	const schema = z.toJSONSchema(SettingsSchema, {
		io: "input",
		unrepresentable: "any",
	});
	return `${JSON.stringify(schema, null, 2)}\n`;
}
