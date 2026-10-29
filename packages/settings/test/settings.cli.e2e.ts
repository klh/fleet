// E2E proof — the CLI: get/set/unset/validate/show/schema/migrate/render-hub.
// Every write validates the WHOLE document and lands atomically at 0600;
// a refused `set` leaves the file byte-identical.
import { expect, test } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import {
	collectIo,
	envRestore,
	envSnapshot,
	readIfPresent,
	scratchSettingsHome,
	writeMigrateFixtures,
} from "./helpers.ts";
import { resetSettingsCache, runSettingsCli } from "../src/index.ts";

test.afterEach(() => {
	resetSettingsCache();
});

test("set writes a valid change and refuses an out-of-bounds one atomically", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.HOME = w.home;
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ steer: { min_interval_s: 180 } });
		const io = collectIo();
		const ok = runSettingsCli(["set", "steer.min_interval_s", "200"], io);
		expect(ok).toBe(0);
		const doc = JSON.parse(readIfPresent(w.file));
		expect(doc.steer.min_interval_s).toBe(200);
		const before = readIfPresent(w.file);
		const bad = runSettingsCli(["set", "steer.min_interval_s", "9999"], io);
		expect(bad).toBe(1);
		expect(io.errs.join("")).toContain("refused");
		expect(readIfPresent(w.file)).toBe(before);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("get returns the effective leaf; an unknown path exits 1", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.HOME = w.home;
		process.env.KLH_SETTINGS = w.file;
		w.setFile({});
		const io = collectIo();
		expect(runSettingsCli(["get", "steer.min_interval_s"], io)).toBe(0);
		expect(io.outs.join("")).toContain("180");
		expect(runSettingsCli(["get", "no.such.path"], io)).toBe(1);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("validate: 0 on a good doc, 1 with the loud issue on a bad one", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.HOME = w.home;
		process.env.KLH_SETTINGS = w.file;
		w.setFile({ board: { poll_memo_ms: 10 } });
		const io = collectIo();
		expect(runSettingsCli(["validate"], io)).toBe(0);
		expect(io.outs.join("")).toContain("valid");
		w.setFile({ board: { poll_memo_ms: -5 } });
		const io2 = collectIo();
		expect(runSettingsCli(["validate"], io2)).toBe(1);
		expect(io2.errs.join("")).toContain("invalid");
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("migrate round-trips stack.json + hubs.json under the same label", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.HOME = w.home;
		process.env.KLH_SETTINGS = w.file;
		const fx = writeMigrateFixtures(w);
		const io = collectIo();
		const args = [
			"migrate",
			"--stack",
			fx.stack,
			"--hubs",
			fx.hubs,
			"--env-file",
			fx.env,
		];
		expect(runSettingsCli(args, io)).toBe(0);
		const doc = JSON.parse(readIfPresent(w.file));
		expect(doc.version).toBe("3.3.3");
		expect(doc.hubs.nas.candidates).toEqual([
			"https://nas-a.example:4101",
			"https://nas-b.example:4101",
		]);
		// inline token lifted to a 0600 file; the doc holds only its path
		expect(doc.hubs.nas.token_file).toBeTruthy();
		expect(doc.hubs.nas.token).toBeUndefined();
		expect(readFileSync(doc.hubs.nas.token_file, "utf8").trim()).toBe(
			"tok-inline-123",
		);
		// env knob migrated into the doc; stack.json kept as .bak
		expect(doc.fleet_loop.maintenance).toBe(false);
		expect(existsSync(`${fx.stack}.bak`)).toBe(true);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("render-hub applies the overlay through the schema; unknown label refuses", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.HOME = w.home;
		process.env.KLH_SETTINGS = w.file;
		w.setFile({
			board: { sync_floor_ms: 5000 },
			hubs: {
				nas: {
					settings: { board: { sync_floor_ms: 900 } },
				},
			},
		});
		const io = collectIo();
		expect(runSettingsCli(["render-hub", "nas"], io)).toBe(0);
		const rendered = JSON.parse(io.outs.join(""));
		// the overlay won; absent keys stay absent (the schema fills
		// defaults at READ time, the rendered file stays compact)
		expect(rendered.board.sync_floor_ms).toBe(900);
		expect(rendered.board.sync_idle_ms).toBeUndefined();
		const io2 = collectIo();
		expect(runSettingsCli(["render-hub", "nope"], io2)).toBe(1);
		expect(io2.errs.join("")).toContain("nope");
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("schema prints JSON Schema; --write drops it beside the settings file", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.HOME = w.home;
		process.env.KLH_SETTINGS = w.file;
		w.setFile({});
		const io = collectIo();
		expect(runSettingsCli(["schema"], io)).toBe(0);
		const printed = JSON.parse(io.outs.join(""));
		expect(printed.$schema).toContain("json-schema.org");
		expect(runSettingsCli(["schema", "--write"], io)).toBe(0);
		const written = JSON.parse(readIfPresent(w.schema));
		expect(written.$schema).toContain("json-schema.org");
	} finally {
		w.clean();
		envRestore(snap);
	}
});
