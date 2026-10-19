// scripts/lib/lane-settings.ts — W512: the lane --settings file composer.
// Two pin channels, one file: the env grammar pins the MAIN loop (the W228
// opus-alias + DEFAULT_OPUS remap — raw ids in the model option 400
// client-side) plus routing + token; the hooks block pins TASK calls via a
// PreToolUse updatedInput hook (call-time injection — the one channel no
// settings-env merge can clobber; user settings.json env merges OVER process
// env and killed every env-delivered pin, probed live 2026-10-05, W250).
// The file is 0600 — it carries the lane token.

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

/** The lane --settings file content: env grammar + the W512 Task pin hook.
 *  Pure — unit-testable. */
export const laneSettingsData = (
	env: Record<string, string>,
	model: string,
	bin: string,
): string =>
	JSON.stringify(
		{
			env: {
				ANTHROPIC_MODEL: env.ANTHROPIC_MODEL ?? "opus",
				ANTHROPIC_DEFAULT_OPUS_MODEL: model,
				ANTHROPIC_DEFAULT_SONNET_MODEL:
					env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? model,
				ANTHROPIC_DEFAULT_HAIKU_MODEL:
					env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? model,
				ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
				ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
				...runawayEnv(env),
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
				],
			},
		},
		null,
		2,
	);
