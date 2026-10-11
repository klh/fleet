// W638 — the auto-install watcher's decision core + the services.yaml
// contract for the com.suspenders.auto-install entry.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
	decideAutoInstall,
	fleetRootOf,
	isVolumeMounted,
	readStamp,
	writeStamp,
	type LaneAuditRow,
} from "./auto-install.ts";
import { loadManifest } from "../install-services.ts";

const ready = {
	volumeMounted: true,
	head: "aaa",
	stamp: "aaa",
	lanes: [] as LaneAuditRow[],
};

test("decide: up-to-date stamp skips", () => {
	expect(decideAutoInstall(ready)).toEqual({
		action: "skip",
		reason: "up-to-date",
	});
});

test("decide: main moved + no lanes → install", () => {
	expect(decideAutoInstall({ ...ready, stamp: "000" })).toEqual({
		action: "install",
	});
});

test("decide: never-installed (null stamp) installs", () => {
	expect(decideAutoInstall({ ...ready, stamp: null })).toEqual({
		action: "install",
	});
});

test("decide: volume unmounted skips first", () => {
	expect(
		decideAutoInstall({
			...ready,
			stamp: "000",
			volumeMounted: false,
		}),
	).toEqual({ action: "skip", reason: "volume-unmounted" });
});

test("decide: git failure skips", () => {
	expect(decideAutoInstall({ ...ready, stamp: "000", head: null })).toEqual({
		action: "skip",
		reason: "git-failed",
	});
});

test("decide: live lane blocks", () => {
	expect(
		decideAutoInstall({
			...ready,
			stamp: "000",
			lanes: [{ sid: "a", live: true }],
		}),
	).toEqual({ action: "skip", reason: "lanes-live:1" });
});

test("decide: unknown liveness blocks (fail closed)", () => {
	expect(
		decideAutoInstall({
			...ready,
			stamp: "000",
			lanes: [{ sid: "a", live: null }],
		}),
	).toEqual({ action: "skip", reason: "lanes-live:1" });
});

test("decide: registry unreadable blocks", () => {
	expect(decideAutoInstall({ ...ready, stamp: "000", lanes: null })).toEqual({
		action: "skip",
		reason: "lanes-registry-unreadable",
	});
});

test("decide: dead lanes clear the way", () => {
	expect(
		decideAutoInstall({
			...ready,
			stamp: "000",
			lanes: [
				{ sid: "a", live: false },
				{ sid: "b", live: false },
			],
		}),
	).toEqual({ action: "install" });
});

test("volume: stat throw = unmounted", () => {
	expect(
		isVolumeMounted("/x", () => {
			throw new Error("gone");
		}),
	).toBe(false);
});

test("volume: not under /Volumes = mounted", () => {
	expect(isVolumeMounted("/Users/kk/x", () => ({ dev: 1 }))).toBe(true);
});

test("volume: stale automount dir (dev == /Volumes) = unmounted", () => {
	const stat = () => ({ dev: 1 });
	expect(isVolumeMounted("/Volumes/Sensitive/github/klh/fleet", stat)).toBe(
		false,
	);
});

test("volume: real mount (dev differs) = mounted", () => {
	const stat = (p: string) => ({ dev: p === "/Volumes" ? 1 : 2 });
	expect(isVolumeMounted("/Volumes/Sensitive/github/klh/fleet", stat)).toBe(
		true,
	);
});

test("fleetRootOf: package path → monorepo root", () => {
	expect(fleetRootOf("/r/packages/suspenders")).toBe("/r");
});

test("fleetRootOf: non-package path → itself", () => {
	expect(fleetRootOf("/r")).toBe("/r");
});

test("stamp: roundtrip + garbage → null", () => {
	const dir = mkdtempSync(join(tmpdir(), "auto-install-test-"));
	try {
		const path = join(dir, "nested", "stamp.json");
		expect(readStamp(path)).toBeNull();
		writeStamp(path, "abc123");
		expect(readStamp(path)?.main).toBe("abc123");
		writeFileSync(path, "{oops");
		expect(readStamp(path)).toBeNull();
		expect(readFileSync(path, "utf8")).toContain("{oops");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("manifest: auto-install entry honors the render contract", () => {
	const svc = loadManifest().find((s) => s.name === "auto-install");
	expect(svc).toBeDefined();
	expect(svc?.bunEntry).toBe("__PREFIX__/scripts/auto-install.ts");
	expect(svc?.schedule?.intervalSeconds).toBe(300);
	expect(svc?.args).toContain("__REPO__");
	expect(svc?.placeholders).toEqual(
		expect.arrayContaining(["__BUN__", "__HOME__", "__PREFIX__", "__REPO__"]),
	);
});
