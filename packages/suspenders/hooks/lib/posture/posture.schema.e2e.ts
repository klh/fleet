import { expect, test } from "@playwright/test";
import { parsePostureDocument, parsePostureOverlay } from "./posture.zod.ts";
import { postureDocument } from "./posture.fixtures.ts";

test("parses a complete posture document with MAX, integer, OFF, and CAN rules", {
	tag: "@unit",
}, () => {
	expect(
		parsePostureDocument(JSON.stringify(postureDocument()), "machine.json"),
	).toEqual(postureDocument());
});

test("partial rule overlays leave policy absent for inheritance", {
	tag: "@unit",
}, () => {
	const parsed = parsePostureOverlay(
		JSON.stringify({
			version: 1,
			hubs: {
				example: {
					profiles: {
						plaid: { models: { coder: { lanes: 3 } } },
					},
				},
			},
		}),
		"repo/.prefer",
	);

	expect(parsed.hubs?.example?.profiles?.plaid?.models?.coder).toEqual({
		lanes: 3,
	});
});

test("rejects invalid counts, policy, nulls, and extra keys with source paths", {
	tag: "@unit",
}, () => {
	const invalidRules: unknown[] = [
		{ policy: "MAYBE", lanes: 1 },
		{ policy: "MUST", lanes: -1 },
		{ policy: "MUST", lanes: 1.5 },
		{ policy: "MUST", lanes: Number.MAX_SAFE_INTEGER + 1 },
		{ policy: "MUST", lanes: true },
		null,
		{ policy: "MUST", lanes: 1, endpoint: "https://invalid.example" },
	];

	for (const rule of invalidRules) {
		const base = postureDocument();
		const candidate = {
			...base,
			hubs: {
				...base.hubs,
				example: {
					...base.hubs.example,
					profiles: {
						...base.hubs.example.profiles,
						plaid: {
							models: {
								...base.hubs.example.profiles.plaid.models,
								coder: rule,
							},
						},
					},
				},
			},
		};
		expect(() =>
			parsePostureDocument(JSON.stringify(candidate), "settings/postures.json"),
		).toThrow(
			/settings\/postures\.json.*hubs\.example\.profiles\.plaid\.models\.coder/,
		);
	}
});

test("requires complete full model rules and a supported schema version", {
	tag: "@unit",
}, () => {
	const base = postureDocument();
	const missingPolicy = {
		...base,
		hubs: {
			...base.hubs,
			example: {
				...base.hubs.example,
				profiles: {
					...base.hubs.example.profiles,
					plaid: {
						models: {
							...base.hubs.example.profiles.plaid.models,
							coder: { lanes: 4 },
						},
					},
				},
			},
		},
	};
	const unsupported = { ...postureDocument(), version: 2 };

	expect(() =>
		parsePostureDocument(JSON.stringify(missingPolicy), "machine.json"),
	).toThrow(
		/machine\.json.*hubs\.example\.profiles\.plaid\.models\.coder\.policy/,
	);
	expect(() =>
		parsePostureDocument(JSON.stringify(unsupported), "machine.json"),
	).toThrow(/machine\.json.*version/);
});

test("rejects malformed JSON and dotted or prototype-sensitive identifiers", {
	tag: "@unit",
}, () => {
	expect(() => parsePostureDocument("{", "broken.json")).toThrow(
		/broken\.json/,
	);
	expect(() =>
		parsePostureOverlay(
			'{"version":1,"hubs":{"bad.name":{"profiles":{}}}}',
			"repo/.prefer",
		),
	).toThrow(/repo\/\.prefer.*hubs\.bad\.name/);
	expect(() =>
		parsePostureOverlay(
			'{"version":1,"hubs":{"__proto__":{"profiles":{}}}}',
			"repo/.prefer",
		),
	).toThrow(/repo\/\.prefer/);
	expect(Object.prototype).not.toHaveProperty("polluted");
});
