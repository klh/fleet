import {
	existsSync,
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
	migrateStackPostureConfig,
	readStackPostureConfig,
	saveStackPostureSelection,
	writeStackPostureConfig,
} from "./posture.store.ts";
import type { PostureDocument } from "./posture.zod.ts";

const document: PostureDocument = {
	version: 1,
	hubs: {
		example: {
			profiles: {
				minimal: { models: { coder: { policy: "MUST", lanes: 1 } } },
			},
		},
	},
	fleets: { fleet: { postures: { minimal: ["example.minimal"], paused: [] } } },
	selection: { fleet: "fleet", posture: "minimal", developmentOverride: false },
};

let dir: string;
let path: string;
const stack = {
	version: "example-ref",
	hubs: { example: { host: "example.invalid", buckle_port: 4101 } },
	extensions: { nested: { preserve: true } },
};
test.beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "posture-stack-"));
	path = join(dir, "stack.json");
	writeFileSync(path, JSON.stringify(stack), { mode: 0o600 });
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("absence is not a generated default or an implicit migration", {
	tag: "@unit",
}, () => {
	const before = readFileSync(path, "utf8");
	const snapshot = readStackPostureConfig(path);
	expect(snapshot.document).toBeNull();
	expect(() =>
		saveStackPostureSelection(path, document.selection, snapshot.revision),
	).toThrow("has not been migrated");
	expect(() =>
		writeStackPostureConfig(path, document, snapshot.revision),
	).toThrow("use migrateStackPostureConfig");
	expect(existsSync(`${path}.pre-postures.bak.json`)).toBe(false);
	expect(readFileSync(path, "utf8")).toBe(before);
});

test("embeds postures without replacing machine topology or extensions", {
	tag: "@unit",
}, () => {
	const snapshot = readStackPostureConfig(path);
	const migrated = migrateStackPostureConfig(path, document, snapshot.revision);
	const backupPath = `${path}.pre-postures.bak.json`;
	const backup = readFileSync(backupPath, "utf8");
	const saved = writeStackPostureConfig(path, document, migrated.revision);
	expect(saved.document).toEqual(document);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
		...stack,
		postures: document,
	});
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(readFileSync(backupPath, "utf8")).toBe(backup);
});

test("selection persists while all definitions and stack fields survive", {
	tag: "@unit",
}, () => {
	const initial = readStackPostureConfig(path);
	const before = migrateStackPostureConfig(path, document, initial.revision);
	const selection = { ...document.selection, posture: "paused" };
	const saved = saveStackPostureSelection(path, selection, before.revision);
	expect(readStackPostureConfig(path)).toEqual(saved);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
		...stack,
		postures: { ...document, selection },
	});
});

test("an unrelated machine config edit invalidates a selection preview", {
	tag: "@unit",
}, () => {
	const initial = readStackPostureConfig(path);
	const before = migrateStackPostureConfig(path, document, initial.revision);
	const changed = { ...stack, version: "new-ref", postures: document };
	const bytes = JSON.stringify(changed);
	writeFileSync(path, bytes);
	expect(() =>
		saveStackPostureSelection(path, document.selection, before.revision),
	).toThrow("changed since");
	expect(() =>
		writeStackPostureConfig(path, document, before.revision),
	).toThrow("changed since");
	expect(readFileSync(path, "utf8")).toBe(bytes);
});

test("invalid embedded documents and malformed roots are explicit errors", {
	tag: "@unit",
}, () => {
	for (const value of [null, [], { ...stack, postures: null }]) {
		const bytes = JSON.stringify(value);
		writeFileSync(path, bytes);
		expect(() => readStackPostureConfig(path)).toThrow(path);
		expect(readFileSync(path, "utf8")).toBe(bytes);
	}
	writeFileSync(path, "{bad");
	expect(() => readStackPostureConfig(path)).toThrow("invalid JSON");
});

test("unknown selection references cannot alter a machine config", {
	tag: "@unit",
}, () => {
	const before = readStackPostureConfig(path);
	const bytes = readFileSync(path, "utf8");
	expect(() =>
		writeStackPostureConfig(
			path,
			{ ...document, selection: { ...document.selection, posture: "missing" } },
			before.revision,
		),
	).toThrow("missing");
	expect(readFileSync(path, "utf8")).toBe(bytes);
});

test("legacy JSON content is readable but every update writes the JSON name", {
	tag: "@unit",
}, () => {
	const legacyPath = join(dir, "legacy.yaml");
	const target = join(dir, "legacy.json");
	const original = JSON.stringify({ ...stack, postures: document });
	writeFileSync(legacyPath, original, { mode: 0o600 });
	const before = readStackPostureConfig(target);
	const selection = { ...document.selection, posture: "paused" };
	saveStackPostureSelection(legacyPath, selection, before.revision);
	expect(readFileSync(legacyPath, "utf8")).toBe(original);
	expect(readStackPostureConfig(legacyPath).document?.selection).toEqual(
		selection,
	);
	expect(statSync(target).mode & 0o777).toBe(0o600);
	writeFileSync(target, "{bad");
	expect(() => readStackPostureConfig(legacyPath)).toThrow(target);
});
