import { createHash } from "node:crypto";
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
	readPostureConfig,
	savePostureSelection,
	writePostureConfig,
} from "./posture.store.ts";
import type { PostureDocument } from "./posture.zod.ts";

const fixture = (): PostureDocument => ({
	version: 1,
	hubs: {
		example: {
			profiles: {
				minimal: { models: { coder: { policy: "MUST", lanes: 1 } } },
			},
		},
	},
	fleets: {
		fleet: { postures: { minimal: ["example.minimal"], paused: [] } },
	},
	selection: {
		fleet: "fleet",
		posture: "minimal",
		developmentOverride: false,
	},
});

let dir: string;
let path: string;
test.beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "posture-store-"));
	path = join(dir, "postures.json");
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("creates a private document and refuses a second create", {
	tag: "@unit",
}, () => {
	const saved = writePostureConfig(path, fixture(), null);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(readPostureConfig(path)).toEqual(saved);
	expect(() => writePostureConfig(path, fixture(), null)).toThrow(
		"changed since",
	);
});

test("persists selection across reads without altering definitions", {
	tag: "@unit",
}, () => {
	const before = writePostureConfig(path, fixture(), null);
	const selection = { ...before.document.selection, posture: "paused" };
	const saved = savePostureSelection(path, selection, before.revision);
	expect(saved.document.selection).toEqual(selection);
	expect(saved.document.hubs).toEqual(before.document.hubs);
	expect(saved.document.fleets).toEqual(before.document.fleets);
	expect(readPostureConfig(path).document.selection).toEqual(selection);
	expect(saved.revision).not.toBe(before.revision);
});

test("rejects stale selection writes without losing intervening changes", {
	tag: "@unit",
}, () => {
	const before = writePostureConfig(path, fixture(), null);
	const current = savePostureSelection(
		path,
		{ ...before.document.selection, developmentOverride: true },
		before.revision,
	);
	expect(() =>
		savePostureSelection(path, before.document.selection, before.revision),
	).toThrow("changed since");
	expect(readPostureConfig(path)).toEqual(current);
});

test("rejects unknown selection references without modifying bytes", {
	tag: "@unit",
}, () => {
	const before = writePostureConfig(path, fixture(), null);
	const bytes = readFileSync(path, "utf8");
	expect(() =>
		savePostureSelection(
			path,
			{ ...before.document.selection, posture: "missing" },
			before.revision,
		),
	).toThrow();
	expect(readFileSync(path, "utf8")).toBe(bytes);
});

test("malformed configuration is never replaced by a default", {
	tag: "@unit",
}, () => {
	writeFileSync(path, "{broken", { mode: 0o600 });
	expect(() => readPostureConfig(path)).toThrow(path);
	expect(() => writePostureConfig(path, fixture(), null)).toThrow();
	expect(readFileSync(path, "utf8")).toBe("{broken");
});

test("revision reflects exact file bytes, not timestamp granularity", {
	tag: "@unit",
}, () => {
	const before = writePostureConfig(path, fixture(), null);
	const bytes = `${readFileSync(path, "utf8")} `;
	writeFileSync(path, bytes);
	expect(readPostureConfig(path).revision).toBe(
		createHash("sha256").update(bytes).digest("hex"),
	);
	expect(() =>
		savePostureSelection(path, before.document.selection, before.revision),
	).toThrow("changed since");
});
