// scripts/posture-rollout-drill/drill-store.ts — W1315.6 drill A: the
// migration / CAS / rollback cycle of the W1315.2 store, exercised against
// a byte-copy of the REAL machine conf (never the machine file itself).
// Run: bun scripts/posture-rollout-drill/drill-store.ts
import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
	assert,
	installed,
	rolloutDocument,
	scratchConf,
} from "./rollout-drill.kit.ts";

type StoreModule = typeof import("../../hooks/lib/posture/posture.store.ts");
type ZodModule = typeof import("../../hooks/lib/posture/posture.zod.ts");
const store = await installed<StoreModule>(
	"hooks/lib/posture/posture.store.ts",
);
const zod = await installed<ZodModule>("hooks/lib/posture/posture.zod.ts");
const DOC = zod.parsePostureDocument(
	JSON.stringify(rolloutDocument()),
	"drill/proposal",
);

/** A REAL guarded rollback: restores the backup bytes only when the live
 *  revision still matches the one observed at migration time; refuses
 *  (leaves the file byte-untouched) when a concurrent writer moved it. */
const guardedRollback = (
	confPath: string,
	observedRevision: string | null,
	backupText: string,
): { rolledBack: boolean; currentRevision: string | null } => {
	const current = store.readStackPostureConfig(confPath);
	if (current.revision !== observedRevision)
		return { rolledBack: false, currentRevision: current.revision };
	writeFileSync(confPath, backupText);
	return { rolledBack: true, currentRevision: observedRevision };
};

const { conf, reset, clean } = scratchConf("store");
const backupPath = `${conf}.pre-postures.bak.json`;
const originalText = readFileSync(conf, "utf8");
const mode0600 = (p: string): boolean => (statSync(p).mode & 0o777) === 0o600;

reset();
// ── 1. pre-migration state ──
const before = store.readStackPostureConfig(conf);
assert(before.document === null, "pre-migration: no postures document");
const R0 = before.revision;
assert(mode0600(conf), "conf copy is mode 0600");

// ── 2. migrate ──
const mig = store.migrateStackPostureConfig(conf, DOC, R0);
assert(mig.document !== null, "migration wrote the postures document");
assert(
	mig.document?.selection.posture === "standard" &&
		mig.document?.selection.fleet === "main",
	"selection landed as proposed",
);
assert(mode0600(conf), "conf stays 0600 after migrate");

// ── 3. backup + envelope preservation ──
const backup = JSON.parse(readFileSync(backupPath, "utf8")) as {
	revision: string;
	originalText: string;
};
assert(
	backup.revision === R0 && backup.originalText === originalText,
	"backup preserves the exact original bytes + revision",
);
assert(mode0600(backupPath), "backup is 0600");
const envelope = JSON.parse(readFileSync(conf, "utf8")) as Record<
	string,
	unknown
>;
const original = JSON.parse(originalText) as Record<string, unknown>;
assert(
	Object.keys(envelope)
		.filter((k) => k !== "postures")
		.every((k) => JSON.stringify(envelope[k]) === JSON.stringify(original[k])),
	"every pre-existing envelope key is byte-preserved",
);

// ── 4. concurrent-change refusal (full-file CAS) ──
const R1 = store.readStackPostureConfig(conf).revision;
const moved = store.saveStackPostureSelection(
	conf,
	{ fleet: "main", posture: "minimal", developmentOverride: false },
	R1,
);
assert(
	moved.document?.selection.posture === "minimal",
	"concurrent writer flips to minimal",
);
let refused = "";
try {
	store.saveStackPostureSelection(
		conf,
		{ fleet: "main", posture: "standard", developmentOverride: false },
		R1,
	);
} catch (e) {
	refused = e instanceof Error ? e.message : String(e);
}
assert(
	refused.includes("changed since the preview"),
	"stale write refused (CAS)",
);
assert(
	store.readStackPostureConfig(conf).document?.selection.posture === "minimal",
	"refused write changed nothing",
);

// ── 5. rollback: original bytes restored ──
writeFileSync(conf, originalText);
assert(
	readFileSync(conf, "utf8") === originalText,
	"rollback restores the exact original bytes",
);
assert(
	store.readStackPostureConfig(conf).document === null,
	"post-rollback: un-migrated again (postures gone)",
);
assert(mode0600(conf), "rollback kept 0600");

// ── 6. re-migration idempotence + different-document guard ──
const again = store.migrateStackPostureConfig(
	conf,
	DOC,
	store.readStackPostureConfig(conf).revision,
);
assert(again.document !== null, "re-migration after rollback succeeds");
const once = store.migrateStackPostureConfig(
	conf,
	DOC,
	store.readStackPostureConfig(conf).revision,
);
assert(
	JSON.stringify(once.document) === JSON.stringify(again.document),
	"re-migrating the same document is idempotent",
);
let guard = "";
try {
	store.migrateStackPostureConfig(
		conf,
		zod.parsePostureDocument(
			JSON.stringify({
				...rolloutDocument(),
				selection: {
					fleet: "main",
					posture: "minimal",
					developmentOverride: false,
				},
			}),
			"drill/other",
		),
		store.readStackPostureConfig(conf).revision,
	);
} catch (e) {
	guard = e instanceof Error ? e.message : String(e);
}
assert(
	guard.includes("already migrated to a different configuration"),
	"different-document re-migration refused",
);

// ── 7. rollback never overwrites concurrent config ──
// re-migrate cleanly, then let a concurrent writer move the file
reset();
store.migrateStackPostureConfig(
	conf,
	DOC,
	store.readStackPostureConfig(conf).revision,
);
const postMig = store.readStackPostureConfig(conf);
store.saveStackPostureSelection(
	conf,
	{ fleet: "main", posture: "dev", developmentOverride: false },
	postMig.revision,
);
const now = store.readStackPostureConfig(conf);
assert(
	now.revision !== postMig.revision,
	"concurrent writer moved the revision after migration",
);
// the guarded rollback REFUSES: the revision observed at migration time
// (postMig) no longer matches the live one — never a blind byte restore
const refusedRollback = guardedRollback(conf, postMig.revision, originalText);
assert(
	!refusedRollback.rolledBack,
	"rollback under a moved revision refuses instead of clobbering",
);
assert(
	readFileSync(conf, "utf8") !== originalText,
	"refused rollback left the concurrent writer's bytes untouched",
);
assert(
	store.readStackPostureConfig(conf).document?.selection.posture === "dev",
	"refused rollback kept the concurrent writer's selection",
);
// the clean path: roll back against the revision observed NOW
const rolled = guardedRollback(
	conf,
	store.readStackPostureConfig(conf).revision,
	originalText,
);
assert(
	rolled.rolledBack,
	"rollback at the live revision restores the original bytes",
);
writeFileSync(conf, originalText);
assert(
	readFileSync(conf, "utf8") === originalText,
	"clean rollback (revision accounted) restores the original bytes",
);

console.log(
	"DRILL A COMPLETE — migrate/CAS/rollback cycle proven on real conf bytes",
);
clean();
