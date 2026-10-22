// test/lane-settings.test.ts — W512 lane --settings composer: env grammar
// (W250/W228, unchanged) + the hooks block carrying the Task-pin command.
import { describe, expect, test } from "bun:test";
import {
	laneSettingsData,
	modelPinHookCommand,
	runawayHookCommand,
} from "../scripts/lib/lane-settings.ts";

describe("lane-settings (W512)", () => {
	const env = {
		ANTHROPIC_BASE_URL: "http://127.0.0.1:4101/w/autow512",
		ANTHROPIC_AUTH_TOKEN: "bksk_lane",
	};

	test("env grammar: opus alias + remap + routing + token", () => {
		const s = JSON.parse(laneSettingsData(env, "glm-5.3-flash", "/p/bin")) as {
			env: Record<string, string>;
		};
		expect(s.env.ANTHROPIC_MODEL).toBe("opus");
		expect(s.env.KLH_SESSION_ROLE).toBe("lane"); // W834 role marker
		expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash");
		expect(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.3-flash");
		expect(s.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101/w/autow512");
		expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("bksk_lane");
	});

	test("hooks block: Task pin + runaway guard, command hooks, 10s timeouts", () => {
		const s = JSON.parse(laneSettingsData(env, "glm-5.3-flash", "/p/bin")) as {
			hooks: {
				PreToolUse: Array<{
					matcher?: string;
					hooks: Array<{ type: string; command: string; timeout: number }>;
				}>;
			};
		};
		expect(s.hooks.PreToolUse).toHaveLength(3);
		const pin = s.hooks.PreToolUse[0];
		expect(pin.matcher).toBe("Task");
		expect(pin.hooks[0].type).toBe("command");
		expect(pin.hooks[0].timeout).toBe(10);
		const guard = s.hooks.PreToolUse[1];
		expect(guard.matcher).toBeUndefined();
		expect(guard.hooks[0].command).toContain("/gate.ts runaway");
		expect(guard.hooks[0].timeout).toBe(10);
		// W1141: the trailer hook rides the same block — Bash rewrites only.
		const trailer = s.hooks.PreToolUse[2];
		expect(trailer.matcher).toBe("Bash");
		expect(trailer.hooks[0].command).toContain("/lane-commit-trailer.ts");
		expect(trailer.hooks[0].timeout).toBe(10);
	});

	test("hook command pins the exact model via the prefix bin", () => {
		const cmd = modelPinHookCommand("glm-5.3-flash", "/p/bin");
		expect(cmd).toContain("/p/bin/lane-model-pin.ts --model glm-5.3-flash");
		expect(cmd.startsWith(process.execPath)).toBe(true);
	});

	test("runaway guard: command via prefix bin, thresholds pass through env", () => {
		const cmd = runawayHookCommand("/p/bin");
		expect(cmd).toContain("/p/bin/gate.ts runaway");
		expect(cmd.startsWith(process.execPath)).toBe(true);
		const s = JSON.parse(
			laneSettingsData(
				{ ...env, SUSPENDERS_RUNAWAY_USD_CAP: "4" },
				"glm-5.3-flash",
				"/p/bin",
			),
		) as {
			env: Record<string, string>;
		};
		expect(s.env.SUSPENDERS_RUNAWAY_USD_CAP).toBe("4");
		const clean = JSON.parse(
			laneSettingsData(env, "glm-5.3-flash", "/p/bin"),
		) as {
			env: Record<string, string>;
		};
		expect(clean.env.SUSPENDERS_RUNAWAY_USD_CAP).toBeUndefined();
	});

	test("W909: SUSPENDERS_LANE_EFFORT pins only when dispatch carries it", () => {
		const withEffort = JSON.parse(
			laneSettingsData(
				{ ...env, SUSPENDERS_LANE_EFFORT: "high" },
				"glm-5.3-flash",
				"/p/bin",
			),
		) as { env: Record<string, string> };
		expect(withEffort.env.SUSPENDERS_LANE_EFFORT).toBe("high");
		const clean = JSON.parse(
			laneSettingsData(env, "glm-5.3-flash", "/p/bin"),
		) as { env: Record<string, string> };
		expect(clean.env.SUSPENDERS_LANE_EFFORT).toBeUndefined();
	});

	test("selected .prefer rule joins Claude requests without replacing operator headers", () => {
		const settings = JSON.parse(
			laneSettingsData(
				{
					...env,
					ANTHROPIC_CUSTOM_HEADERS: "x-operator: enabled\nx-klh-prefer: stale",
				},
				"glm-5.3-flash",
				"/p/bin",
				null,
				{
					source: "dotfile",
					directive: "can",
					line: 4,
					index: 0,
					target: "glm-5.3-flash",
					can: "active",
				},
			),
		) as { env: Record<string, string> };
		expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
			"x-operator: enabled\nx-klh-prefer: v=1;source=dotfile;directive=can;line=4;index=0;target=glm-5.3-flash;can=active;soft=absent;must_route=absent",
		);
	});

	test("routing-plane status is explicit without exposing its expression", () => {
		const settings = JSON.parse(
			laneSettingsData(
				env,
				"glm-5.3-flash",
				"/p/bin",
				null,
				{
					source: "dotfile",
					directive: "prefer",
					line: 2,
					index: 0,
					target: "glm-5.3-flash",
					can: "unavailable",
				},
				{ prefer: "private target", must: "private boundary" },
			),
		) as { env: Record<string, string> };
		expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toContain(
			"soft=declared;must_route=reserved",
		);
		expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).not.toContain("private");
	});
});
