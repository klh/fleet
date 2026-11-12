// settings.writer.ts — the ONE settings writer (W3056). The write-time
// mirror of settings.reader.ts's posture: every settings.json write goes
// through here, validates the RESULTING document against the strict
// SettingsSchema (unknown keys refuse with the offending dotted path), and
// only then does the atomic 0600 write. A refused patch writes NOTHING —
// an invalid conf must never reach disk to then silently fall back at
// read time (the review_model incident class).
import { dirname } from "node:path";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { readSettingsFile, validateDoc } from "./settings.reader.ts";
import { settingsPath } from "./settings.reader.ts";
import { type Doc, deepMerge } from "./settings.tree.ts";

export interface WriteVerdict {
	ok: boolean;
	/** Refusal reasons with the offending dotted path (ok=false only). */
	issues: string[];
	/** The validated document that was written (ok=true only). */
	doc?: Doc;
}

const serialize = (doc: Doc): string => `${JSON.stringify(doc, null, "\t")}\n`;

/** Validate + write a FULL settings document (replacement semantics). */
export function writeSettingsDoc(
	doc: Doc,
	opts: { file?: string } = {},
): WriteVerdict {
	const file = opts.file ?? settingsPath();
	const check = validateDoc(doc);
	if (!check.ok) return { ok: false, issues: check.issues };
	try {
		atomicWrite0600(file, serialize(doc));
	} catch (err) {
		return { ok: false, issues: [`<io>: ${String(err)}`] };
	}
	return { ok: true, issues: [], doc };
}

/** Deep-merge a patch onto the current on-disk document, then validate +
 *  write the merged result. A patch key the schema does not know refuses
 *  with `path: unrecognized key(s)` — the write never lands. */
export function patchSettings(
	patch: Doc,
	opts: { file?: string } = {},
): WriteVerdict {
	const file = opts.file ?? settingsPath();
	const current = readSettingsFile(file) ?? {};
	return writeSettingsDoc(deepMerge(current, patch) as Doc, opts);
}

/** The directory that holds the settings file (for the .lkg sibling). */
export const settingsDir = (opts: { file?: string } = {}): string =>
	dirname(opts.file ?? settingsPath());
