import { expect, test } from "bun:test";
import {
	watchdogLiveness,
	watchdogProgress,
} from "../scripts/lib/watchdog-liveness.ts";
const stats = { counts: { READY: 10, DONE: 2 }, latest_done: null };
test("CLI false cannot erase unknown process identity under launchd PATH", () => {
	const observation = watchdogLiveness(
		"/project",
		[{ sid: "lane", live: false }],
		{
			registry: () => ({
				known: true,
				lanes: [{ sid: "lane", item: "W1", pid: 12 }],
			}),
			identity: () => null,
		},
	);
	expect(observation).toEqual({ live: 0, unknown: 1 });
	const flow = watchdogProgress(
		stats,
		observation,
		{ progressAt: 1, done: 2 },
		60 * 60_000,
	);
	expect(flow.verdict).toBe("unknown");
	expect(flow.stalled).toBe(false);
	expect(flow.restart).toBe(false);
});
test("confirmed dead evidence can stall; advancing work still updates progress while identity unknown", () => {
	expect(
		watchdogProgress(
			stats,
			{ live: 0, unknown: 0 },
			{ progressAt: 1, done: 2 },
			60 * 60_000,
		).stalled,
	).toBe(true);
	const advanced = watchdogProgress(
		stats,
		{ live: 0, unknown: 1 },
		{ progressAt: 1, done: 1 },
		60 * 60_000,
	);
	expect(advanced.advanced).toBe(true);
	expect(advanced.state.progressAt).toBe(60 * 60_000);
});
test("shared live observations survive and registry changes remain incomplete", () => {
	expect(
		watchdogLiveness("/project", [{ sid: "live", live: true }], {
			registry: () => ({
				known: true,
				lanes: [
					{ sid: "live", item: "W1" },
					{ sid: "new", item: "W2" },
				],
			}),
			identity: () => false,
		}),
	).toEqual({ live: 1, unknown: 1 });
});
test("unavailable or malformed canonical evidence is refused", () => {
	expect(() =>
		watchdogLiveness("/project", [], {
			registry: () => ({ known: false, lanes: [], error: "missing" }),
			identity: () => false,
		}),
	).toThrow();
	expect(() =>
		watchdogLiveness("/project", [{ sid: "bad", live: "false" }] as never),
	).toThrow();
});
