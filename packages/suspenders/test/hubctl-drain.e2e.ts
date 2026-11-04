// test/hubctl-drain.test.ts — W1156: the hubctl drain pre-signal composes
// the on-hub script with the root credential as a script arg (never
// inlined into the command line), aims it at the declared gate port, holds
// the bounded grace, and degrades to a logged skip — never a deploy
// failure. The runner is injected: no ssh, no docker, no real hub.
import { expect, test } from "./pw";
import {
	drainGatewayBeforeRecreate,
	drainGraceSeconds,
} from "../deploy/hubctl.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

const hubOf = (over: Partial<HubProfile> = {}): HubProfile =>
	({
		host: "hub.test",
		deploy: { dir: "/srv/hub" },
		buckle_port: 4101,
		secrets: { buckle_root_key: "/srv/hub/buckle.env" },
		...over,
	}) as HubProfile;

const withGrace = (value: string | null, fn: () => void): void => {
	const saved = process.env.HUBCTL_DRAIN_GRACE_S;
	if (value === null) delete process.env.HUBCTL_DRAIN_GRACE_S;
	else process.env.HUBCTL_DRAIN_GRACE_S = value;
	try {
		fn();
	} finally {
		if (saved === undefined) delete process.env.HUBCTL_DRAIN_GRACE_S;
		else process.env.HUBCTL_DRAIN_GRACE_S = saved;
	}
};

test.describe("W1156 drainGraceSeconds", () => {
	test("unset knob defaults to 3; a bare value clamps into 1..10", () => {
		withGrace(null, () => expect(drainGraceSeconds()).toBe(3));
		withGrace("7", () => expect(drainGraceSeconds()).toBe(7));
		withGrace("99", () => expect(drainGraceSeconds()).toBe(10));
		withGrace("0", () => expect(drainGraceSeconds()).toBe(1));
		withGrace("abc", () => expect(drainGraceSeconds()).toBe(3));
	});

	test("an empty-string knob counts as unset (trim-guard)", () => {
		withGrace("", () => expect(drainGraceSeconds()).toBe(3));
		withGrace("  ", () => expect(drainGraceSeconds()).toBe(3));
	});
});

test.describe("W1156 drainGatewayBeforeRecreate", () => {
	test("composes the on-hub script: root key as arg, drain POST, bounded sleep", () => {
		withGrace(null, () => {
			const profile = hubOf();
			const seen: Array<{ hub: HubProfile; script: string }> = [];
			const lines: string[] = [];
			drainGatewayBeforeRecreate(
				profile,
				"nas",
				(hub, script) => {
					seen.push({ hub, script });
					return "draining:true\n200\n";
				},
				(line) => lines.push(line),
			);
			expect(seen.length).toBe(1);
			const { hub: h, script } = seen[0] as { hub: HubProfile; script: string };
			expect(h).toBe(profile); // the SAME profile object rides to the runner
			expect(script.startsWith("/bin/sh -c ")).toBe(true);
			expect(script).toContain("/srv/hub/buckle.env");
			expect(script).toContain("deployment:hubctl:nas");
			expect(script).toContain('"grace_ms":3000');
			expect(script).toContain("127.0.0.1:$3/v1/admin/drain");
			expect(
				script.endsWith(
					"sh '/srv/hub/buckle.env' '{\"reason\":\"deployment:hubctl:nas\",\"grace_ms\":3000}' '4101' '3'",
				),
			).toBe(true);
			expect(lines).toEqual(["draining:true\n200"]);
		});
	});

	test("no declared gate → logged skip, runner never fired", () => {
		const lines: string[] = [];
		drainGatewayBeforeRecreate(
			hubOf({ buckle_port: undefined, secrets: undefined }),
			"nas",
			() => {
				throw new Error("runner must not fire without a gate to drain");
			},
			(line) => lines.push(line),
		);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("no pre-signal");
	});

	test("a failed signal is logged, never thrown — the deploy continues", () => {
		withGrace(null, () => {
			const lines: string[] = [];
			drainGatewayBeforeRecreate(
				hubOf(),
				"nas",
				() => {
					throw new Error("ssh dead");
				},
				(line) => lines.push(line),
			);
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("deploy continues");
			expect(lines[0]).toContain("ssh dead");
		});
	});
});
