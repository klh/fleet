import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	postureFromLegacyInventory,
	type LegacyPostureInventory,
} from "./posture.migrate.ts";
import { selectPostureEntries } from "./posture.policy.ts";
import { resolvePosture } from "./posture.resolve.ts";
import {
	migrateStackPostureConfig,
	readStackPostureConfig,
} from "./posture.store.ts";

const inventory: LegacyPostureInventory = {
	selection: {
		fleet: "fleet",
		posture: "existing",
		developmentOverride: false,
	},
	entries: [
		{ hub: "example", model: "coder", policy: "MUST", lanes: "MAX" },
		{ hub: "example", model: "dev", policy: "CAN", lanes: 2 },
		{ hub: "other", model: "coder", policy: "MUST", lanes: 1 },
		{ hub: "other", model: "disabled", policy: "OFF", lanes: 3 },
		{ hub: "other", model: "zero", policy: "MUST", lanes: 0 },
	],
};
const document = () =>
	postureFromLegacyInventory(inventory, "explicit-inventory");

test("explicit inventory preserves effective placements, ceilings and CAN replacement", {
	tag: "@unit",
}, () => {
	for (const developmentOverride of [false, true]) {
		const source = {
			...inventory,
			selection: { ...inventory.selection, developmentOverride },
		};
		const resolved = resolvePosture(
			postureFromLegacyInventory(source, "legacy"),
			[],
		);
		expect(resolved.entries).toEqual(inventory.entries);
		expect(selectPostureEntries(resolved, () => true)).toEqual(
			inventory.entries.filter(
				(entry) =>
					entry.policy === (developmentOverride ? "CAN" : "MUST") &&
					entry.lanes !== 0,
			),
		);
	}
});

test("missing hub/model identity or capacity is rejected, not inferred", {
	tag: "@unit",
}, () => {
	for (const key of ["hub", "model", "lanes"] as const) {
		const entry = { ...inventory.entries[0] };
		Reflect.deleteProperty(entry, key);
		expect(() =>
			postureFromLegacyInventory({ ...inventory, entries: [entry] }, "legacy"),
		).toThrow("legacy");
	}
});

test("duplicate inventory entries do not multiply capacity and conflicts fail", {
	tag: "@unit",
}, () => {
	const entry = inventory.entries[0];
	const same = postureFromLegacyInventory(
		{ ...inventory, entries: [entry, entry] },
		"legacy",
	);
	expect(resolvePosture(same, []).entries).toEqual([entry]);
	expect(() =>
		postureFromLegacyInventory(
			{
				...inventory,
				entries: [entry, { ...entry, lanes: 7 }],
			},
			"legacy",
		),
	).toThrow("conflicting legacy rules");
});

test("migration retains exact original bytes privately and is idempotent", {
	tag: "@unit",
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "posture-migration-"));
	try {
		const path = join(dir, "stack.json");
		const originalText = '{ "version": "example-ref", "hubs": {} }\n';
		writeFileSync(path, originalText, { mode: 0o600 });
		const before = readStackPostureConfig(path);
		const saved = migrateStackPostureConfig(path, document(), before.revision);
		const backupPath = `${path}.pre-postures.bak.json`;
		const backupBytes = readFileSync(backupPath, "utf8");
		expect(JSON.parse(backupBytes)).toEqual({
			originalText,
			revision: before.revision,
		});
		expect(statSync(backupPath).mode & 0o777).toBe(0o600);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(migrateStackPostureConfig(path, document(), saved.revision)).toEqual(
			saved,
		);
		expect(readFileSync(backupPath, "utf8")).toBe(backupBytes);
		expect(() =>
			migrateStackPostureConfig(path, document(), before.revision),
		).toThrow("changed since");
		const different = {
			...document(),
			selection: { ...inventory.selection, developmentOverride: true },
		};
		expect(() =>
			migrateStackPostureConfig(path, different, saved.revision),
		).toThrow("already migrated");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a conflicting recovery backup prevents any machine config write", {
	tag: "@unit",
}, () => {
	const dir = mkdtempSync(join(tmpdir(), "posture-migration-conflict-"));
	try {
		const path = join(dir, "stack.json");
		const original = JSON.stringify({ hubs: {} });
		writeFileSync(path, original, { mode: 0o600 });
		writeFileSync(`${path}.pre-postures.bak.json`, "{}", { mode: 0o600 });
		const before = readStackPostureConfig(path);
		expect(() =>
			migrateStackPostureConfig(path, document(), before.revision),
		).toThrow("does not match");
		expect(readFileSync(path, "utf8")).toBe(original);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
