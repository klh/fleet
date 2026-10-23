import { afterAll, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DispatchHold,
	dispatchHoldActive,
	dispatchHoldGate,
	holdExpiresAt,
	HOLD_FILE,
	HOLD_LOG,
	HOLD_TTL_HOURS_DEFAULT,
	releaseHold,
	setHold,
} from "../hooks/lib/dispatch-hold.ts";
import { holdMain } from "../scripts/lib/dispatch-hold-cli.ts";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { REPO, toolWith, dispatchWith } = dispatchHarness(afterAll, {
	tag: "dispatch-rollout-hold",
});

const scratch = (): string => mkdtempSync(join(tmpdir(), "dispatch-hold-"));

const lastRow = (fleet: string): Record<string, unknown> =>
	JSON.parse(
		readFileSync(join(fleet, HOLD_LOG), "utf8").trim().split("\n").at(-1),
	);

test("recorded hold exposes by, reason, ttl and remaining time", () => {
	const fleet = scratch();
	try {
		const hold = setHold(fleet, "lane-x", "hub rollout", 2);
		expect(hold.by).toBe("lane-x");
		expect(hold.reason).toBe("hub rollout");
		expect(hold.ttl_hours).toBe(2);
		const obs = dispatchHoldActive(fleet);
		expect(obs?.legacy).toBe(false);
		expect(obs?.hold.by).toBe("lane-x");
		expect(obs?.remainingMs).toBeGreaterThan(0);
		expect(holdExpiresAt(hold)).toBe(
			new Date(
				Date.parse(hold.set_at) + hold.ttl_hours * 3_600_000,
			).toISOString(),
		);
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("hold.set lands in the NDJSON audit log with the expiry", () => {
	const fleet = scratch();
	try {
		const hold = setHold(fleet, "lane-x", "hub rollout", 3);
		const row = lastRow(fleet);
		expect(row.kind).toBe("hold.set");
		expect(row.by).toBe("lane-x");
		expect(row.reason).toBe("hub rollout");
		expect(row.ttl_hours).toBe(3);
		expect(row.expires_at).toBe(holdExpiresAt(hold));
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("an expired hold auto-lifts and logs the expiry at observe time", () => {
	const fleet = scratch();
	try {
		const hold: DispatchHold = setHold(fleet, "lane-x", "hub rollout", 0.001);
		expect(dispatchHoldActive(fleet, Date.parse(hold.set_at) + 10_000)).toBe(
			null,
		);
		expect(existsSync(join(fleet, HOLD_FILE))).toBe(false);
		expect(lastRow(fleet).kind).toBe("hold.expire");
		expect(lastRow(fleet).by).toBe("lane-x");
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("release clears a recorded hold and logs hold.release", () => {
	const fleet = scratch();
	try {
		setHold(fleet, "lane-x", "hub rollout", 2);
		expect(releaseHold(fleet, "lane-y")).toBe(true);
		expect(existsSync(join(fleet, HOLD_FILE))).toBe(false);
		expect(dispatchHoldActive(fleet)).toBe(null);
		const row = lastRow(fleet);
		expect(row.kind).toBe("hold.release");
		expect(row.by).toBe("lane-y");
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("release also clears the legacy bare marker and reports nothing held", () => {
	const fleet = scratch();
	try {
		writeFileSync(join(fleet, "dispatch-paused"), "stale pause\n");
		expect(releaseHold(fleet, "operator")).toBe(true);
		expect(existsSync(join(fleet, "dispatch-paused"))).toBe(false);
		expect(releaseHold(fleet, "operator")).toBe(false);
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("a bare legacy marker still holds with the deprecation WAIT line", () => {
	const fleet = scratch();
	try {
		writeFileSync(join(fleet, "dispatch-paused"), "old pause\n");
		const obs = dispatchHoldActive(fleet);
		expect(obs?.legacy).toBe(true);
		expect(obs?.remainingMs).toBe(Number.POSITIVE_INFINITY);
		const gate = dispatchHoldGate(fleet);
		expect(gate).toContain("bare .fleet/dispatch-paused marker");
		expect(gate).toContain("dispatch hold --reason");
		expect(lastRow(fleet).kind).toBe("hold.legacy-warn");
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("a corrupt hold file is dropped and logged as hold.corrupt", () => {
	const fleet = scratch();
	try {
		writeFileSync(join(fleet, HOLD_FILE), "{not json");
		expect(dispatchHoldActive(fleet)).toBe(null);
		expect(existsSync(join(fleet, HOLD_FILE))).toBe(false);
		expect(lastRow(fleet).kind).toBe("hold.corrupt");
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("setHold retires a bare marker and recorded json wins from then on", () => {
	const fleet = scratch();
	try {
		writeFileSync(join(fleet, "dispatch-paused"), "old pause\n");
		setHold(fleet, "lane-x", "recorded now", 1);
		expect(existsSync(join(fleet, "dispatch-paused"))).toBe(false);
		expect(dispatchHoldActive(fleet)?.legacy).toBe(false);
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("default ttl is HOLD_TTL_HOURS_DEFAULT when omitted", () => {
	const fleet = scratch();
	try {
		expect(setHold(fleet, "lane-x", "no ttl given").ttl_hours).toBe(
			HOLD_TTL_HOURS_DEFAULT,
		);
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("holdMain sets a hold, refuses anonymous, rejects junk ttl", () => {
	const fleet = scratch();
	try {
		expect(
			holdMain(["--reason", "hub rollout", "--ttl-hours", "2"], { fleet }),
		).toBe(0);
		expect(existsSync(join(fleet, HOLD_FILE))).toBe(true);
		expect(lastRow(fleet).kind).toBe("hold.set");
		expect(holdMain(["hold", "--ttl-hours", "2"], { fleet })).toBe(2);
		expect(holdMain(["--reason", "x", "--ttl-hours", "junk"], { fleet })).toBe(
			2,
		);
		expect(holdMain(["--reason", "x", "--ttl-hours", "0"], { fleet })).toBe(2);
		expect(holdMain(["--help"], { fleet })).toBe(0);
	} finally {
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("holdMain release: exit 1 with no hold, 0 after a set; sid attribution", () => {
	const fleet = scratch();
	process.env.SUSPENDERS_SID = "lane-test";
	try {
		expect(holdMain([], { fleet, release: true })).toBe(1);
		expect(holdMain(["--reason", "pause"], { fleet })).toBe(0);
		expect(lastRow(fleet).by).toBe("lane-test");
		expect(holdMain([], { fleet, release: true })).toBe(0);
	} finally {
		delete process.env.SUSPENDERS_SID;
		rmSync(fleet, { recursive: true, force: true });
	}
});

test("holdMain --fleet lands the hold in the override dir, not the canonical", () => {
	const canon = scratch();
	const smoke = scratch();
	try {
		expect(
			holdMain(["--reason", "smoke", "--fleet", smoke], { fleet: canon }),
		).toBe(0);
		expect(existsSync(join(smoke, HOLD_FILE))).toBe(true);
		expect(existsSync(join(canon, HOLD_FILE))).toBe(false);
		expect(dispatchHoldActive(smoke)?.hold.reason).toBe("smoke");
	} finally {
		rmSync(canon, { recursive: true, force: true });
		rmSync(smoke, { recursive: true, force: true });
	}
});

test("holdMain release honors --fleet and the redirect is never silent", () => {
	const canon = scratch();
	const smoke = scratch();
	const logs: string[] = [];
	const spy = spyOn(console, "log").mockImplementation(
		(...msgs: unknown[]) => {
			logs.push(msgs.join(" "));
		},
	);
	try {
		setHold(smoke, "lane-x", "smoke hold", 1);
		expect(
			holdMain(["--fleet", smoke, "--by", "op"], {
				fleet: canon,
				release: true,
			}),
		).toBe(0);
		expect(existsSync(join(smoke, HOLD_FILE))).toBe(false);
		expect(logs.join("\n")).toContain(`fleet ${smoke}`);
	} finally {
		spy.mockRestore();
		rmSync(canon, { recursive: true, force: true });
		rmSync(smoke, { recursive: true, force: true });
	}
});

test("holdMain refuses a valueless --fleet before touching any fleet dir", () => {
	const canon = scratch();
	try {
		expect(holdMain(["--reason", "x", "--fleet"], { fleet: canon })).toBe(2);
		expect(holdMain(["--fleet", "--reason", "x"], { fleet: canon })).toBe(2);
		expect(existsSync(join(canon, HOLD_FILE))).toBe(false);
	} finally {
		rmSync(canon, { recursive: true, force: true });
	}
});

test("rollout hold keeps a READY item unclaimed and leaves existing lanes alone", () => {
	const item = toolWith({}, "work.ts", "add", "hold gate fixture").out.match(
		/W\d+/,
	)?.[0];
	if (!item) throw new Error("work add did not return an item id");
	const fleet = join(REPO, ".fleet");
	mkdirSync(fleet, { recursive: true });
	const marker = join(fleet, "dispatch-paused");
	writeFileSync(marker, "hub rollout\n");
	try {
		const result = dispatchWith({}, "--item", item, "--no-belt");
		expect(result.code).toBe(0);
		expect(result.out).toContain("bare .fleet/dispatch-paused marker");
		setHold(fleet, "lane-x", "hub rollout", 2);
		const named = dispatchWith({}, "--item", item, "--no-belt");
		expect(named.code).toBe(0);
		expect(named.out).toContain("dispatch paused by lane-x");
		expect(named.out).toContain("hub rollout");
		expect(named.out).toContain("more min");
		const state = JSON.parse(
			toolWith({}, "work.ts", "show", item, "--json").out,
		);
		expect(state.state).toBe("READY");
	} finally {
		rmSync(marker, { force: true });
		toolWith({}, "work.ts", "fail", item);
	}
});
