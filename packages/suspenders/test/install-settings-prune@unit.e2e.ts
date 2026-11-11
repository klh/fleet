import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { migrateConf } from "../scripts/install/install-conf-migrate.ts";
import { pruneMachineSettings } from "../scripts/install/install-settings-prune.ts";
import type { StepContext } from "../scripts/install/install-run.ts";
import { pruneSettingsDoc } from "@klh/settings";
import { scratchWorld } from "@klh/test-kit";

/** The stack document the cutover leg migrates (mirrors the W2582 suite). */
const stackDoc = {
	version: "9.9.9",
	hubs: { nas: { host: "kk@nas.example", url: "https://nas.example:4101" } },
	route_preflight: { terminal_origins: ["http://127.0.0.1:11434"] },
	admin: { schemaless: true },
	knowledge: { distill: { enabled: true, model_group: "glm-5.3" } },
	lane_target: 20,
};

/** A settings document covering the stack plus every drift shape W2873
 *  heals: unknown keys at two depths, legacy repo_roots object-record,
 *  legacy decant_db {path} object. */
const driftDoc = {
	version: "9.9.9",
	route_preflight: { terminal_origins: ["http://127.0.0.1:11434"] },
	admin: { schemaless: true },
	knowledge: {
		distill: {
			enabled: true,
			repo_roots: { "/repo/a": true, "/repo/b": {} },
			decant_db: { path: "/data/decant.db" },
		},
		legacy_block: { stale: true },
	},
	fleet_loop: { lane_target: 20 },
	totally_unknown: { nested: 1 },
};

/** A fully-valid settings document (probes clean under validateDoc). */
const coveredDoc = {
	version: "9.9.9",
	route_preflight: { terminal_origins: ["http://127.0.0.1:11434"] },
	admin: { schemaless: true },
	knowledge: { distill: { enabled: true, model_group: "glm-5.3" } },
	fleet_loop: { lane_target: 20 },
};

const confDir = (home: string) => join(home, ".config", "klh");

const writeConf = (home: string, doc: unknown) => {
	mkdirSync(confDir(home), { recursive: true });
	writeFileSync(
		join(confDir(home), "settings.json"),
		`${JSON.stringify(doc, null, 2)}\n`,
		{
			mode: 0o600,
		},
	);
};

const confFile = (home: string) => join(confDir(home), "settings.json");

test.describe("pruneSettingsDoc (pure)", () => {
	test("migrates legacy distill shapes and prunes unknown keys; input untouched", () => {
		const input = structuredClone(driftDoc) as Record<string, unknown>;
		const outcome = pruneSettingsDoc(input);
		expect(outcome.valid).toBe(true);
		expect(outcome.migrated).toEqual([
			"knowledge.distill.repo_roots",
			"knowledge.distill.decant_db",
		]);
		expect(outcome.pruned).toEqual([
			"knowledge.legacy_block",
			"totally_unknown",
		]);
		expect(outcome.doc.knowledge.distill.repo_roots).toEqual([
			"/repo/a",
			"/repo/b",
		]);
		expect(outcome.doc.knowledge.distill.decant_db).toBe("/data/decant.db");
		// pure: the input document was never mutated
		expect(input).toEqual(driftDoc);
	});

	test("already-current values are never touched", () => {
		const outcome = pruneSettingsDoc({
			version: "9.9.9",
			knowledge: {
				distill: {
					repo_roots: ["/repo/a"],
					decant_db: "/data/decant.db",
				},
			},
		});
		expect(outcome.valid).toBe(true);
		expect(outcome.pruned).toEqual([]);
		expect(outcome.migrated).toEqual([]);
	});

	test("drift the map cannot heal fails loud with the surviving issues", () => {
		const outcome = pruneSettingsDoc({
			knowledge: { distill: { decant_db: 42 } },
		});
		expect(outcome.valid).toBe(false);
		expect(outcome.issues.join("; ")).toContain("decant_db");
		expect(outcome.migrated).toEqual([]);
	});
});

test.describe("install prune pass (W2873)", () => {
	test("prunes + migrates 0600, refreshes the LKG snapshot, rerun is current", () => {
		const w = scratchWorld({ prefix: "settings-prune-" });
		try {
			writeConf(w.home, driftDoc);
			const result = pruneMachineSettings(w.home);
			expect(result.status).toBe("ok");
			expect(result.note).toContain("pruned [");
			expect(result.note).toContain("knowledge.distill.repo_roots");
			expect(result.note).toContain("migrated [");
			const file = confFile(w.home);
			const healed = JSON.parse(readFileSync(file, "utf8"));
			expect(healed.knowledge.distill.repo_roots).toEqual([
				"/repo/a",
				"/repo/b",
			]);
			expect(healed.knowledge.distill.decant_db).toBe("/data/decant.db");
			expect(healed.knowledge).not.toHaveProperty("legacy_block");
			expect(healed).not.toHaveProperty("totally_unknown");
			expect(healed.route_preflight).toEqual(driftDoc.route_preflight);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			// the reader's LKG snapshot is refreshed (compact byte format)
			const lkg = join(confDir(w.home), "settings.lkg.json");
			expect(existsSync(lkg)).toBe(true);
			expect(JSON.parse(readFileSync(lkg, "utf8"))).toEqual(healed);
			// idempotent: the second pass is a no-op and the file keeps its bytes
			const before = readFileSync(file, "utf8");
			const rerun = pruneMachineSettings(w.home);
			expect(rerun.status).toBe("ok");
			expect(rerun.note).toContain("current");
			expect(readFileSync(file, "utf8")).toBe(before);
		} finally {
			w.clean();
		}
	});

	test("a fully-valid document is a byte-identical no-op", () => {
		const w = scratchWorld({ prefix: "settings-prune-" });
		try {
			writeConf(w.home, coveredDoc);
			const before = readFileSync(confFile(w.home), "utf8");
			const result = pruneMachineSettings(w.home);
			expect(result.status).toBe("ok");
			expect(result.note).toContain("current");
			expect(readFileSync(confFile(w.home), "utf8")).toBe(before);
			expect(existsSync(join(confDir(w.home), "settings.lkg.json"))).toBe(
				false,
			);
		} finally {
			w.clean();
		}
	});

	test("malformed JSON fails loud and the file keeps its bytes", () => {
		const w = scratchWorld({ prefix: "settings-prune-" });
		try {
			mkdirSync(confDir(w.home), { recursive: true });
			writeFileSync(confFile(w.home), "{ not json\n", { mode: 0o600 });
			const result = pruneMachineSettings(w.home);
			expect(result.status).toBe("failed");
			expect(result.note).toContain("unreadable");
			expect(readFileSync(confFile(w.home), "utf8")).toBe("{ not json\n");
			expect(existsSync(join(confDir(w.home), "settings.lkg.json"))).toBe(
				false,
			);
		} finally {
			w.clean();
		}
	});

	test("drift beyond prune/migrate fails loud and the file keeps its bytes", () => {
		const w = scratchWorld({ prefix: "settings-prune-" });
		try {
			writeConf(w.home, {
				knowledge: { distill: { decant_db: 42, enabled: true } },
			});
			const before = readFileSync(confFile(w.home), "utf8");
			const result = pruneMachineSettings(w.home);
			expect(result.status).toBe("failed");
			expect(result.note).toContain("could not heal");
			expect(result.note).toContain("decant_db");
			expect(readFileSync(confFile(w.home), "utf8")).toBe(before);
		} finally {
			w.clean();
		}
	});

	test("no settings.json is a clean none", () => {
		const w = scratchWorld({ prefix: "settings-prune-" });
		try {
			const result = pruneMachineSettings(w.home);
			expect(result.status).toBe("ok");
			expect(result.note).toContain("none");
			expect(existsSync(join(confDir(w.home), "settings.lkg.json"))).toBe(
				false,
			);
		} finally {
			w.clean();
		}
	});
});

test.describe("migrateConf wiring (W2873)", () => {
	test("migrateConf runs the prune pass after the cutover", async () => {
		const w = scratchWorld({ prefix: "settings-prune-" });
		try {
			mkdirSync(confDir(w.home), { recursive: true });
			writeFileSync(
				join(confDir(w.home), "stack.json"),
				`${JSON.stringify(stackDoc, null, 2)}\n`,
				{
					mode: 0o600,
				},
			);
			writeConf(w.home, driftDoc);
			const ctx = { home: w.home, dryRun: false } as StepContext;
			const result = await migrateConf(ctx);
			expect(result.status).toBe("ok");
			expect(result.note).toContain("settings prune");
			expect(result.note).toContain("pruned [");
			const healed = JSON.parse(readFileSync(confFile(w.home), "utf8"));
			expect(healed.knowledge.distill.repo_roots).toEqual([
				"/repo/a",
				"/repo/b",
			]);
			expect(healed.knowledge.distill.decant_db).toBe("/data/decant.db");
		} finally {
			w.clean();
		}
	});
});
