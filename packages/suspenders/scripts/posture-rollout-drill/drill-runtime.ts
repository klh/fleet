// scripts/posture-rollout-drill/drill-runtime.ts — W1315.6 drill B: the
// INSTALLED runtime tree consumes a migrated posture config — dispatch
// resolution (stack.json + .prefer layers), admission with shared
// cross-project ceilings, OFF/CAN/MUST semantics, no unlisted fallback.
// Run: bun scripts/posture-rollout-drill/drill-runtime.ts
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

const { conf, reset, clean } = scratchConf("runtime");
const world = join(conf, "..");
const repo = join(world, "repo");
mkdirSync(repo, { recursive: true });
reset();

// ── fixture: drill conf migrated to the W1315.6 proposal document ──
type ZodModule = typeof import("../../hooks/lib/posture/posture.zod.ts");
const zod = await installed<ZodModule>("hooks/lib/posture/posture.zod.ts");
const DOC = zod.parsePostureDocument(
	JSON.stringify(rolloutDocument()),
	"drill/proposal",
);
const before = storeMod.readStackPostureConfig(conf);
if (!before.document)
	storeMod.migrateStackPostureConfig(conf, DOC, before.revision);
process.env.KLH_STACK = conf;

// ── 1. installed loadStack sees the postures through KLH_STACK ──
type StackModule = typeof import("../../hooks/lib/stack-config.ts");
const stackMod = await installed<StackModule>("hooks/lib/stack-config.ts");
const stack = stackMod.loadStack();
assert(
	JSON.stringify(admission.stackPostureDocument(stack)) === JSON.stringify(DOC),
	"installed loadStack + stackPostureDocument returns the migrated document",
);

// ── 2. dispatch resolution: base entries, must-set parity ──
const resolved = admission.resolveDispatchPosture(stack, repo);
if (!resolved) throw new Error("no resolved posture");
assert(
	resolved.entries.length === 4 &&
		resolved.entries[0]?.model === "glm-5.3-flash" &&
		resolved.entries.every((e) => e.hub === "local"),
	`resolved entries = ${resolved.entries.map((e) => `${e.policy}:${e.model}`).join(" ")}`,
);
assert(
	resolved.entries.filter((e) => e.policy === "MUST").length === 3 &&
		resolved.entries.filter((e) => e.policy === "CAN").length === 1,
	"MUST set = flash/5.3/5.2, CAN = glm-4.5-air (mirrors legacy must set)",
);

// ── 3. .prefer precedence: a nearer JSON overlay overrides lanes only ──
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
const overridden = admission.resolveDispatchPosture(stack, repo);
if (!overridden) throw new Error("override resolution null");
const flash = overridden.entries.find((e) => e.model === "glm-5.3-flash");
assert(
	flash?.lanes === 1 && flash?.policy === "MUST",
	"repo .prefer narrows flash to lanes:1, policy inherited",
);
const g53 = overridden.entries.find((e) => e.model === "glm-5.3");
assert(
	g53?.lanes === "MAX",
	"untouched sibling inherits base MAX (nearest changes only its field)",
);

// ── 4. admission — shared cross-project ceilings, first-fit fallback ──
const dbPath = join(world, "governor.db");
const govMod = await installed<typeof import("../../hooks/lib/govdb/govdb.ts")>(
	"hooks/lib/govdb/govdb.ts",
);
const store = govMod.openStore(dbPath);
const first = admission.admitPostureLaunch({ store, resolved: overridden, sid: "b1" });
assert(first.ok, "first launch admitted under ceiling 1");
store.run(
	"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
	"x-foreign",
	"some/other-project",
	Date.now(),
	Date.now(),
);
store.run(
	"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'dispatch', 1, ?)",
	"lane.x-foreign.entry",
	admission.entryKey({ hub: "local", model: "glm-5.3-flash" }),
	Date.now(),
);
// flash-only eligible set: the shared ceiling (b1's claim + the foreign
// RUNNING lane) must block with no unlisted fallback
const flashOnly = {
	...overridden,
	entries: overridden.entries.filter((e) => e.model === "glm-5.3-flash"),
};
const second = admission.admitPostureLaunch({ store, resolved: flashOnly, sid: "b2" });
assert(
	!second.ok && second.reason.includes("ceilings exhausted"),
	"flash-only launch blocked — shared cross-project ceiling, no unlisted fallback",
);
// full set: flash full → first-fit lands b3 on the next MUST entry
const third = admission.admitPostureLaunch({ store, resolved: overridden, sid: "b3" });
assert(
	third.ok && third.entry.model === "glm-5.3",
	`next eligible MUST entry admits: ${third.ok ? third.entry.model : "BLOCKED"}`,
);

// ── 5. OFF/0 excluded; CAN override replaces MUST; no unlisted fallback ──
const offResolved = {
	...overridden,
	entries: overridden.entries.map((e) =>
		e.model === "glm-5.3-flash" ? { ...e, policy: "OFF" } : e,
	),
};
const offPick = admission.admitPostureLaunch({ store, resolved: offResolved, sid: "b4" });
assert(
	offPick.ok && offPick.entry.model !== "glm-5.3-flash",
	"OFF entry never admitted",
);
const canOnly = {
	...overridden,
	selection: { ...overridden.selection, developmentOverride: true },
};
const canPick = admission.admitPostureLaunch({ store, resolved: canOnly, sid: "b5" });
assert(
	canPick.ok && canPick.entry.policy === "CAN",
	`developmentOverride selects the CAN entry: ${canPick.ok ? canPick.entry.model : "BLOCKED"}`,
);
const exhausted = {
	...overridden,
	entries: [
		{ hub: "local", model: "glm-5.3-flash", policy: "MUST", lanes: 0 },
	],
};
const blocked = admission.admitPostureLaunch({ store, resolved: exhausted, sid: "b6" });
assert(
	!blocked.ok &&
		blocked.reason.includes("no usable entry") &&
		!blocked.reason.includes("zai") &&
		!blocked.reason.includes("copilot"),
	"lanes:0 with everything else disabled → blocked, never an unlisted fallback",
);

store.close();
console.log("DRILL B COMPLETE — installed tree resolves + admits the posture config");
clean();
