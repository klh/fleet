import { expect, test } from "bun:test";
import { readEffectiveUpstreams } from "../hooks/board/console-upstreams.ts";

test("machine override replaces groups, adds aliases, preserves defaults and never exposes credentials", () => {
	const base =
		"groups:\n  flash: [{url: 'http://base', dialect: anthropic}]\n  local: [{url: 'http://local', dialect: openai}]\n";
	const override =
		"groups:\n  flash: [{url: 'http://a'}, {url: 'http://b'}, {url: 'http://c'}, {url: 'http://d'}]\n  zai-fast: [{api_key: private-secret, url: 'https://provider'}]\n  dormant: []\n";
	const result = readEffectiveUpstreams({
		basePath: "base",
		overridePath: "runtime",
		hasFile: () => true,
		readFile: (path) => (path === "base" ? base : override),
	});
	expect(result?.groups).toEqual([
		{ name: "flash", tiers: 4, dormant: false, source: "machine override" },
		{ name: "local", tiers: 1, dormant: false, source: "fleet default" },
		{ name: "zai-fast", tiers: 1, dormant: false, source: "machine override" },
		{ name: "dormant", tiers: 0, dormant: true, source: "machine override" },
	]);
	expect(result?.source).toBe("fleet default + machine override");
	expect(JSON.stringify(result)).not.toContain("private-secret");
	expect(JSON.stringify(result)).not.toContain("https://provider");
});

test("unreadable or malformed selected override never silently shows the base as effective", () => {
	for (const override of ["groups: invalid", "groups: {broken: nope}"]) {
		expect(
			readEffectiveUpstreams({
				basePath: "base",
				overridePath: "runtime",
				hasFile: () => true,
				readFile: (path) =>
					path === "base" ? "groups: {default: []}" : override,
			}),
		).toBeNull();
	}
	expect(
		readEffectiveUpstreams({
			basePath: "base",
			overridePath: "runtime",
			hasFile: () => true,
			readFile: (path) => {
				if (path === "runtime") throw new Error("unreadable");
				return "groups: {default: []}";
			},
		}),
	).toBeNull();
});

test("absent override retains base including explicit dormant groups", () => {
	expect(
		readEffectiveUpstreams({
			basePath: "base",
			overridePath: "absent",
			hasFile: () => false,
			readFile: () => "groups: {disabled: []}",
		}),
	).toEqual({
		groups: [
			{ name: "disabled", tiers: 0, dormant: true, source: "fleet default" },
		],
		source: "fleet default",
	});
});
