// rung-breaker.e2e.ts — W2786 co-situated proof: the lane-launch circuit
// breaker. A scripted launch-exit loop (the W2783 shape: 502 no_route into a
// quota-walled rung) trips the rung after K consecutive classified failures;
// the launch walk advances to the NEXT chain rung; the rung recovers on
// window expiry and clears on first committed success. Configuration and
// unknown failures never trip (retrying a different rung cannot fix a bad
// flag; no evidence never deactivates).

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGovernorDb } from "../../hooks/lib/govdb/govdb-open.ts";
import type { GovernorStore } from "../../hooks/lib/govdb/govdb.ts";
import { pinReg } from "../../hooks/lib/govdb/govdb-util.ts";
import { launchLogAppended } from "./launch-backoff.ts";
import {
	clearRung,
	laneRungOf,
	recordRungFailure,
	resolveLaunchPick,
	rungBreakerK,
	rungBreakerWindowMs,
	rungOpen,
} from "./rung-breaker.ts";

// scratch governor (the w2189 pattern): HOME + pinReg() before open —
// GOVERNOR_STORE_URL=local alone still reaches the machine governor.
const home = join(tmpdir(), `w2786-rung-${crypto.randomUUID()}`);
mkdirSync(home, { recursive: true });
process.env.HOME = home;
pinReg();
const store = openGovernorDb() as unknown as GovernorStore;

const W2783_EVIDENCE = `api_error_status=502 attempts=10 retries=10x no_route
fleet_trace hop=litellm upstream 500 copilot/gpt-6-sol quota wall`;

test("K consecutive classified launch-exits trip the rung open", () => {
	const rung = laneRungOf("copilot", "gpt-6-sol", "zai");
	clearRung(store, rung);
	const k = rungBreakerK();
	// a scripted launch-exit loop: what the catch seam records per dead attempt
	for (let i = 0; i < k - 1; i++) {
		const s = recordRungFailure(store, rung, W2783_EVIDENCE);
		expect(s.failures).toBe(i + 1);
		expect(rungOpen(store, rung)).toBeNull(); // not yet
	}
	const tripped = recordRungFailure(store, rung, W2783_EVIDENCE);
	expect(tripped.failures).toBe(k);
	const open = rungOpen(store, rung);
	expect(open).not.toBeNull();
	expect(open?.kind).toBe("upstream");
	expect(open?.until).toBeGreaterThan(Date.now());
	clearRung(store, rung);
});

test("the walk advances past an open rung to the next chain rung", () => {
	const claudeRung = laneRungOf("claude", "glm-5.3-flash", null);
	const copilotRung = laneRungOf("copilot", null, "zai");
	clearRung(store, claudeRung);
	clearRung(store, copilotRung);
	for (let i = 0; i < rungBreakerK(); i++)
		recordRungFailure(store, claudeRung, "429 rate limited too many requests");
	const notes: string[] = [];
	// the chain: attempt 0 rides claude (tripped), attempt 1 copilot (closed)
	const pick = resolveLaunchPick(
		store,
		(i) =>
			i === 0
				? { name: "claude", bin: "claude", model: "glm-5.3-flash", hub: null }
				: { name: "copilot", bin: "copilot", model: null, hub: "zai" },
		0,
		(m) => notes.push(m),
	);
	expect(pick.name).toBe("copilot");
	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain("claude");
	expect(notes[0]).toContain("rate-limit");
	clearRung(store, claudeRung);
});

test("all rungs open parks on the last (overrun never invents a rung)", () => {
	const a = laneRungOf("claude", "m1", null);
	const b = laneRungOf("claude", "m2", null);
	clearRung(store, a);
	clearRung(store, b);
	for (const r of [a, b])
		for (let i = 0; i < rungBreakerK(); i++)
			recordRungFailure(store, r, "503 no_route upstream unavailable");
	const pick = resolveLaunchPick(
		store,
		(i) =>
			i === 0
				? { name: "m1", bin: "claude", model: "m1", hub: null }
				: { name: "m2", bin: "claude", model: "m2", hub: null },
		0,
		() => {},
	);
	expect(pick.name).toBe("m2"); // chain end — parks, loudly skipped m1
	clearRung(store, a);
	clearRung(store, b);
});

test("window expiry recovers the rung; success clears it", () => {
	const rung = laneRungOf("claude", "glm-5.3", null);
	clearRung(store, rung);
	const k = rungBreakerK();
	const now = Date.now();
	for (let i = 0; i < k; i++)
		recordRungFailure(store, rung, "ECONNRESET transport", now);
	expect(rungOpen(store, rung, now)).not.toBeNull();
	const after = now + rungBreakerWindowMs() + 1;
	expect(rungOpen(store, rung, after)).toBeNull(); // half-open: re-provable
	// a later failure past the window starts a fresh episode at 1
	const s = recordRungFailure(store, rung, "502 no_route", after);
	expect(s.failures).toBe(1);
	// a committed launch on the rung resets the breaker entirely
	for (let i = 0; i < k; i++)
		recordRungFailure(store, rung, "502 no_route", after);
	clearRung(store, rung);
	expect(rungOpen(store, rung, after)).toBeNull();
});

test("configuration and unknown failures never trip", () => {
	const auth = laneRungOf("claude", "x", null);
	clearRung(store, auth);
	for (let i = 0; i < rungBreakerK() + 2; i++)
		recordRungFailure(store, auth, "API Error: 401 invalid api key");
	expect(rungOpen(store, auth)).toBeNull();
	const blank = laneRungOf("claude", "y", null);
	clearRung(store, blank);
	for (let i = 0; i < rungBreakerK() + 2; i++)
		recordRungFailure(store, blank, "");
	expect(rungOpen(store, blank)).toBeNull();
	clearRung(store, auth);
	clearRung(store, blank);
});

test("evidence flows from the attempt-scoped log tail (the catch seam)", () => {
	// the exact channel the launcher catch uses: appended bytes after spawn
	const log = join("/tmp", `w2786-rung-${crypto.randomUUID()}.log`);
	writeFileSync(log, `spawn marker\n${W2783_EVIDENCE}\n`);
	const appended = launchLogAppended(log, "spawn marker\n".length);
	const rung = laneRungOf("copilot", "gpt-6-sol", "zai");
	clearRung(store, rung);
	for (let i = 0; i < rungBreakerK(); i++)
		recordRungFailure(store, rung, appended);
	const open = rungOpen(store, rung);
	expect(open?.kind).toBe("upstream");
	clearRung(store, rung);
});
