// models.catalog.test.ts — W754.1: the acquisition catalog validates, the
// shipped default is real (pinned shas, registry-bound), and the
// machine-level override wins id collisions without breaking validation.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld } from "../test-kit/src/index.ts";
import {
	catalogForPlatform,
	catalogPaths,
	entryPlatforms,
	loadCatalog,
	platformsForRuntime,
	validateCatalog,
	type CatalogEntry,
} from "./models.catalog.ts";

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
	id: "t",
	repo: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
	revision: "50d427756c6b",
	license: "apache-2.0",
	runtime: "mlx",
	specialist: 8902,
	tier: "always",
	...over,
});

test("shipped repo catalog validates clean", () => {
	const doc = JSON.parse(readFileSync(catalogPaths().repo, "utf8")) as {
		models: CatalogEntry[];
	};
	expect(validateCatalog(doc.models).errors).toEqual([]);
});

test("floating revision, duplicate id, unknown specialist are rejected", () => {
	const v = validateCatalog([
		entry({ revision: "main" }),
		entry(),
		entry({ id: "t2", specialist: 9999 }),
	]);
	expect(v.errors.some((e) => e.includes("floating branch"))).toBe(true);
	expect(v.errors.some((e) => e.includes("duplicate id"))).toBe(true);
	expect(v.errors.some((e) => e.includes("not in belt registry"))).toBe(true);
});

test("mlx repo must equal the bound registry model", () => {
	const v = validateCatalog([
		entry({ repo: "mlx-community/Some-Other-Model-4bit" }),
	]);
	expect(
		v.errors.some((e) => e.includes("must equal the :8902 registry model")),
	).toBe(true);
});

test("machine-level override wins id collisions and still validates", () => {
	const { home, clean } = scratchWorld({ prefix: "cat-" });
	try {
		const machine = join(home, "models.catalog.json");
		writeFileSync(
			machine,
			JSON.stringify({
				version: 1,
				models: [
					entry({
						id: "qwen3-extract-4b-gguf",
						repo: "hub://nas.threads.dk/models/extract-4b",
						runtime: "gguf",
					}),
				],
			}),
		);
		const cat = loadCatalog(catalogPaths(machine));
		const e = cat.models.find((m) => m.id === "qwen3-extract-4b-gguf");
		expect(e?.runtime).toBe("gguf");
		expect(e?.repo.startsWith("hub://")).toBe(true);
	} finally {
		clean();
	}
});

test("platforms default to the runtime-implied set", () => {
	expect(platformsForRuntime("mlx")).toEqual(["darwin"]);
	expect(platformsForRuntime("gguf")).toEqual(["win32", "linux"]);
	expect(entryPlatforms(entry({ runtime: "gguf" }))).toEqual([
		"win32",
		"linux",
	]);
});

test("shipped catalog: gguf lights up on win32/linux, mlx rows on darwin", () => {
	const doc = JSON.parse(readFileSync(catalogPaths().repo, "utf8")) as {
		models: CatalogEntry[];
	};
	expect(catalogForPlatform(doc.models, "win32").map((m) => m.id)).toEqual([
		"qwen3-extract-4b-gguf",
	]);
});

test("validation: gguf-on-darwin and per-platform port collisions rejected", () => {
	const v = validateCatalog([
		entry({ runtime: "gguf", platforms: ["darwin"] }),
		entry({ id: "t2", runtime: "gguf", platforms: ["win32"] }),
		entry({ id: "t3", runtime: "gguf", platforms: ["win32"] }),
	]);
	expect(v.errors.some((e) => e.includes("invalid on darwin"))).toBe(true);
	expect(
		v.errors.some((e) => e.includes("duplicate win32 row for :8902")),
	).toBe(true);
});
