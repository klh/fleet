// E2E proof — W3056: the write-time schema guard (a patch the schema does
// not know refuses with the offending dotted path and writes NOTHING) and
// the reader's structured invalid→LKG/defaults fallback (the watchdog's
// conf dimension + bus NEED_DECISION feed — never stdout-only).
import { expect, test } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
import { envRestore, envSnapshot, scratchSettingsHome } from "./helpers.ts";
import {
	patchSettings,
	readSettingsFile,
	resetSettingsCache,
	resolveSettings,
	settingsPath,
	writeSettingsDoc,
} from "../src/index.ts";

test.afterEach(() => {
	resetSettingsCache();
});

test("write-time guard: unknown patch key refuses with its path, disk untouched", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ version: "9.9.9-test" });
		const before = readFileSync(w.file, "utf8");
		const bad = patchSettings({ fleet_loop: { bogus_knob: 1 } });
		expect(bad.ok).toBe(false);
		expect(bad.issues.join("\n")).toContain("fleet_loop");
		expect(bad.issues.join("\n")).toContain("bogus_knob");
		expect(readFileSync(w.file, "utf8")).toBe(before);
		const badRoot = writeSettingsDoc({ version: "9.9.9-test", nope: true });
		expect(badRoot.ok).toBe(false);
		expect(badRoot.issues.join("\n")).toContain("nope");
		expect(readFileSync(w.file, "utf8")).toBe(before);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("valid patch deep-merges, validates the RESULT, and lands atomically", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ version: "9.9.9-test", fleet_loop: { lane_target: 3 } });
		const good = patchSettings({ steer: { min_interval_s: 250 } });
		expect(good.ok).toBe(true);
		expect(good.doc).toMatchObject({
			version: "9.9.9-test",
			fleet_loop: { lane_target: 3 },
			steer: { min_interval_s: 250 },
		});
		expect(readSettingsFile(settingsPath())).toMatchObject({
			steer: { min_interval_s: 250 },
		});
		// an invalid RESULT refuses even when the patch itself is plausible:
		// lane_target 999 exceeds the schema ceiling — nothing is written
		const oob = patchSettings({ fleet_loop: { lane_target: 999 } });
		expect(oob.ok).toBe(false);
		expect(oob.issues.join("\n")).toContain("lane_target");
		expect(readSettingsFile(settingsPath())).toMatchObject({
			fleet_loop: { lane_target: 3 },
		});
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("reader fallback is structured on Resolved: usedLkg true, then defaults", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		// a good read banks the LKG snapshot
		w.setFile({ version: "9.9.9-test", fleet_loop: { lane_target: 4 } });
		resetSettingsCache();
		expect(resolveSettings({ mode: "hook" }).fallback).toBeNull();
		// break the file → hook mode falls back and REPORTS it structured
		w.setFile({ bogus_key: 1 });
		resetSettingsCache();
		const r = resolveSettings({ mode: "hook" });
		expect(r.fallback).not.toBeNull();
		expect(r.fallback?.usedLkg).toBe(true);
		expect(r.fallback?.issues.join("\n")).toContain("bogus_key");
		expect(r.settings.fleet_loop.lane_target).toBe(4);
		// no LKG at all → defaults, still loud and structured
		rmSync(w.lkg, { force: true });
		resetSettingsCache();
		const bare = resolveSettings({ mode: "hook" });
		expect(bare.fallback?.usedLkg).toBe(false);
		expect(bare.settings.fleet_loop.lane_target).toBe(6);
	} finally {
		w.clean();
		envRestore(snap);
	}
});
