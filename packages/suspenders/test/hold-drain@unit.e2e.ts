// W2318 HoldAndDrain — hold-mode parse/render/steer surface.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	DispatchHoldSchema,
	dispatchHoldActive,
	dispatchHoldGate,
	HOLD_FILE,
	HOLD_MODES,
	HOLD_TTL_HOURS_DEFAULT,
	releaseHold,
	setHold,
} from "../hooks/lib/lanes/dispatch-hold.ts";
import {
	drainPass,
	drainPrompt,
	HOLD_DRAIN_RESTEER_MS,
} from "../hooks/lib/lanes/hold-drain.ts";
import { holdMain } from "../scripts/lib/dispatch-hold-cli.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "hold-drain-"));

test("hold mode parses: drain round-trips, missing mode defaults to hold", () => {
	const fleet = scratch();
	try {
		const drained = setHold(fleet, "lane-x", "maintenance window", 2, "drain");
		expect(drained.mode).toBe("drain");
		expect(dispatchHoldActive(fleet)?.hold.mode).toBe("drain");
		expect(dispatchHoldGate(fleet)).toContain("steered to checkpoint");
		setHold(fleet, "lane-y", "plain hold");
		expect(dispatchHoldActive(fleet)?.hold.mode).toBe("hold");
		expect(HOLD_MODES).toContain("drain");
		expect(drainPrompt("op")).toContain("checkpoint and land");
		const bare = DispatchHoldSchema.safeParse({
			by: "a",
			reason: "b",
			set_at: new Date().toISOString(),
			ttl_hours: 1,
		});
		expect(bare.success).toBe(true);
		expect(HOLD_TTL_HOURS_DEFAULT).toBe(4);
	} finally {
		releaseHold(fleet, "test");
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("a hold file with a junk mode is corrupt: dropped, logged, not held", () => {
	const fleet = scratch();
	writeFileSync(
		join(fleet, HOLD_FILE),
		JSON.stringify({
			by: "x",
			reason: "y",
			set_at: new Date().toISOString(),
			ttl_hours: 1,
			mode: "resume",
		}),
	);
	try {
		expect(dispatchHoldActive(fleet)).toBe(null);
		expect(
			JSON.parse(
				readFileSync(join(fleet, "dispatch-hold.log"), "utf8")
					.trim()
					.split("\n")
					.at(-1),
			).kind,
		).toBe("hold.corrupt");
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("holdMain --mode drain lands a draining hold; junk mode refuses with exit 2", () => {
	const fleet = scratch();
	try {
		expect(holdMain(["--reason", "window", "--mode", "drain"], { fleet })).toBe(
			0,
		);
		expect(dispatchHoldActive(fleet)?.hold.mode).toBe("drain");
		expect(holdMain(["--reason", "w", "--mode", "resume"], { fleet })).toBe(2);
		expect(holdMain(["--reason", "w", "--mode", "hold"], { fleet })).toBe(0);
		expect(dispatchHoldActive(fleet)?.hold.mode).toBe("hold");
	} finally {
		releaseHold(fleet, "test");
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("drainPass: idle with no hold, no steer on a plain hold", () => {
	const fleet = scratch();
	const root = scratch();
	const seen: string[] = [];
	const steer = (sid: string): "accepted" => {
		seen.push(sid);
		return "accepted";
	};
	try {
		expect(drainPass(root, fleet, { steer, lanes: [] }).mode).toBe("idle");
		setHold(fleet, "op", "plain hold", 2);
		const r = drainPass(root, fleet, { steer, lanes: [] });
		expect(r.mode).toBe("hold");
		expect(seen).toEqual([]);
	} finally {
		releaseHold(fleet, "test");
		rmSync(fleet, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("drainPass: steers alive lanes once per resteer window; failed steer not banked", () => {
	const fleet = scratch();
	const root = scratch();
	const lanes = [
		{ sid: "s1", item: "W1" },
		{ sid: "s2", item: "W2" },
	];
	const seen: string[] = [];
	let fail = false;
	const steer = (sid: string): "accepted" | "failed" => {
		seen.push(sid);
		return sid === "s1" && fail ? "failed" : "accepted";
	};
	try {
		setHold(fleet, "op", "window", 2, "drain");
		const r = drainPass(root, fleet, { steer, lanes }, 1_000);
		expect(r.steered.sort()).toEqual(["s1", "s2"]);
		expect(seen).toEqual(["s1", "s2"]);
		expect(
			drainPass(root, fleet, { steer, lanes }, 2_000).resting.sort(),
		).toEqual(["s1", "s2"]);
		// past the resteer window the reminder re-fires
		expect(
			drainPass(
				root,
				fleet,
				{ steer, lanes },
				1_000 + HOLD_DRAIN_RESTEER_MS,
			).steered.sort(),
		).toEqual(["s1", "s2"]);
		// a failed steer is not banked — the next pass retries the lane
		fail = true;
		setHold(fleet, "op", "window", 2, "drain");
		const r2 = drainPass(root, fleet, { steer, lanes }, 2_000);
		expect(r2.failed.map((f) => f[0])).toEqual(["s1"]);
		expect(r2.steered).toEqual(["s2"]);
		fail = false;
		expect(drainPass(root, fleet, { steer, lanes }, 3_000).steered).toEqual([
			"s1",
		]);
	} finally {
		releaseHold(fleet, "test");
		rmSync(fleet, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
