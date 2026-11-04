// test/observe-gateway@unit.e2e.ts — W2574 N2-observe-coverage: hermetic
// specs for every observeGateway branch over the injected PrintResult seam
// (no live launchctl, no real children). Fail-closed identity fences: the
// absent/not-running sentinels are STABLE digests (a failed-load retry can
// re-run the fenced load through this same upgrader), unknown/ambiguous
// launchd output throws — pending, never guessed — and the two-look
// stability check still rejects an identity that shifts mid-observation.
import { expect, test } from "@playwright/test";
import { digestUnit } from "../scripts/lib/service-drift.ts";
import {
	observeGateway,
	type PrintResult,
} from "../scripts/upgrade-gateway.ts";

const LABEL = "com.suspenders.buckle-spoke";
const say = (code: number, out: string): PrintResult => ({ code, out });

const notFoundStderr = say(
	1,
	`Could not find service ${LABEL} in domain for port: gui, i.e. the domain found for service is: gui/501\n`,
);
const notFoundStdout = say(1, `${LABEL}:\nCould not find specified service\n`);

/** rc 0 print body with a live pid + arguments block. The pid rides the
 * file's unprovable-pid idiom (999999999, as in the not-running-with-pid
 * case): outside every reachable pid range on any host, so processBirth
 * finds no process — the running-row test below asserts the fail-closed
 * throw, never a host-conditional verdict on pid 4321 being absent. */
const runningPrint = (): PrintResult => {
	const body = [
		`${LABEL} = {`,
		"\tactive count = 1",
		"\tstate = running",
		"\tpid = 999999999",
		"\targuments = {",
		"\t\t/usr/local/bin/bun",
		`\t\t/gen/.harness/packages/buckle/src/server.bundle.js`,
		"\t}",
		"};",
	].join("\n");
	return say(0, body);
};

/** rc 0, registered job whose child exited: state = not running, args
 * present, no pid (#101817 degraded launchd row). */
const notRunningPrint = (): PrintResult => {
	const body = [
		`${LABEL} = {`,
		"\tactive count = 1",
		"\tstate = not running",
		"\targuments = {",
		"\t\t/usr/local/bin/bun",
		`\t\t/gen/.harness/packages/buckle/src/server.bundle.js`,
		"\t}",
		"};",
	].join("\n");
	return say(0, body);
};

test.describe("@unit W2574 observeGateway hermetic branches", () => {
	test("absent daemon (stderr not-found) observes as the stable absent sentinel", () => {
		const observed = observeGateway(() => notFoundStderr);
		expect(observed).toBe(
			digestUnit(JSON.stringify({ absent: true, label: LABEL })),
		);
		// stable across looks by construction: same input, same digest
		expect(observeGateway(() => notFoundStderr)).toBe(observed);
	});

	test("not-found line on stdout observes identically (stream-agnostic)", () => {
		expect(observeGateway(() => notFoundStdout)).toBe(
			observeGateway(() => notFoundStderr),
		);
	});

	test("registered-but-not-running observes as its exact args+state snapshot", () => {
		const observed = observeGateway(() => notRunningPrint());
		expect(observed).toBe(
			digestUnit(
				JSON.stringify({
					notRunning: true,
					args: [
						"/usr/local/bin/bun",
						"/gen/.harness/packages/buckle/src/server.bundle.js",
					],
					label: LABEL,
				}),
			),
		);
	});

	test("not-running WITH a pid stays on the process-identity path (unprovable here → throws)", () => {
		const body = notRunningPrint().out.replace(
			"state = not running",
			"state = not running\n\tpid = 999999999",
		);
		expect(() => observeGateway(() => say(0, body))).toThrow(
			"Gateway supervised identity unknown",
		);
	});

	test("unknown rc-nonzero output fails closed — never a guessed identity", () => {
		expect(() =>
			observeGateway(() => say(1, "launchctl: some unrelated failure\n")),
		).toThrow("Gateway supervised identity unavailable");
	});

	test("rc 0 without an arguments block is ambiguous — unknown, never guessed", () => {
		expect(() =>
			observeGateway(() =>
				say(0, "com.suspenders.buckle-spoke = {\n\tstate = running\n};\n"),
			),
		).toThrow("Gateway supervised identity unknown");
	});

	test("running job with an unprovable pid fails closed (no processBirth trust)", () => {
		// pid present but the process does not exist on this host: birth is
		// unprovable, observation is unknown — pending, never guessed
		expect(() => observeGateway(() => runningPrint())).toThrow(
			"Gateway supervised identity unknown",
		);
	});

	test("an identity that changes between the two looks throws", () => {
		// absent → not-running across the two looks: both are STABLE sentinels
		// individually, but the shift mid-observation is a changed identity
		let n = 0;
		const flipping = (): PrintResult =>
			n++ === 0 ? notFoundStderr : notRunningPrint();
		expect(() => observeGateway(flipping)).toThrow(
			"Gateway identity changed during observation",
		);
	});

	test("absent vs not-running snapshots are distinct stable identities", () => {
		const absent = observeGateway(() => notFoundStderr);
		const notRunning = observeGateway(() => notRunningPrint());
		expect(absent).not.toBe(notRunning);
	});
});
