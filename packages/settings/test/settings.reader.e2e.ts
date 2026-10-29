// E2E proof — the reader: nested parse with defaults, unknown key loud,
// env override + once-per-process deprecation, origin tracking, frozen
// values, and the two failure postures (hook LKG / service fail-closed).
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import {
	envRestore,
	envSnapshot,
	scratchSettingsHome,
	tapStderr,
} from "./helpers.ts";
import {
	originOf,
	resetSettingsCache,
	resolveSettings,
	setting,
	SettingsError,
	settings,
} from "@klh/settings";

test.afterEach(() => {
	resetSettingsCache();
});

test("nested file parses and every section fills its defaults", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ version: "9.9.9-test", steer: { min_interval_s: 200 } });
		const r = resolveSettings({ mode: "service" });
		expect(r.settings.steer.min_interval_s).toBe(200);
		expect(r.settings.buckle.retry_after_cap_s).toBe(60);
		expect(r.settings.fleet_loop.lane_target).toBe(6);
		expect(r.settings.consult.feedback.require_on_done).toBe(false);
		expect(r.settings.board.poll_memo_ms).toBe(1000);
		expect(Object.isFrozen(r.settings)).toBe(true);
		expect(existsSync(w.lkg)).toBe(true);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("unknown key fails loud: service throws, hook warns and keeps serving", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ bogus_key: 1 });
		let threw = null;
		try {
			resolveSettings({ mode: "service" });
		} catch (e) {
			threw = e;
		}
		expect(threw).toBeInstanceOf(SettingsError);
		expect(String(threw)).toContain("bogus_key");
		const tap = tapStderr();
		const hooked = resolveSettings({ mode: "hook" });
		const captured = tap.restore();
		expect(hooked.warnings.length).toBeGreaterThan(0);
		expect(captured).toContain("bogus_key");
		expect(captured).toContain("using defaults");
		expect(hooked.settings.gates.max_read_bytes).toBe(40960);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("hook mode falls back to last-known-good on a corrupt file", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ steer: { min_interval_s: 250 } });
		resolveSettings({ mode: "hook" });
		w.writeRaw("{corrupt");
		resetSettingsCache();
		const tap = tapStderr();
		const after = resolveSettings({ mode: "hook" });
		const captured = tap.restore();
		expect(after.settings.steer.min_interval_s).toBe(250);
		expect(captured).toContain("last-known-good");
		let threw = null;
		try {
			resolveSettings({ mode: "service" });
		} catch (e) {
			threw = e;
		}
		expect(threw).not.toBe(null);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("mapped env overrides win and log the deprecation once per process", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ gates: { max_read_bytes: 50000 } });
		process.env.SUSPENDERS_MAX_READ = "99";
		const tap = tapStderr();
		const r = resolveSettings({ mode: "service" });
		const captured = tap.restore();
		expect(r.settings.gates.max_read_bytes).toBe(99);
		expect(originOf(r, "gates.max_read_bytes")).toBe("env:SUSPENDERS_MAX_READ");
		expect(captured).toContain("deprecated");
		expect(captured).toContain("gates.max_read_bytes");
		const tap2 = tapStderr();
		resolveSettings({ mode: "service" });
		expect(tap2.restore()).not.toContain("deprecated");
		process.env.SUSPENDERS_MAX_READ = "notanint";
		resetSettingsCache();
		const bad = resolveSettings({ mode: "service" });
		expect(bad.settings.gates.max_read_bytes).toBe(50000);
		expect(bad.warnings.some((x) => x.includes("not a valid int"))).toBe(true);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("originOf distinguishes default, file, and env", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ gates: { max_read_bytes: 50000 } });
		const r = resolveSettings({ mode: "service" });
		expect(originOf(r, "steer.min_interval_s")).toBe("default");
		expect(originOf(r, "gates.max_read_bytes")).toBe("file");
		process.env.SUSPENDERS_KEV_URL = "http://127.0.0.9:1";
		resetSettingsCache();
		const r2 = resolveSettings({ mode: "service" });
		expect(originOf(r2, "knowledge.kev_url")).toBe("env:SUSPENDERS_KEV_URL");
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("setting() reads one typed leaf; settings() is cached per process", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({});
		expect(setting("board.sync_idle_ms")).toBe(30000);
		const a = settings();
		const b = settings();
		expect(a).toBe(b);
	} finally {
		w.clean();
		envRestore(snap);
	}
});
