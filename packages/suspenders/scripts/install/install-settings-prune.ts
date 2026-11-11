// scripts/install/install-settings-prune.ts — W2873: the install's
// authoritative settings.json drift pass. Runs ONCE per install inside
// migrateConf (never per tool call): unknown keys are pruned against the
// current @klh/settings schema (settings.prune.ts) and named
// knowledge.distill legacy shapes are migrated. The healed document is
// written back 0600 atomically and the reader's LKG snapshot
// (settings.lkg.json) is refreshed in the reader's exact byte format.
// Malformed JSON or drift the pass cannot heal fails LOUD and leaves the
// operator's file untouched. Idempotent: a fully-valid document is a
// no-op ("current").
import { dirname, join } from "node:path";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { pruneSettingsDoc, readSettingsFile, validateDoc } from "@klh/settings";

export interface PruneStepResult {
	status: "ok" | "failed";
	note: string;
}

export function pruneMachineSettings(home: string): PruneStepResult {
	const settingsFile = join(home, ".config", "klh", "settings.json");
	let doc: ReturnType<typeof readSettingsFile>;
	try {
		doc = readSettingsFile(settingsFile);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			status: "failed",
			note: `settings prune: settings.json unreadable (${msg}) — resolve manually; nothing written`,
		};
	}
	if (doc === null)
		return { status: "ok", note: "settings prune: no settings.json — none" };
	// fully-valid documents (schema + hub overlays) are a no-op — the
	// pass never rewrites a file it did not heal
	if (validateDoc(doc).ok)
		return { status: "ok", note: "settings prune: current" };
	const outcome = pruneSettingsDoc(doc);
	if (!outcome.valid)
		return {
			status: "failed",
			note: `settings prune could not heal settings.json: ${outcome.issues.join("; ")} — resolve manually; nothing written`,
		};
	// overlays the prune cannot fix must not be papered over
	const overlays = validateDoc(outcome.doc);
	if (!overlays.ok)
		return {
			status: "failed",
			note: `settings prune: healed document still invalid (${overlays.issues.join("; ")}) — resolve manually; nothing written`,
		};
	const healed = `${JSON.stringify(outcome.doc, null, 2)}\n`;
	atomicWrite0600(settingsFile, healed);
	// refresh the reader's LKG in the reader's exact compact format so
	// the next valid read does not see a stale snapshot
	atomicWrite0600(
		join(dirname(settingsFile), "settings.lkg.json"),
		`${JSON.stringify(outcome.doc)}\n`,
	);
	const parts: string[] = [];
	if (outcome.pruned.length > 0)
		parts.push(`pruned [${outcome.pruned.join(", ")}]`);
	if (outcome.migrated.length > 0)
		parts.push(`migrated [${outcome.migrated.join(", ")}]`);
	return { status: "ok", note: `settings prune: ${parts.join(" ")}` };
}
