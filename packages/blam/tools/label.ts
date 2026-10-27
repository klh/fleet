// tools/label.ts — BLAM dataset CLI: validate | list | add.
// Hand-rolled validator for the JSON-Schema subset BLAM uses (type, enum,
// pattern, maxLength, minimum, required, additionalProperties, properties,
// items, $ref within definitions). Zero dependencies; run by bun.
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const SCHEMA_PATH = `${ROOT}schema/incident.schema.json`;
const DATASET_PATH = `${ROOT}dataset/incidents.jsonl`;

type Schema = Record<string, unknown>;
type Rec = Record<string, unknown>;

function fail(
	schema: Schema | undefined,
	value: unknown,
	path: string,
	errs: string[],
) {
	if (!schema) return; // unknown field (already flagged) or permissive schema
	const t = schema.type as string | undefined;
	const ref = schema.$ref as string | undefined;
	if (typeof ref === "string") {
		const name = ref.replace("#/definitions/", "");
		const defs = (schema.definitions ?? {}) as Schema;
		const target = defs[name];
		if (target)
			fail({ ...target, definitions: schema.definitions }, value, path, errs);
		return;
	}
	if (typeof t === "string") {
		const actual = Array.isArray(value) ? "array" : typeof value;
		const ok =
			(t === "object" && actual === "object" && value !== null) ||
			(t === "array" && actual === "array") ||
			(t === "string" && actual === "string") ||
			(t === "integer" && actual === "number" && Number.isInteger(value)) ||
			(t === "number" && actual === "number") ||
			(t === "boolean" && actual === "boolean");
		if (!ok) {
			errs.push(`${path}: expected ${t}, got ${actual}`);
			return;
		}
	}
	if (Array.isArray(schema.enum)) {
		if (!schema.enum.includes(value))
			errs.push(`${path}: must be one of ${schema.enum.join("|")}`);
	}
	if (typeof schema.pattern === "string" && typeof value === "string") {
		if (!new RegExp(schema.pattern).test(value))
			errs.push(`${path}: must match ${schema.pattern}`);
	}
	if (typeof schema.maxLength === "number" && typeof value === "string") {
		if (value.length > schema.maxLength)
			errs.push(`${path}: exceeds maxLength ${schema.maxLength}`);
	}
	if (typeof schema.minimum === "number" && typeof value === "number") {
		if (value < schema.minimum) errs.push(`${path}: below minimum`);
	}
	if (
		t === "object" &&
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
	) {
		const obj = value as Rec;
		for (const r of (schema.required as string[]) ?? [])
			if (!(r in obj)) errs.push(`${path}.${r}: missing required field`);
		if (schema.additionalProperties === false) {
			for (const k of Object.keys(obj))
				if (!(k in ((schema.properties as Schema) ?? {})))
					errs.push(`${path}.${k}: unknown field`);
			for (const k of Object.keys(obj))
				fail(
					(schema.properties as Schema)?.[k] as Schema,
					obj[k],
					`${path}.${k}`,
					errs,
				);
		} else {
			const props = (schema.properties as Schema) ?? {};
			for (const k of Object.keys(obj))
				if (k in props) fail(props[k] as Schema, obj[k], `${path}.${k}`, errs);
		}
	}
	if (t === "array" && Array.isArray(value)) {
		const items = schema.items as Schema | undefined;
		if (items)
			value.forEach((v, i) => {
				fail(items, v, `${path}[${i}]`, errs);
			});
	}
}

export function validateRecord(rec: Rec, schema: Schema): string[] {
	const errs: string[] = [];
	fail(schema, rec, "$", errs);
	return errs;
}

export function loadSchema(): Schema {
	return JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Schema;
}

export function loadDataset(): Rec[] {
	if (!existsSync(DATASET_PATH)) return [];
	return readFileSync(DATASET_PATH, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Rec);
}

function validateCmd(): number {
	const schema = loadSchema();
	const recs = loadDataset();
	let bad = 0;
	for (const rec of recs) {
		const errs = validateRecord(rec, schema);
		if (errs.length) {
			bad++;
			console.error(`✗ ${rec.id}: ${errs.join("; ")}`);
		}
	}
	console.log(
		bad === 0
			? `✓ ${recs.length} records valid`
			: `${bad}/${recs.length} records INVALID`,
	);
	return bad === 0 ? 0 : 1;
}

function listCmd(): number {
	const recs = loadDataset();
	const byClass = new Map<string, number>();
	for (const r of recs)
		byClass.set(
			r.crash_class as string,
			(byClass.get(r.crash_class as string) ?? 0) + 1,
		);
	for (const [k, n] of byClass) console.log(`${k}: ${n}`);
	console.log(`total: ${recs.length}`);
	return 0;
}

if (import.meta.main) {
	const cmd = process.argv[2] ?? "";
	if (cmd === "validate") process.exit(validateCmd());
	else if (cmd === "list") process.exit(listCmd());
	else {
		console.error("usage: label.ts validate|list");
		process.exit(1);
	}
}
