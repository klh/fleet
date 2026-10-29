// test/fleet-loop-central-config.e2e.ts — W2242: the fleet-loop daemon's
// lane target + cadence come from the machine stack conf's fleet_loop
// block (config-over-code; the launchd plist hardcodes nothing), and a
// dedicated watcher hot-applies changes without a restart.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopConfigWatch } from "../hooks/lib/fleet-loop/loop-config-watch.ts";
import {
	FLEET_LOOP_DEFAULTS,
	fleetLoopSettings,
} from "../hooks/lib/stack-config.ts";

const tmpConf = (): string => mkdtempSync(join(tmpdir(), "w2242-stack-"));

test.describe("fleet_loop central config (W2242) @unit", () => {
	test("fleetLoopSettings: defaults when the block is absent", () => {
		expect(fleetLoopSettings(null)).toEqual(FLEET_LOOP_DEFAULTS);
	});

	test("fleetLoopSettings: block fields resolve over the defaults", () => {
		expect(
			fleetLoopSettings({
				hubs: {},
				fleet_loop: { lane_target: 20, every_s: 60 },
			}),
		).toEqual({
			laneTarget: 20,
			dispatchTarget: FLEET_LOOP_DEFAULTS.dispatchTarget,
			everyS: 60,
			pollS: FLEET_LOOP_DEFAULTS.pollS,
		});
	});

	test("config edit → watcher hot-applies the new target within the poll interval, no restart", async () => {
		const dir = tmpConf();
		const conf = join(dir, "stack.json");
		writeFileSync(conf, JSON.stringify({ fleet_loop: { lane_target: 6 } }));
		const lines: string[] = [];
		const w = createLoopConfigWatch({
			path: conf,
			intervalMs: 50,
			log: (l) => lines.push(l),
		});
		try {
			expect(w.settings().laneTarget).toBe(6);
			// the operator edit: bump the target — mtime+size both move
			writeFileSync(
				conf,
				JSON.stringify({ fleet_loop: { lane_target: 20, every_s: 45 } }),
			);
			const deadline = Date.now() + 5_000;
			while (w.settings().laneTarget !== 20 && Date.now() < deadline) {
				await Bun.sleep(50);
			}
			expect(w.settings().laneTarget).toBe(20);
			expect(w.settings().everyS).toBe(45);
			expect(lines.some((l) => l.includes("lane_target=20"))).toBe(true);
			// a malformed conf never crashes the daemon — previous settings stand
			writeFileSync(conf, "{ not json");
			await Bun.sleep(200);
			expect(w.settings().laneTarget).toBe(20);
		} finally {
			w.stop();
		}
	});

	test("explicit --every / --target CLI flags stay one-shot overrides the watcher never observes", () => {
		// the daemon's contract (fleet-loop.ts): an explicit flag wins for
		// the process; otherwise everyS comes from the watcher. Pinned here
		// at the seam: the watcher itself only ever reports conf values.
		const dir = tmpConf();
		const conf = join(dir, "stack.json");
		writeFileSync(conf, JSON.stringify({ fleet_loop: { every_s: 30 } }));
		const w = createLoopConfigWatch({ path: conf, intervalMs: 10_000 });
		try {
			expect(w.settings().everyS).toBe(30);
		} finally {
			w.stop();
		}
	});
});
