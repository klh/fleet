// scripts/posture-rollout-drill/drill-composition.ts — W1315.6.1 drill E:
// composition-conflict detection — two referenced profiles defining the
// same (hub, model) with different rules must be detected and surfaced
// with both contributing references, never silently merged.
// Run: bun scripts/posture-rollout-drill/drill-composition.ts
import { assert, installed, rolloutDocument } from "./rollout-drill.kit.ts";

type ResolveModule =
	typeof import("../../hooks/lib/posture/posture.resolve.ts");
const resolve = await installed<ResolveModule>(
	"hooks/lib/posture/posture.resolve.ts",
);
type ZodModule = typeof import("../../hooks/lib/posture/posture.zod.ts");
const zod = await installed<ZodModule>("hooks/lib/posture/posture.zod.ts");

// the W1315.6 proposal composed CONFLICTINGLY: selection.dev references
// local.cloud + local.canary — both define glm-4.5-air with different
// ceilings (CAN MAX vs CAN 1). This is the exact composition the W1315.6
// rollout review caught in the proposal's first draft.
const conflicting = {
	...rolloutDocument(),
	selection: { fleet: "main", posture: "dev", developmentOverride: false },
	fleets: {
		main: {
			postures: {
				standard: ["local.cloud"],
				minimal: ["local.minimal"],
				dev: ["local.cloud", "local.canary"],
			},
		},
	},
};

let conflict = "";
try {
	resolve.resolvePosture(
		zod.parsePostureDocument(JSON.stringify(conflicting), "drill/composition"),
		[],
	);
} catch (e) {
	conflict = e instanceof Error ? e.message : String(e);
}
assert(conflict.length > 0, "the conflicting composition is rejected");
assert(
	conflict.includes("conflicting rules for local.glm-4.5-air"),
	`the error names the conflicting model (${conflict})`,
);
assert(
	conflict.includes("local.cloud") && conflict.includes("local.canary"),
	"the error surfaces BOTH contributing profile references",
);

// contrast: the shipped (non-conflicting) proposal document resolves
// cleanly — dev = [local.minimal, local.canary] has no model overlap.
const resolved = resolve.resolvePosture(
	zod.parsePostureDocument(
		JSON.stringify(rolloutDocument()),
		"drill/composition",
	),
	[],
);
assert(
	resolved.entries.length === 4,
	"the shipped non-conflicting document still resolves (4 entries)",
);

console.log(
	"DRILL E COMPLETE — composition conflicts detected + surfaced with sources",
);
