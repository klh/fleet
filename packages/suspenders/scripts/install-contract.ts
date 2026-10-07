// scripts/install-contract.ts — the machine-readable installer contract (W490.1).
// The LLM head: an agent driving this installer reads THIS document, never the
// source. Field names are frozen — a rename or removal bumps contractVersion;
// additive fields keep it. Config and secrets appear as PATH pointers only,
// never values (config-over-code law). Consumers: scripts/install.ts (--json
// embeds this verbatim) and test/install-contract.test.ts (drift checks).

/**
 * Version of this contract document. Bump on any rename/removal of a
 * documented field; additive fields keep the version.
 */
export const INSTALL_CONTRACT_VERSION = 1;

/** --step names are frozen — agents script against them. */
export type StepName =
	| "probeEnvironment"
	| "syncHarness"
	| "refreshSupervisor"
	| "ensureShims"
	| "seedLocalLlm"
	| "downloadModels"
	| "wireSettings"
	| "registerLaunchd"
	| "registerCaddy"
	| "releaseNotify"
	| "refreshDashboards";

export type StepV1 = "real" | "delegated" | "stub";

export interface ContractStep {
	/** frozen --step token */
	name: StepName;
	/** what the step does, one line */
	oneLiner: string;
	/** whether a successful run mutates the machine */
	mutates: boolean;
	/** optIn steps sit outside the default plan, reachable only via --step */
	optIn: boolean;
	/**
	 * v1 execution class: "real" = implemented here; "delegated" = covered by
	 * the single bash install.sh delegation on a consented full run; "stub" =
	 * not executable alone (pauses with the bash resume_command).
	 */
	v1: StepV1;
}

export interface ContractFlag {
	/** literal CLI token */
	flag: string;
	/** one-line meaning */
	meaning: string;
}

export interface ContractEnv {
	/** one-line meaning */
	meaning: string;
	/** default applied when unset (a PATH or a static, non-secret default) */
	default: string;
}

export interface ContractBashFlag {
	/** literal install.sh token — the working escape hatch until W488.1/W490.2 */
	flag: string;
	meaning: string;
	/** step of this installer that will absorb it */
	mappedStep: StepName;
}

export interface InstallContract {
	contractVersion: number;
	name: string;
	summary: string;
	/** how to drive this installer without a TTY */
	unattended: {
		/** the one consent flag — replaces every interactive confirmation */
		flag: "--yes";
		/** what replaces each decision a human would otherwise make */
		promptReplacements: Array<{
			prompt: string;
			unattended: string;
		}>;
	};
	/**
	 * Pause states are first-class: the installer NEVER blocks on a prompt.
	 * A step that needs a human decision stops the process with exit 0 and
	 * hands back a resume_command the agent can run (or decline) later.
	 */
	pause: {
		exitCode: 0;
		statusValue: "need_user_action";
		resumeField: "resume_command";
		semantics: string;
	};
	exitCodes: {
		"0": string;
		"1": string;
		"2": string;
	};
	/** the flags this CLI accepts — must equal the meow definition (drift-checked) */
	flags: {
		dryRun: ContractFlag;
		json: ContractFlag;
		yes: ContractFlag;
		verbose: ContractFlag;
		step: ContractFlag;
	};
	/** environment knobs, PATH/default pointers only — never values */
	env: {
		SUSPENDERS_PREFIX: ContractEnv;
		SUSPENDERS_SHIM_BIN: ContractEnv;
		BELT_URL: ContractEnv;
		BELT_TOKEN: ContractEnv;
		BELT_TIER: ContractEnv;
		SUSPENDERS_LLM_URL: ContractEnv;
		SUSPENDERS_LLM_MODEL: ContractEnv;
		SUSPENDERS_LLM_KEY: ContractEnv;
	};
	/** every install step, in plan order */
	steps: ContractStep[];
	/** install.sh flags the .ts installer does not re-expose yet */
	bashFlags: ContractBashFlag[];
	/**
	 * Hypermedia returned on every JSON outcome. Rules: field names are frozen
	 * (action/command/note); each command is SINGLE-USE — run it once per
	 * outcome, never poll or loop; re-inspect with --json before re-running.
	 */
	agentNextSteps: {
		fields: Array<"action" | "command" | "note">;
		rules: string[];
	};
	/** where the installer's state and machine config live — PATHS ONLY */
	state: {
		harnessPrefix: string;
		shimBin: string;
		llmHome: string;
		beltEnv: string;
		routingPolicy: string;
		stackYaml: string;
		claudeSettings: string;
		insightsDir: string;
		launchAgentsDir: string;
	};
	/** the v1 delegation that keeps this installer useful before W488.1/W490.2 */
	v1Delegation: {
		command: string;
		when: string;
		note: string;
	};
}

export const INSTALL_CONTRACT = {
	contractVersion: INSTALL_CONTRACT_VERSION,
	name: "suspenders-install",
	summary:
		"suspenders installer — copies the harness into the prefix, seeds the local-llm baseline, registers launchd agents; bun-native, scriptable, LLM-drivable",
	unattended: {
		flag: "--yes",
		promptReplacements: [
			{
				prompt: "install/refresh the harness at the prefix now?",
				unattended:
					"the default plan runs without asking; nothing here prompts",
			},
			{
				prompt: "wire hooks into ~/.claude/settings.json?",
				unattended:
					"v1: not a flag yet — the wireSettings pause carries the bash --wire resume_command",
			},
			{
				prompt: "install the macOS launchd agents?",
				unattended:
					"native since W490.2 — run the --step registerLaunchd --yes resume_command (renders deploy/services.yaml via install-services.ts, loads via load-launchd.sh, supersedes com.klh.* labels)",
			},
			{
				prompt: "download resident local-llm models?",
				unattended:
					"default plan delegates (models download); the bash --skip-models flag skips (see bashFlags)",
			},
			{
				prompt: "restart Claude Code so hooks register?",
				unattended:
					"surfaced as agent_next_steps after a delegated run — an agent reports it, a human does it",
			},
		],
	},
	pause: {
		exitCode: 0,
		statusValue: "need_user_action",
		resumeField: "resume_command",
		semantics:
			"a step that would prompt instead stops the run with exit 0 and emits pauses[].resume_command — run it to proceed with that concern, or decline; re-running the installer never blocks",
	},
	exitCodes: {
		"0": "ok — plan, step, pause (need_user_action) or contract emitted cleanly",
		"1": "runtime failure — a step or the delegated installer failed",
		"2": "usage error — unknown flag, unknown --step name, or unexpected positional",
	},
	flags: {
		dryRun: {
			flag: "--dry-run",
			meaning:
				"print the plan, zero side effects (read-only steps still observe)",
		},
		json: {
			flag: "--json",
			meaning:
				"machine output: one JSON document on stdout (contract + outcome + agent_next_steps); progress goes to stderr",
		},
		yes: {
			flag: "--yes",
			meaning:
				"unattended consent — mutating steps run (v1: via the bash delegation); without it mutating steps pause with a resume_command",
		},
		verbose: {
			flag: "--verbose",
			meaning: "include per-step detail and resolved paths in the outcome",
		},
		step: {
			flag: "--step",
			meaning:
				"run one step by frozen name (see steps[].name); unknown name = exit 2",
		},
	},
	env: {
		SUSPENDERS_PREFIX: {
			meaning: "harness install target",
			default: "~/.claude/hooks/suspenders",
		},
		SUSPENDERS_SHIM_BIN: {
			meaning: "where the coord/work/dispatch shims are written",
			default: "~/.local/bin",
		},
		BELT_URL: {
			meaning: "belt gateway URL templated into launchd agent plists",
			default: "http://127.0.0.1:4100",
		},
		BELT_TOKEN: {
			meaning:
				"belt auth token templated into launchd agent plists (secret — never echoed)",
			default: "",
		},
		BELT_TIER: {
			meaning: "model tier the registry resolves for downloads",
			default: "minimal",
		},
		SUSPENDERS_LLM_URL: {
			meaning:
				"LLM endpoint for the advice worker (runtime knob, not installer)",
			default: "local swarm router",
		},
		SUSPENDERS_LLM_MODEL: {
			meaning: "LLM model for the advice worker (runtime knob, not installer)",
			default: "registry resident",
		},
		SUSPENDERS_LLM_KEY: {
			meaning: "LLM key for the advice worker (secret — never echoed)",
			default: "",
		},
	},
	steps: [
		{
			name: "probeEnvironment",
			oneLiner:
				"verify bun on PATH and capture platform/version — read-only, always safe",
			mutates: false,
			optIn: false,
			v1: "real",
		},
		{
			name: "syncHarness",
			oneLiner:
				"stage committed harness code and offline dependencies, validate imports, publish with rollback receipt; no services restarted",
			mutates: true,
			optIn: false,
			v1: "real",
		},
		{
			name: "refreshSupervisor",
			oneLiner:
				"refresh the existing kit serve or advanced Belt supervisor code with backup and import validation; preserve machine config",
			mutates: true,
			optIn: true,
			v1: "stub",
		},
		{
			name: "ensureShims",
			oneLiner: "write the coord/work/dispatch PATH shims into the shim bin",
			mutates: true,
			optIn: false,
			v1: "delegated",
		},
		{
			name: "seedLocalLlm",
			oneLiner:
				"seed the local-llm baseline into the runtime home — kit files and config stubs only when absent, never clobber",
			mutates: true,
			optIn: false,
			v1: "delegated",
		},
		{
			name: "downloadModels",
			oneLiner:
				"download the BELT_TIER=minimal resident models via mlx-lm, resumable",
			mutates: true,
			optIn: false,
			v1: "delegated",
		},
		{
			name: "wireSettings",
			oneLiner:
				"merge hook registrations into ~/.claude/settings.json per-event, never clobber",
			mutates: true,
			optIn: true,
			v1: "stub",
		},
		{
			name: "registerLaunchd",
			oneLiner:
				"render deploy/services.yaml via install-services.ts and load the macOS launchd agents, supersede legacy labels",
			mutates: true,
			optIn: true,
			v1: "real",
		},
		{
			name: "registerCaddy",
			oneLiner:
				"optionally register the board with klh-local/Caddy for suspenders.local — non-fatal",
			mutates: true,
			optIn: false,
			v1: "delegated",
		},
		{
			name: "releaseNotify",
			oneLiner:
				"emit the RELEASE event on the coord bus — the distributed changelog, non-fatal",
			mutates: true,
			optIn: false,
			v1: "delegated",
		},
		{
			name: "refreshDashboards",
			oneLiner:
				"safe GUI-only activation: refresh belt dashboards via scripts/refresh-dashboards.ts",
			mutates: true,
			optIn: true,
			v1: "real",
		},
	],
	bashFlags: [
		{
			flag: "--refresh-gateway",
			meaning:
				"targeted minimal-swarm gateway supervision and model limits upgrade (early exit)",
			mappedStep: "seedLocalLlm",
		},
		{
			flag: "--wire",
			meaning: "merge hooks into ~/.claude/settings.json",
			mappedStep: "wireSettings",
		},
		{
			flag: "--with-launchd",
			meaning:
				"install the macOS launchd agents — native since W490.2: --step registerLaunchd --yes",
			mappedStep: "registerLaunchd",
		},
		{
			flag: "--refresh-supervisor",
			meaning:
				"code-only refresh of the installed supervisor family; preserve machine configuration",
			mappedStep: "refreshSupervisor",
		},
		{
			flag: "--refresh-dashboards",
			meaning: "safe GUI-only dashboard refresh (early exit)",
			mappedStep: "refreshDashboards",
		},
		{
			flag: "--skip-models",
			meaning: "skip model download (offline installs)",
			mappedStep: "downloadModels",
		},
		{
			flag: "--no-llm",
			meaning: "skip the local-llm baseline entirely (CI/containers)",
			mappedStep: "seedLocalLlm",
		},
	],
	agentNextSteps: {
		fields: ["action", "command", "note"],
		rules: [
			"field names are frozen; do not infer alternatives",
			"each command is single-use: run it once per outcome, never poll or loop",
			"re-inspect with --json before re-running anything",
		],
	},
	state: {
		harnessPrefix: "~/.claude/hooks/suspenders (override: SUSPENDERS_PREFIX)",
		shimBin: "~/.local/bin (override: SUSPENDERS_SHIM_BIN)",
		llmHome: "~/.claude/local-llm/",
		beltEnv: "~/.claude/local-llm/belt.env",
		routingPolicy: "~/.claude/local-llm/routing-policy.yaml",
		stackYaml: "~/.config/klh/stack.yaml",
		claudeSettings: "~/.claude/settings.json",
		insightsDir: "~/.claude-insights",
		launchAgentsDir: "~/Library/LaunchAgents",
	},
	v1Delegation: {
		command: "bash <repo>/install.sh __legacy full",
		when: "a full run (no --step) with --yes",
		note: "since W490.2 install.sh's public face is the TS installer wrapper; the delegation targets the wrapper's __legacy full body — the legacy blocks (harness copy, shims, llm seed, models, caddy, release) that have no native step yet",
	},
} as const satisfies InstallContract;

export type StepStatus =
	| "ok"
	| "planned"
	| "delegated"
	| "skipped"
	| "need_user_action"
	| "failed";

export type OutcomeStatus =
	| "ok"
	| "need_user_action"
	| "failed"
	| "usage_error";

export interface StepOutcomeRow {
	name: StepName;
	status: StepStatus;
	note: string;
	detail?: string;
}

export interface PauseRow {
	step: StepName;
	reason: string;
	resume_command: string;
}

export interface AgentNextStep {
	action: string;
	command: string;
	note?: string;
}

export interface InstallOutcome {
	schema: "suspenders.install.v1";
	contractVersion: number;
	ok: boolean;
	/** present on usage_error outcomes */
	error?: string;
	outcome: OutcomeStatus;
	mode: "plan" | "step";
	flags: {
		dryRun: boolean;
		json: boolean;
		yes: boolean;
		verbose: boolean;
		step: string | null;
	};
	paths: {
		repo: string;
		prefix: string;
		shimBin: string;
		llmHome: string;
	};
	steps: StepOutcomeRow[];
	pauses: PauseRow[];
	agent_next_steps: AgentNextStep[];
	contract: InstallContract;
}
