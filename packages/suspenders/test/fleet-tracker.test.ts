// test/fleet-tracker.test.ts — W575: the tracker's pure units (ring, render,
// vocabulary) plus a CLI smoke against an isolated temp HOME. The live push
// path reuses the production /subscribe socket shape coord rides, so the
// feed is exercised against the real fleet in the manual run recorded in
// docs/tracker.md.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransitionRing } from "../hooks/tracker/feed.ts";
import { KINDS, SYMBOLS, stateToCellState } from "../hooks/tracker/model.ts";
import { cellText, renderFrame, visibleCols } from "../hooks/tracker/render.ts";
import type { Snapshot, Transition } from "../hooks/tracker/snapshot.ts";

const BIN = `${import.meta.dir}/../hooks/bin/fleet-tracker.ts`;

const t = (
	eventId: number,
	state: Transition["state"],
	lane: string | null = null,
	item = `W${eventId}`,
): Transition => ({
	eventId,
	ts: 1_700_000_000_000 + eventId,
	project: "proj",
	item,
	lane,
	state,
	note: null,
});

const snapOf = (
	transitions: Transition[],
	columns: { name: string }[] = [],
): Snapshot => ({
	columns: columns.map((c, i) => ({
		sid: `sid-${i}`,
		name: c.name,
		sessionState: null,
		worktree: null,
		live: false,
		stalled: false,
		unknown: false,
	})),
	transitions,
	queueDepth: 3,
	now: Date.now(),
});

describe("tracker vocabulary", () => {
	test("every canonical work kind maps to a cell state", () => {
		for (const kind of [
			"work.added",
			"work.ready",
			"work.claimed",
			"work.done",
			"work.failed",
			"work.released",
			"work.recovery-reset",
			"work.recovery-reserved",
			"work.shattered",
			"work.tree",
		])
			expect(KINDS[kind]).toBeTypeOf("string");
		expect(KINDS["work.claimed"]).toBe("claimed");
		expect(KINDS["work.done"]).toBe("complete");
	});

	test("symbols are distinct glyphs (the non-colour channel)", () => {
		const glyphs = Object.values(SYMBOLS);
		expect(new Set(glyphs).size).toBe(glyphs.length);
	});

	test("stalled needs a dead lease; unknown beats claimed", () => {
		const dead = { live: false, stalled: true, unknown: false };
		const blind = { live: false, stalled: false, unknown: true };
		expect(stateToCellState("CLAIMED", dead)).toBe("stalled");
		expect(stateToCellState("CLAIMED", blind)).toBe("unknown");
		expect(
			stateToCellState("RUNNING", {
				live: true,
				stalled: false,
				unknown: false,
			}),
		).toBe("running");
		expect(stateToCellState("READY", dead)).toBe("queued");
		expect(stateToCellState("DONE", dead)).toBe("complete");
	});
});

describe("TransitionRing (bounded history)", () => {
	test("keeps event-id order and trims to the cap", () => {
		const ring = new TransitionRing(3);
		ring.push(t(1, "queued"));
		ring.push(t(2, "claimed"));
		ring.push(t(3, "running"));
		ring.push(t(4, "complete"));
		expect(ring.size).toBe(3);
		expect(ring.rows().map((r) => r.eventId)).toEqual([2, 3, 4]);
	});

	test("refill dedupes and counts only genuinely new ids", () => {
		const ring = new TransitionRing(10);
		ring.push(t(1, "queued"));
		ring.push(t(2, "claimed"));
		const added = ring.refill([
			t(2, "claimed"),
			t(3, "running"),
			t(4, "complete"),
		]);
		expect(added).toBe(2);
		expect(ring.rows().map((r) => r.eventId)).toEqual([1, 2, 3, 4]);
	});

	test("a push already in the ring never reorders history", () => {
		const ring = new TransitionRing(10);
		ring.push(t(2, "claimed"));
		ring.push(t(1, "queued"));
		expect(ring.rows().map((r) => r.eventId)).toEqual([1, 2]);
	});
});

describe("render", () => {
	test("cells carry id + one non-colour glyph", () => {
		expect(cellText(t(575, "running")).endsWith("▶")).toBe(true);
		expect(cellText(t(576, "decision", "sid")).endsWith("?")).toBe(true);
		expect(cellText(t(577, "complete", null)).endsWith("✓")).toBe(true);
	});

	test("legend + queue depth + key hints in a plain frame", () => {
		const frame = renderFrame(snapOf([t(1, "queued")]), {
			width: 100,
			height: 24,
			useColor: false,
			selRow: 0,
			selCol: 0,
			detail: null,
		});
		expect(frame).toContain("legend");
		expect(frame).toContain("q:3");
		expect(frame).toContain("↑↓ rows");
		expect(frame).toContain("W1·");
	});

	test("narrow terminal windows columns; cursor column stays visible", () => {
		const s = snapOf(
			[],
			[{ name: "aa" }, { name: "bb" }, { name: "cc" }, { name: "dd" }],
		);
		const narrow = visibleCols(s, 40, 0);
		expect(narrow.length).toBeLessThan(5);
		expect(narrow).toContain(0);
		expect(visibleCols(s, 40, 3).includes(3)).toBe(true);
	});
});

describe("fleet-tracker CLI (smoke)", () => {
	test("--once renders one plain frame on an empty isolated fleet", async () => {
		const home = mkdtempSync(join(tmpdir(), "w575-tracker-home-"));
		try {
			const proc = Bun.spawn(
				["bun", BIN, "--once", "--no-color", "--history", "25"],
				{
					cwd: home,
					env: {
						...process.env,
						HOME: home,
						NO_COLOR: "1",
						GOVERNOR_STORE_URL: "local",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const code = await proc.exited;
			const out = await new Response(proc.stdout).text();
			expect(code).toBe(0);
			expect(out).toContain("legend");
			expect(out).toContain("q:");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
