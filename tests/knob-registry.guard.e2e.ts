// W2470.1 knob-registry guard — the P2 ratchet. Every SUSPENDERS_* knob a
// production .ts file reads MUST resolve to a designated home in
// @klh/settings' KNOB_REGISTRY (conf / secret / plumbing / machine-conf /
// model-plane / internal): a new knob without a row fails here, in the same
// landing as the knob. The env-map site-count ratchet (packages/settings)
// covers mapped knobs' readers; this guard covers knob DECLARATION itself.
// Spec stays annotation-free (W1294); the scanner lives in the helper lib.
import { expect, test } from "@playwright/test";
import {
	knobHome,
	KNOB_REGISTRY,
	plistEnvKnobs,
	scanKnobMentions,
} from "./helpers/knob-registry.lib.ts";

test("every prod SUSPENDERS_* knob resolves to a registry home", () => {
	const hits = scanKnobMentions();
	const undeclared = [...hits.keys()].filter((n) => !knobHome(n)).sort();
	expect(
		undeclared,
		`knob(s) without a designated home — add the KNOB_REGISTRY row (packages/settings/src/settings.knob-registry.ts) in the same landing:\n${undeclared
			.map((n) => `${n} — ${hits.get(n)}`)
			.join("\n")}`,
	).toEqual([]);
});

test("the registry has no dead rows (every row is a live prod knob)", () => {
	// A dropped knob's row must go with it — dead rows rot the map and mask
	// collisions when a name is reused.
	const hits = scanKnobMentions();
	const dead = KNOB_REGISTRY.map((r) => r.env).filter((e) => !hits.has(e));
	expect(dead, "dead registry rows — remove them with the knob").toEqual([]);
});

test("resolver teeth — undeclared fails, families resolve", () => {
	expect(knobHome("SUSPENDERS_W2470_FIXTURE_UNDECLARED")).toBeUndefined();
	expect(knobHome("SUSPENDERS_REVIEW_ROUND_CAP")).toBeDefined();
	expect(knobHome("SUSPENDERS_HUB_NAS_URL")).toBeDefined(); // family prefix
	expect(knobHome("SUSPENDERS_DROP_MAX_FILES")).toBeDefined();
});

test("launchd plist env dicts carry no SUSPENDERS_* knobs", () => {
	// W2470 P2: plist EnvironmentVariables are process plumbing only
	// (PATH/HOME/launch-contract values). A SUSPENDERS_* knob there is an
	// undeclared config surface — the knob's home is the machine conf.
	expect(
		plistEnvKnobs(),
		"plist env dict carries SUSPENDERS_* knobs — move the value to the machine conf (W2470):",
	).toEqual([]);
});
