// lane-effort.test.ts — W909: the effort stamp + claim-link producer tests.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	claimedWorkOf,
	doneEffortStamp,
	effortForPriority,
	laneEffortFromSettingsFile,
} from "../hooks/lib/lanes/lane-effort.ts";

test.describe("laneEffortFromSettingsFile", () => {
	test("reads SUSPENDERS_LANE_EFFORT from the 0600 settings JSON; absent → null", () => {
		const dir = mkdtempSync(join(tmpdir(), "lane-effort-"));
		const p = join(dir, "lane-settings-s1.json");
		writeFileSync(
			p,
			JSON.stringify({ env: { SUSPENDERS_LANE_EFFORT: "high" } }),
		);
		expect(laneEffortFromSettingsFile(p)).toBe("high");
		expect(laneEffortFromSettingsFile(join(dir, "absent.json"))).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});
});

test.describe("doneEffortStamp", () => {
	test("env wins over the settings file; neither → {}", () => {
		const dir = mkdtempSync(join(tmpdir(), "lane-effort-"));
		const p = join(dir, "lane-settings-s2.json");
		writeFileSync(
			p,
			JSON.stringify({ env: { SUSPENDERS_LANE_EFFORT: "low" } }),
		);
		expect(doneEffortStamp(dir, "s2", {})).toEqual({ effort: "low" });
		expect(
			doneEffortStamp(dir, "s2", { SUSPENDERS_LANE_EFFORT: "max" }),
		).toEqual({ effort: "max" });
		expect(doneEffortStamp(dir, "missing-sid", {})).toEqual({});
		rmSync(dir, { recursive: true, force: true });
	});
});

test.describe("claimedWorkOf", () => {
	test("most-recent CLAIMED/RUNNING claim, none → null", () => {
		const d = new Database(":memory:");
		d.run(
			"CREATE TABLE work_items (project TEXT, id TEXT, state TEXT, owner_sid TEXT, updated_at INTEGER)",
		);
		const add = (id: string, state: string, age: number): void =>
			d
				.prepare(
					"INSERT INTO work_items (project, id, state, owner_sid, updated_at) VALUES ('p', ?, ?, ?, ?)",
				)
				.run(id, state, "s1", Date.now() - age);
		add("W1", "CLAIMED", 1_000);
		add("W2", "CLAIMED", 2_000);
		expect(claimedWorkOf(d, "p", "s1")).toBe("W1");
		expect(claimedWorkOf(d, "p", "ghost")).toBeNull();
		expect(claimedWorkOf(d, "p", null)).toBeNull();
		d.close();
	});
});

test.describe("effortForPriority (W923 dispatch default)", () => {
	test("priority maps high/medium/low; null → medium", () => {
		expect(effortForPriority(null)).toBe("medium");
		expect(effortForPriority(undefined)).toBe("medium");
		expect(effortForPriority(0)).toBe("high");
		expect(effortForPriority(1)).toBe("high");
		expect(effortForPriority(2)).toBe("medium");
		expect(effortForPriority(3)).toBe("low");
		expect(effortForPriority(9)).toBe("low");
	});
});
