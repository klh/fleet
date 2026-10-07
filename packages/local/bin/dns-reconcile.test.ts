import { expect, test } from "bun:test";
import { activeRouteMatches, reconcileDnsClaim } from "./dns-reconcile.ts";

test("DNS reconciliation requires exact active virtual host and upstream", () => {
	const config = {
		apps: {
			http: {
				servers: {
					main: {
						routes: [
							{
								match: [{ host: ["nas-hub.local"] }],
								handle: [
									{
										handler: "subroute",
										routes: [
											{
												handle: [
													{
														handler: "reverse_proxy",
														upstreams: [{ dial: "nas.example:7799" }],
													},
												],
											},
										],
									},
								],
							},
						],
					},
				},
			},
		},
	};
	expect(activeRouteMatches(config, "nas-hub.local", "nas.example:7799")).toBe(
		true,
	);
	expect(activeRouteMatches(config, "other.local", "nas.example:7799")).toBe(
		false,
	);
	expect(
		activeRouteMatches(config, "nas-hub.local", "other.example:7799"),
	).toBe(false);
});

test("live exact claimant is retained without spawning or publishing", () => {
	expect(
		reconcileDnsClaim({
			current: { claimed: true, pid: 12 },
			matches: (pid) => pid === 12,
			spawn: () => {
				throw new Error("unexpected spawn");
			},
			publish: () => {
				throw new Error("unexpected publish");
			},
			cleanupNew: () => {
				throw new Error("unexpected kill");
			},
		}),
	).toBe("unchanged");
});

test("stopped claimant publishes verified replacement, without killing old PID", () => {
	let published = 0;
	expect(
		reconcileDnsClaim({
			current: { claimed: true, pid: 12 },
			matches: (pid) => pid === 99,
			spawn: () => ({ claimed: true, pid: 99 }),
			publish: (claim) => {
				published = claim.pid ?? 0;
			},
			cleanupNew: () => {
				throw new Error("unexpected kill");
			},
		}),
	).toBe("reconciled");
	expect(published).toBe(99);
});

test("failed publication cleans only this newly spawned claimant", () => {
	let cleaned = 0;
	expect(() =>
		reconcileDnsClaim({
			current: { claimed: true, pid: 12 },
			matches: (pid) => pid === 99,
			spawn: () => ({ claimed: true, pid: 99 }),
			publish: () => {
				throw new Error("disk failure");
			},
			cleanupNew: (pid) => {
				cleaned = pid;
			},
		}),
	).toThrow("disk failure");
	expect(cleaned).toBe(99);
});
