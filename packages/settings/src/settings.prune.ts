// settings.prune.ts — W2873: one authoritative settings.json drift healer.
// The schema is .strict() everywhere, so a stale/unknown key taxes every
// short-lived hook process with the LKG fallback (settings.reader.ts). The
// install runs this ONCE (install-settings-prune.ts, wired into migrateConf
// — never per tool call): unknown keys are pruned against the current
// SettingsSchema, named legacy knowledge.distill shapes are migrated to the
// current shape, and drift the pass cannot heal fails LOUD so the operator's
// file is never silently rewritten into something else.
//
// Pure: copy-on-write tree helpers only, the input document is never
// mutated. Schema-level only — hub-overlay issues (settings.overlay) are
// the caller's verdict (validateDoc); the prune loop needs the raw zod
// issue objects (code/keys) that validateDoc discards.
import { z } from "zod";
import { SettingsSchema, settingsIssues } from "./settings.schema.ts";
import {
	type Doc,
	getPath,
	isPlainObject,
	setPath,
	unsetPath,
} from "./settings.tree.ts";

export interface PruneOutcome {
	/** true when the healed document parses under SettingsSchema. */
	valid: boolean;
	/** The healed document (=== the input document when nothing changed). */
	doc: Doc;
	/** Dotted paths of unknown keys removed. */
	pruned: string[];
	/** Dotted paths rewritten from a legacy shape to the current one. */
	migrated: string[];
	/** Loud issue list when !valid. */
	issues: string[];
}

/** A named legacy→current shape migration. Rows are extensible: the next
 *  drift lands as a new row, never as a special case in the loop. */
interface MigrationRow {
	/** Dotted path in the settings document. */
	path: string;
	/** The CURRENT schema's shape at this path — a value that parses here
	 *  is already migrated and never touched. (Kept in step with
	 *  settings.distill.ts; a shape drift surfaces as a loud prune failure,
	 *  the safe direction.) */
	current: z.ZodType;
	/** Legacy value → current value; null = not a legacy shape, leave it
	 *  for the loud failure. */
	rewrite: (v: unknown) => unknown | null;
}

const DISTILL_MIGRATIONS: MigrationRow[] = [
	{
		// legacy: an object record keyed by repo root → array of keys
		path: "knowledge.distill.repo_roots",
		current: z.array(z.string().min(1)),
		rewrite: (v) => (isPlainObject(v) ? Object.keys(v) : null),
	},
	{
		// legacy: { path: "<db>" } → the bare decant.db string
		path: "knowledge.distill.decant_db",
		current: z.string().min(1),
		rewrite: (v) => {
			if (!isPlainObject(v)) return null;
			const p = v.path;
			return typeof p === "string" && p.length > 0 ? p : null;
		},
	},
];

/** Bounded heal loop: at most MAX_PASSES prune/migrate rounds — the pass
 *  reaches a fixed point in 2 (migrations + one unrecognized-key round);
 *  5 leaves headroom for nesting. Never throws. */
const MAX_PASSES = 5;

export function pruneSettingsDoc(input: Doc): PruneOutcome {
	let doc: Doc = input;
	const pruned: string[] = [];
	const migrated: string[] = [];
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const check = SettingsSchema.safeParse(doc);
		if (check.success) break;
		let changed = false;
		// named migrations first — an invalid_type the pruner cannot fix
		// (the shape is known, the value is legacy)
		for (const row of DISTILL_MIGRATIONS) {
			const value = getPath(doc, row.path);
			if (row.current.safeParse(value).success) continue;
			const next = row.rewrite(value);
			if (next === null) continue;
			doc = setPath(doc, row.path, next);
			migrated.push(row.path);
			changed = true;
		}
		// unknown keys: delete at each unrecognized_keys issue path
		for (const issue of check.error.issues) {
			if (issue.code !== "unrecognized_keys") continue;
			for (const key of issue.keys) {
				const path = [...issue.path.map(String), String(key)].join(".");
				doc = unsetPath(doc, path);
				if (!pruned.includes(path)) pruned.push(path);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const final = SettingsSchema.safeParse(doc);
	return final.success
		? { valid: true, doc, pruned, migrated, issues: [] }
		: {
				valid: false,
				doc,
				pruned,
				migrated,
				issues: settingsIssues(final.error),
			};
}
