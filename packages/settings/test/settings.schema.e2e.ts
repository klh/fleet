// E2E proof — schema currency + fork A–G keys + hubs map semantics.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envRestore, envSnapshot, scratchSettingsHome } from "./helpers.ts";
import {
	renderHubSettings,
	resetSettingsCache,
	resolveSettings,
	settingsJsonSchemaText,
} from "@klh/settings";

test.afterEach(() => {
	resetSettingsCache();
});

test("the committed settings.schema.json is current with the schema", () => {
	const pkg = import.meta.dir;
	const committed = JSON.parse(
		readFileSync(join(pkg, "..", "settings.schema.json"), "utf8"),
	);
	const fresh = JSON.parse(settingsJsonSchemaText());
	expect(committed).toEqual(fresh);
});

test("fork A-G keys pre-registered with their agreed defaults", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		w.setFile({});
		const s = resolveSettings({ mode: "service" }).settings;
		expect(s.consult.feedback.require_on_done).toBe(false);
		expect(s.consult.interrupt.min_interval_s).toBe(180);
		expect(s.steer.min_interval_s).toBe(180);
		expect(s.knowledge.downvote_threshold).toBe(2);
		expect(s.knowledge.distill.enabled).toBe(false);
		expect(s.fleet_loop.lane_target).toBe(6);
		expect(s.board.poll_memo_ms).toBe(1000);
		expect(s.board.sync_floor_ms).toBe(5000);
		expect(s.board.sync_idle_ms).toBe(30000);
		expect(s.buckle.retry_after_cap_s).toBe(60);
		expect(s.buckle.quota_wall_codes).toEqual(["1113"]);
		expect(s.buckle.concurrency_error_codes).toEqual(["1302", "1305"]);
	} finally {
		w.clean();
		envRestore(snap);
	}
});

test("hub overlay renders through the schema; unknown label lists knowns", () => {
	const w = scratchSettingsHome();
	const snap = envSnapshot();
	try {
		process.env.KLH_SETTINGS = w.file;
		const machine = {
			steer: { min_interval_s: 180 },
			hubs: {
				nas: {
					role: "remote",
					settings: { steer: { min_interval_s: 299 } },
				},
			},
		};
		const r = renderHubSettings(machine, "nas");
		expect(r.ok).toBe(true);
		expect(r.doc.steer.min_interval_s).toBe(299);
		expect(r.doc.hubs.nas.role).toBe("remote");
		const bad = renderHubSettings(machine, "bogus");
		expect(bad.ok).toBe(false);
		expect(bad.issues.join(" ")).toContain("nas");
		const hijack = renderHubSettings(
			{ hubs: { x: { settings: { hubs: {} } } } },
			"x",
		);
		expect(hijack.ok).toBe(false);
	} finally {
		w.clean();
		envRestore(snap);
	}
});
