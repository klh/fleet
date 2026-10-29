// scripts/posture-rollout-drill/drill-drain.ts — W1315.6 drill D: parent vs
// repo .prefer precedence on the INSTALLED tree, and posture switching never
// cancels live lanes (drain semantics).
// Run: bun scripts/posture-rollout-drill/drill-drain.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assert,
	installed,
	rolloutDocument,
	scratchConf,
} from "./rollout-drill.kit.ts";

type AdmissionModule = typeof import("../../hooks/lib/posture/posture.admission.ts");
type StoreModule = typeof import("../../hooks/lib/posture/posture.store.ts");
const admission = await installed<AdmissionModule>(
	"hooks/lib/posture/posture.admission.ts",
);
const storeMod = await installed<StoreModule>("hooks/lib/posture/posture.store.ts");

const { conf, world, reset, clean } = scratchConf("drain");
const repo = join(world, "parent", "repo");
mkdirSync(repo, { recursive: true });
reset();

// fixture: migrated conf selected at `standard` (earlier drills may leave
// the scratch conf at another posture — always CAS back to standard first)
const zod = await installed<typeof import("../../hooks/lib/posture/posture.zod.ts")>(
	"hooks/lib/posture/posture.zod.ts",
);
const DOC = zod.parsePostureDocument(
	JSON.stringify(rolloutDocument()),
	"drill/proposal",
);
const before = storeMod.readStackPostureConfig(conf);
if (!before.document) {
	storeMod.migrateStackPostureConfig(conf, DOC, before.revision);
} else if (before.document.selection.posture !== "standard") {
	storeMod.saveStackPostureSelection(
		conf,
		{ fleet: "main", posture: "standard", developmentOverride: false },
		before.revision,
	);
}
process.env.KLH_STACK = conf;

// ── 1. parent .prefer narrows flash; repo has none ──
const stackMod = await installed<typeof import("../../hooks/lib/stack-config.ts")>(
	"hooks/lib/stack-config.ts",
);
const stack = stackMod.loadStack();
writeFileSync(
	join(world, "parent", ".prefer"),
	JSON.stringify({
		version: 1,
		hubs: {
			local: {
				profiles: { cloud: { models: { "glm-5.3-flash": { lanes: 4 } } } },
			},
		},
	}),
);
const parentOnly = admission.resolveDispatchPosture(stack, repo);
if (!parentOnly) throw new Error("no parent resolution");
assert(
	parentOnly.entries.find((e) => e.model === "glm-5.3-flash")?.lanes === 4,
	"parent .prefer narrows flash to 4 (repo has none)",
);

// ── 2. repo .prefer wins over parent; untouched fields inherit base ──
writeFileSync(
	join(repo, ".prefer"),
	JSON.stringify({
		version: 1,
		hubs: {
			local: {
				profiles: { cloud: { models: { "glm-5.3-flash": { lanes: 1 } } } },
			},
		},
	}),
);
const both = admission.resolveDispatchPosture(stack, repo);
if (!both) throw new Error("no both resolution");
assert(
	both.entries.find((e) => e.model === "glm-5.3-flash")?.lanes === 1,
	"nearest (repo) wins: flash lanes 1, parent's 4 overridden",
);
assert(
	both.entries.find((e) => e.model === "glm-5.3")?.lanes === "MAX",
	"sibling untouched by both layers inherits base",
);
const flashKey = "hubs.local.profiles.cloud.models.glm-5.3-flash.lanes";
assert(
	both.sources[flashKey]?.includes("repo"),
	`provenance points at the repo layer (${both.sources[flashKey]})`,
);

// ── 3. a posture switch never cancels a live lane ──
const govMod = await installed<typeof import("../../hooks/lib/govdb/govdb.ts")>(
	"hooks/lib/govdb/govdb.ts",
);
const store = govMod.openStore(join(world, "governor.db"));
const admitted = admission.admitPostureLaunch({ store, resolved: both, sid: "live-1" });
assert(admitted.ok, "live lane admitted under standard posture");
store.run(
	"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
	"live-1",
	"drain/project",
	Date.now(),
	Date.now(),
);
// switch the base selection to minimal (flash ceiling 2) via the store CAS
storeMod.saveStackPostureSelection(
	conf,
	{ fleet: "main", posture: "minimal", developmentOverride: false },
	storeMod.readStackPostureConfig(conf).revision,
);
const afterSwitch = store
	.query("SELECT state FROM sessions WHERE sid='live-1'")
	.get() as { state: string } | undefined;
assert(
	afterSwitch?.state === "RUNNING",
	"posture switch leaves the live lane RUNNING (drain, not cancel)",
);
// new launches under the NEW posture resolve the minimal composition
const minimal = admission.resolveDispatchPosture(stackMod.loadStack(), repo);
if (!minimal) throw new Error("no minimal resolution");
assert(
	minimal.entries.length === 1 &&
		minimal.entries[0]?.model === "glm-5.3-flash" &&
		minimal.entries[0]?.lanes === 2,
	"new launches resolve the minimal composition (flash MUST 2)",
);
// restore the base selection for later drills
storeMod.saveStackPostureSelection(
	conf,
	{ fleet: "main", posture: "standard", developmentOverride: false },
	storeMod.readStackPostureConfig(conf).revision,
);
store.close();
console.log("DRILL D COMPLETE — precedence + drain semantics on the installed tree");
clean();
