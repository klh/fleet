// W791 — prefs.json merge-write guard. The 2026-10-17 incident: a belt
// writer flushed a stale in-memory snapshot over the operator's file and
// clobbered kev escalate_gate + the tightened ambiguity_band, the condense
// section and cost_speed. These tests pin the guard's contract: load the
// CURRENT disk state, deep-merge, commit atomically — a writer's patch
// can never erase sections it did not write.
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { deepMergePrefs, mergeWritePrefs } from "../bin/prefs-lib.ts";
import { scratchWorld } from "@klh/test-kit";

const tmpPrefs = (): string => {
	const { home } = scratchWorld({ prefix: "w791-prefs-" });
	return join(home, "prefs.json");
};

// the 2026-09-21-era shape the stale writer held — no escalate_gate, no
// condense section, no cost_speed: exactly what the incident clobbered
const STALE = {
	cost_speed: "balanced",
	profile: ["coding", "research"],
	routing_table: { coding: 8901 },
	kev: { enabled: true, port: 8912, ambiguity_band: [0.25, 0.45] },
	allow_cloud: true,
	updated: "2026-09-21",
};

const OPERATOR = {
	...STALE,
	cost_speed: "quality",
	kev: { ...STALE.kev, escalate_gate: true, ambiguity_band: [0.1, 0.2] },
	condense: { enabled: true, tier: "balanced" },
};

describe("mergeWritePrefs (W791 stale-snapshot guard)", () => {
	test("stale writer cannot clobber operator sections (the incident)", () => {
		const p = tmpPrefs();
		writeFileSync(p, JSON.stringify(OPERATOR));
		// the stale writer only flips one key; its memory lacks the newer
		// operator sections — the fresh disk load must supply them
		const next = mergeWritePrefs(p, { allow_cloud: false });
		expect(next.allow_cloud).toBe(false);
		expect(next.kev).toEqual(OPERATOR.kev);
		expect(next.condense).toEqual(OPERATOR.condense);
		expect(next.cost_speed).toBe("quality");
	});

	test("concurrent modification: a section another writer lands on disk survives the next merge-write", () => {
		const p = tmpPrefs();
		writeFileSync(p, JSON.stringify({ cost_speed: "balanced" }));
		// writer B lands a kev update; writer A merges after and must see it
		mergeWritePrefs(p, { kev: { escalate_gate: true } });
		mergeWritePrefs(p, { allow_cloud: true });
		const onDisk = JSON.parse(readFileSync(p, "utf8")) as {
			kev: { escalate_gate: boolean };
			allow_cloud: boolean;
			cost_speed: string;
		};
		expect(onDisk.kev.escalate_gate).toBe(true);
		expect(onDisk.allow_cloud).toBe(true);
		expect(onDisk.cost_speed).toBe("balanced");
	});

	test("deepMergePrefs: nested objects merge, arrays/scalars replace, inputs untouched", () => {
		const base = { kev: { enabled: true, ambiguity_band: [0.25, 0.45] } };
		const patch = {
			kev: { ambiguity_band: [0.1, 0.2], escalate_gate: true },
		};
		const merged = deepMergePrefs(base, patch);
		expect(merged).toEqual({
			kev: {
				enabled: true,
				ambiguity_band: [0.1, 0.2],
				escalate_gate: true,
			},
		});
		// purity: neither input mutated
		expect(base.kev.ambiguity_band).toEqual([0.25, 0.45]);
		expect(patch.kev).toEqual({
			ambiguity_band: [0.1, 0.2],
			escalate_gate: true,
		});
	});

	test("corrupt on-disk file: throws and the bytes are never replaced", () => {
		const p = tmpPrefs();
		writeFileSync(p, "{not json");
		expect(() => mergeWritePrefs(p, { allow_cloud: true })).toThrow();
		expect(readFileSync(p, "utf8")).toBe("{not json");
	});

	test("atomic commit: no tmp leftovers, mode preserved, new files land 0600", () => {
		const { home: dir, clean } = scratchWorld({ prefix: "w791-prefs-" });
		const p = join(dir, "prefs.json");
		mergeWritePrefs(p, { cost_speed: "quality" });
		expect(statSync(p).mode & 0o777).toBe(0o600);
		mergeWritePrefs(p, { allow_cloud: true });
		const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
		writeFileSync(p, JSON.stringify({}));
		chmodSync(p, 0o644); // explicit — a strict umask masks writeFileSync's mode arg
		mergeWritePrefs(p, { updated: "2026-10-18" });
		expect(statSync(p).mode & 0o777).toBe(0o644);
		clean();
	});

	test("written bytes: 2-space indent + trailing newline", () => {
		const p = tmpPrefs();
		mergeWritePrefs(p, { allow_cloud: true });
		expect(readFileSync(p, "utf8")).toBe('{\n  "allow_cloud": true\n}\n');
	});
});
