// scripts/lib/lane-settings.ts — W512: the lane --settings file composer.
// Two pin channels, one file: the env grammar pins the MAIN loop (the W228
// opus-alias + DEFAULT_OPUS remap — raw ids in the model option 400
// client-side) plus routing + token; the hooks block pins TASK calls via a
// PreToolUse updatedInput hook (call-time injection — the one channel no
// settings-env merge can clobber; user settings.json env merges OVER process
// env and killed every env-delivered pin, probed live 2026-10-05, W250).
// The file is 0600 — it carries the lane token.
import {
	encodePreferHeader,
	PREFER_HEADER,
	type PreferHeaderDecision,
} from "../../../telemetry/src/prefer-header.ts";
import {
	LANE_GUARD_EGRESS_PORT,
	loadLaneGuardConf,
} from "../../hooks/lib/lane-guard.ts";
import type { PreferRouting } from "./prefer-routing.ts";

/** The Task-pin hook command written into the lane settings. process.execPath
 *  over bare `bun`: launchd dispatch runs on a minimal PATH. */
export const modelPinHookCommand = (model: string, bin: string): string =>
	`${process.execPath} ${bin}/lane-model-pin.ts --model ${model}`;

// W830 runaway-guard: every-tool PreToolUse breaker registered beside the
// Task pin; thresholds pass through dispatch env into the settings env
// block (the 0600 file outranks user settings, so an operator pin survives
// the merge). Absent keys fall through to the gate's built-in defaults.
const RUNAWAY_ENV_KEYS = [
	"SUSPENDERS_RUNAWAY",
	"SUSPENDERS_RUNAWAY_REPEAT_MAX",
	"SUSPENDERS_RUNAWAY_FAIL_STREAK",
	"SUSPENDERS_RUNAWAY_USD_CAP",
	"SUSPENDERS_RUNAWAY_USD_RATES",
	"SUSPENDERS_RUNAWAY_TAIL_BYTES",
	"SUSPENDERS_RUNAWAY_SCAN_CAP_BYTES",
] as const;

export const runawayHookCommand = (bin: string): string =>
	`${process.execPath} ${bin}/gate.ts runaway`;

const runawayEnv = (env: Record<string, string>): Record<string, string> =>
	Object.fromEntries(
		RUNAWAY_ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]] as const),
	);

// W1141 lane-guard egress: when the machine conf carries an allowlist, the
// lane env pins every proxy-aware client (bun/curl/git/npm) at the local
// egress proxy — nothing leaves the machine except allowlisted hostnames,
// everything else is logged+denied at the proxy.
const laneGuardEgressPort = (): number =>
	Number(process.env.LANE_GUARD_EGRESS_PORT) > 0
		? Number(process.env.LANE_GUARD_EGRESS_PORT)
		: LANE_GUARD_EGRESS_PORT;

const egressProxyEnv = (): Record<string, string> => {
	const conf = loadLaneGuardConf();
	if (!conf?.egress?.allow?.length) return {};
	const url = `http://127.0.0.1:${laneGuardEgressPort()}`;
	return { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url };
};

// W1141 transcript tracing: the PreToolUse Bash hook rewrites lane git-commit
// calls with the Fleet-Session/Fleet-Item trailers (the done gate verifies).
const trailerHookEntry = (bin: string) => ({
	matcher: "Bash",
	hooks: [
		{
			type: "command",
			command: `${process.execPath} ${bin}/lane-commit-trailer.ts`,
			timeout: 10,
		},
	],
});

function customHeaders(
	existing: string | undefined,
	preference: PreferHeaderDecision | undefined,
): string | undefined {
	const lines = (existing ?? "")
		.split("\n")
		.filter((line) => line.trim() && !/^x-klh-prefer\s*:/i.test(line));
	const encoded = preference && encodePreferHeader(preference);
	if (encoded) lines.push(`${PREFER_HEADER}: ${encoded}`);
	return lines.length ? lines.join("\n") : undefined;
}

const customHeadersEnv = (
	existing: string | undefined,
	preference: PreferHeaderDecision | undefined,
	routing?: Pick<PreferRouting, "prefer" | "must">,
): Record<string, string> => {
	const decision = preference && {
		...preference,
		soft: routing?.prefer ? ("declared" as const) : ("absent" as const),
		mustRoute: routing?.must ? ("reserved" as const) : ("absent" as const),
	};
	const value = customHeaders(existing, decision);
	return value ? { ANTHROPIC_CUSTOM_HEADERS: value } : {};
};

/** The lane --settings file content: env grammar + the W512 Task pin hook.
 *  Pure — unit-testable. */
export const laneSettingsData = (
	env: Record<string, string>,
	model: string,
	bin: string,
	effort: string | null = null,
	preference?: PreferHeaderDecision,
	routing?: Pick<PreferRouting, "prefer" | "must">,
): string =>
	JSON.stringify(
		{
			env: {
				// W834 role marker: the lane role for the coordinator-edit gate
				// (hooks/lib/coordinator-edit-gate.ts) — --settings outranks the
				// user-settings env merge, the one channel that survives.
				KLH_SESSION_ROLE: "lane",
				ANTHROPIC_MODEL: env.ANTHROPIC_MODEL ?? "opus",
				ANTHROPIC_DEFAULT_OPUS_MODEL: model,
				ANTHROPIC_DEFAULT_SONNET_MODEL:
					env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? model,
				ANTHROPIC_DEFAULT_HAIKU_MODEL:
					env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? model,
				ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
				ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
				...customHeadersEnv(env.ANTHROPIC_CUSTOM_HEADERS, preference, routing),
				// W909: the lane's effort level — `work done` banks it into the
				// work.done event (lib/lane-effort.ts); the reporter renders it.
				// W923: env wins; the priority-derived default (dispatch-next)
				// fills the pin so EFFORT is never empty no-data in the report.
				...(env.SUSPENDERS_LANE_EFFORT || effort
					? { SUSPENDERS_LANE_EFFORT: env.SUSPENDERS_LANE_EFFORT || effort }
					: {}),
				...runawayEnv(env),
				...egressProxyEnv(),
			},
			hooks: {
				PreToolUse: [
					{
						matcher: "Task",
						hooks: [
							{
								type: "command",
								command: modelPinHookCommand(model, bin),
								timeout: 10,
							},
						],
					},
					{
						hooks: [
							{
								type: "command",
								command: runawayHookCommand(bin),
								timeout: 10,
							},
						],
					},
					trailerHookEntry(bin),
				],
			},
		},
		null,
		2,
	);
