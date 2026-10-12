// generate-condense-pins.ts — W367.1 authoring-time pin generator.
// Runs the CURRENT suspenders + belt implementations over the shared
// corpus, cross-checks the blam tiers byte-for-byte, and freezes
// per-tier expected outputs + rules-fired audit lists as data
// (test/fixtures/condense/pins.json). Run from packages/blam:
//
//   bun tools/generate-condense-pins.ts
//
// Any mismatch is a build error — fix the tier tables (src/condense/),
// never the parity sources.
import { condense as beltCondense } from "@klh/belt/bench/arena/condense.ts";
import { condensePrompt } from "@klh/suspenders/hooks/board/prompt-transform.ts";
import { TIERS } from "../src/condense/tiers.ts";
import { condense } from "../src/condense/engine.ts";
import { CONDENSE_VERSION } from "../src/condense/version.ts";
import { CORPUS } from "../test/fixtures/condense/corpus.ts";

interface Pin {
	name: string;
	politenessParity: boolean;
	input: string;
	source: { suspenders: string; belt: string };
	blam: { politeness: string; caveman: string; aggressive: string };
	rules: Record<"politeness" | "caveman" | "aggressive", string[]>;
}

const pins: Pin[] = [];
let failures = 0;
const fail = (entry: string, what: string, got: string, want: string): void => {
	failures++;
	console.error(`PIN MISMATCH [${entry}] ${what}`);
	console.error(`  want: ${JSON.stringify(want)}`);
	console.error(`  got:  ${JSON.stringify(got)}`);
};

for (const entry of CORPUS) {
	const suspenders = condensePrompt(entry.input);
	const belt = beltCondense(entry.input);
	const politeness = condense(entry.input, TIERS.politeness);
	const caveman = condense(entry.input, TIERS.caveman);
	const aggressive = condense(entry.input, TIERS.aggressive);
	if (caveman.text !== suspenders)
		fail(entry.name, "caveman === suspenders", caveman.text, suspenders);
	if (aggressive.text !== belt)
		fail(entry.name, "aggressive === belt", aggressive.text, belt);
	if (entry.politenessParity && politeness.text !== suspenders)
		fail(entry.name, "politeness === suspenders", politeness.text, suspenders);
	pins.push({
		name: entry.name,
		politenessParity: entry.politenessParity,
		input: entry.input,
		source: { suspenders, belt },
		blam: {
			politeness: politeness.text,
			caveman: caveman.text,
			aggressive: aggressive.text,
		},
		rules: {
			politeness: politeness.rules,
			caveman: caveman.rules,
			aggressive: aggressive.rules,
		},
	});
}
if (failures > 0) {
	console.error(
		`${failures} parity pin(s) failed — fix src/condense/, never the sources`,
	);
	process.exit(1);
}
const payload = {
	version: CONDENSE_VERSION,
	aggressiveLegacyVersion: "ref-condense/1",
	generated: "authoring-time, W367.1",
	pins,
};
await Bun.write(
	new URL("../test/fixtures/condense/pins.json", import.meta.url),
	`${JSON.stringify(payload, null, "\t")}\n`,
);
console.log(
	`pins written: ${pins.length} entries, version ${CONDENSE_VERSION}`,
);
