// test/install-skill-prune.test.ts — W2177: the clean-install prune selects
// only skills a fleet catalog installed (current, older checkouts, item
// worktrees, the pre-monorepo suspenders repo) — never other sources.
import { describe, expect, test } from "bun:test";
import {
	fleetSkillNames,
	isFleetCatalogSource,
} from "../scripts/install-skill-prune.ts";

const catalog = "/repos/klh/fleet/skills";

describe("W2177 fleet skill prune selection", () => {
	test("current, older and worktree fleet catalogs are fleet-owned", () => {
		expect(isFleetCatalogSource(catalog, catalog)).toBe(true);
		expect(isFleetCatalogSource("/old/clone/fleet/skills", catalog)).toBe(true);
		expect(isFleetCatalogSource("/old/klh/suspenders/skills", catalog)).toBe(
			true,
		);
		expect(
			isFleetCatalogSource("/repos/klh/fleet/.worktrees/W9/skills", catalog),
		).toBe(true);
	});

	test("github and unrelated local sources are never fleet-owned", () => {
		expect(isFleetCatalogSource("klh/skills", catalog)).toBe(false);
		expect(isFleetCatalogSource("obra/superpowers", catalog)).toBe(false);
		expect(isFleetCatalogSource("/home/me/my-skills/skills", catalog)).toBe(
			false,
		);
		expect(isFleetCatalogSource("/repos/fleet/skills/extra", catalog)).toBe(
			false,
		);
	});

	test("selects hangers retired from the catalog alongside live names", () => {
		const lock = {
			skills: {
				plan: { source: catalog },
				"retired-old": { source: "/old/clone/fleet/skills" },
				"writing-plans": { source: "obra/superpowers" },
				"klh-dispatch": { source: "klh/skills" },
				broken: {},
			},
		};
		expect(fleetSkillNames(lock, catalog)).toEqual(["plan", "retired-old"]);
		expect(fleetSkillNames({}, catalog)).toEqual([]);
	});
});
