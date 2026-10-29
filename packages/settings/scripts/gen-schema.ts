// scripts/gen-schema.ts — regenerate the committed settings.schema.json.
//   bun packages/settings/scripts/gen-schema.ts           # print
//   bun packages/settings/scripts/gen-schema.ts --write   # rewrite the file
// The guard spec (test/settings-schema.e2e.ts) fails when the committed
// copy drifts from SettingsSchema — run --write after a schema edit.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	SCHEMA_FILE,
	settingsJsonSchemaText,
} from "../src/settings.jsonschema.ts";

const text = settingsJsonSchemaText();
if (process.argv.includes("--write")) {
	const target = join(import.meta.dir, "..", SCHEMA_FILE);
	writeFileSync(target, text);
	process.stdout.write(`wrote ${target}\n`);
} else {
	process.stdout.write(text);
}
