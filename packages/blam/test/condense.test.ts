// condense.test.ts — W367.1 engine self-checks (spec laws L1-L6) + parity
// pins. The pins are frozen authoring-time bytes from the CURRENT
// suspenders + belt implementations; the parity tests assert blam tier
// output === pinned source bytes on the shared corpus (25 real-brief-
// shaped inputs). See test/fixtures/condense/ + tools/generate-condense-pins.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	condense,
	PROTECT_GRAMMARS,
	type TierSpec,
} from "../src/condense/engine.ts";
import { TIERS, condenseTier, type TierName } from "../src/condense/tiers.ts";
import { CONDENSE_VERSION } from "../src/condense/version.ts";
import { CORPUS } from "./fixtures/condense/corpus.ts";

interface Pin {
	name: string;
	politenessParity: boolean;
	input: string;
	source: { suspenders: string; belt: string };
	blam: { politeness: string; caveman: string; aggressive: string };
	rules: Record<TierName, string[]>;
}

const pinsPayload = JSON.parse(
	readFileSync(
		new URL("./fixtures/condense/pins.json", import.meta.url),
		"utf8",
	),
) as {
	version: string;
	aggressiveLegacyVersion: string;
	pins: Pin[];
};
const PINS = new Map(pinsPayload.pins.map((p) => [p.name, p]));
const TIERS_ALL = ["politeness", "caveman", "aggressive"] as const;

// ─── parity pins (the migration safety net) ──────────────────────────────
describe("W367.1 parity pins", () => {
	test("pins file matches the engine version + corpus (L6)", () => {
		expect(pinsPayload.version).toBe(CONDENSE_VERSION);
		expect(pinsPayload.aggressiveLegacyVersion).toBe("ref-condense/1");
		expect(pinsPayload.pins.length).toBe(CORPUS.length);
	});

	for (const entry of CORPUS) {
		test(`${entry.name}: caveman === suspenders bytes`, () => {
			const pin = PINS.get(entry.name);
			expect(pin).toBeDefined();
			expect(condenseTier("caveman", entry.input).text).toBe(
				pin?.source.suspenders,
			);
			expect(condenseTier("caveman", entry.input).text).toBe(pin?.blam.caveman);
		});
		test(`${entry.name}: aggressive === belt bytes`, () => {
			const pin = PINS.get(entry.name);
			expect(pin).toBeDefined();
			expect(condenseTier("aggressive", entry.input).text).toBe(
				pin?.source.belt,
			);
			expect(condenseTier("aggressive", entry.input).text).toBe(
				pin?.blam.aggressive,
			);
		});
		if (entry.politenessParity) {
			test(`${entry.name}: politeness === suspenders bytes`, () => {
				const pin = PINS.get(entry.name);
				expect(pin).toBeDefined();
				expect(condenseTier("politeness", entry.input).text).toBe(
					pin?.source.suspenders,
				);
			});
		}
	}
});

// ─── L1 protect surface: matched spans survive byte-for-byte ─────────────
describe("L1 protect surface", () => {
	test("politeness+caveman grammar: technical surface survives", () => {
		const spans = [
			"```bash\nbun run build\n```",
			"`prompt.condense`",
			"https://example.com/x?y=1#z",
			"/var/tmp/stale-cache",
			"./scripts/prune.sh",
			"~/dev/dinero-auto/invoice-hunt.ts",
			"src/lib/mod.ts",
			"--dry-run",
			"-x",
			"prompt.log",
		];
		const input = spans.map((s) => `Please keep ${s} verbatim.`).join("\n");
		for (const tier of ["politeness", "caveman"] as const)
			for (const s of spans)
				expect(condenseTier(tier, input).text).toContain(s);
	});

	test("aggressive grammar (belt): blocks/quotes/FORMAT lines survive", () => {
		const spans = [
			'"""\nIt is important to note that the engine is pure.\n"""',
			"```sql\nSELECT the very column FROM t;\n```",
			"<log>\n2026-10-05 please retry the hub push\n</log>",
			"`keep this code`",
			'"please leave this quoted string alone"',
			"<answer>",
			"FORMAT: <answer>",
		];
		const input = spans.join("\n\n");
		const out = condenseTier("aggressive", input).text;
		for (const s of spans) expect(out).toContain(s);
	});

	test("union grammar protects the full L1 surface incl. ~~~ fences", () => {
		const unionTier: TierSpec = {
			...TIERS.caveman,
			name: "caveman-union",
			protect: PROTECT_GRAMMARS.union,
		};
		const spans = [
			"~~~\nprompt.condense = true\n~~~",
			'"""doc"""',
			"<log>x please y</log>",
			"`code`",
			'"quoted please string"',
			"<placeholder>",
			"FORMAT: <answer>",
			"https://example.com/a",
			"./rel/path.ts",
			"--flag",
			"dotted.ident",
		];
		const input = spans.map((s) => `Please keep ${s} intact.`).join("\n");
		const out = condense(input, unionTier).text;
		for (const s of spans) expect(out).toContain(s);
	});
});

// ─── L2 hedge law (W287), executable ─────────────────────────────────────
describe("L2 hedge law (W287)", () => {
	const HEDGES = [
		"just",
		"maybe",
		"only",
		"very",
		"quite",
		"perhaps",
		"really",
	];
	const input =
		"Please keep just maybe only very quite perhaps really in the plan.";

	test("hedges survive politeness + caveman untouched", () => {
		for (const tier of ["politeness", "caveman"] as const) {
			const out = condenseTier(tier, input).text;
			for (const h of HEDGES) expect(out).toContain(h);
		}
	});

	test("aggressive (eval-only) strips just/very/quite/really, keeps maybe/only/perhaps", () => {
		const out = condenseTier("aggressive", input).text;
		for (const h of ["just", "very", "quite", "really"])
			expect(out).not.toMatch(new RegExp(`\\b${h}\\b`, "i"));
		for (const h of ["maybe", "only", "perhaps"])
			expect(out).toMatch(new RegExp(`\\b${h}\\b`, "i"));
	});
});

// ─── L3 invariants ───────────────────────────────────────────────────────
describe("L3 invariants", () => {
	test("numbers, technical terms, imperative verbs survive every tier", () => {
		const input =
			"Pin SQLite to WAL mode, keep port 7799, run hubctl status. Verify the 1500-line limit.";
		const frags = [
			"SQLite",
			"WAL",
			"7799",
			"Pin",
			"run",
			"Verify",
			"1500-line",
		];
		for (const tier of TIERS_ALL) {
			const out = condenseTier(tier, input).text;
			for (const f of frags) expect(out).toContain(f);
		}
	});
});

// ─── L4 idempotence ──────────────────────────────────────────────────────
describe("L4 idempotence", () => {
	for (const tier of TIERS_ALL) {
		test(`condense(condense(x)) === condense(x) for ${tier} over the corpus`, () => {
			for (const entry of CORPUS) {
				const once = condenseTier(tier, entry.input).text;
				expect(condenseTier(tier, once).text).toBe(once);
			}
		});
	}
});

// ─── L5 auditability ─────────────────────────────────────────────────────
describe("L5 auditability", () => {
	test("every pass returns { text, rules: string[] } with namespaced names", () => {
		for (const tier of TIERS_ALL) {
			for (const entry of CORPUS) {
				const r = condenseTier(tier, entry.input);
				expect(typeof r.text).toBe("string");
				expect(Array.isArray(r.rules)).toBe(true);
				for (const name of r.rules)
					expect(name).toMatch(/^[a-z-]+:[a-z0-9-]+$/);
			}
		}
	});

	test("audit names fire as designed", () => {
		expect(
			condenseTier("caveman", "Hi there, please ship it.").rules,
		).toContain("filler:greeting");
		expect(
			condenseTier("caveman", "Although this prompt is long, ship it.").rules,
		).toContain("meta:sentence");
		expect(
			condenseTier(
				"caveman",
				"The swap is mechanical in every package. The swap is mechanical in each package.",
			).rules,
		).toContain("dedupe:sentence");
		expect(
			condenseTier("aggressive", "In order to ship, run it.").rules,
		).toContain("phrase:in-order-to");
		expect(condenseTier("aggressive", "the router is fast").rules).toContain(
			"strip:article-the",
		);
	});

	test("pinned rules-fired lists match the engine", () => {
		for (const entry of CORPUS) {
			const pin = PINS.get(entry.name);
			expect(pin).toBeDefined();
			for (const tier of TIERS_ALL)
				expect(condenseTier(tier, entry.input).rules).toEqual(pin?.rules[tier]);
		}
	});
});

// ─── L6 byte-stability ───────────────────────────────────────────────────
describe("L6 byte-stability", () => {
	test("same input ⇒ byte-identical {text, rules} across runs", () => {
		for (const tier of TIERS_ALL) {
			for (const entry of CORPUS) {
				expect(condenseTier(tier, entry.input)).toEqual(
					condenseTier(tier, entry.input),
				);
			}
		}
	});

	test("aggressive guard: sentinel-carrying input passes through (belt law)", () => {
		const tricky = `${String.fromCharCode(0xe001)}probe${String.fromCharCode(0xe002)}`;
		const r = condenseTier("aggressive", `Please note that ${tricky} stays.`);
		expect(r.text).toBe(`Please note that ${tricky} stays.`);
		expect(r.rules).toEqual([]);
	});
});
