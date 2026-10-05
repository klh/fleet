// corpus.ts — the W367.1 parity corpus: real-brief-shaped inputs
// (MISSION-style briefs, paths/flags/URLs/code, multi-paragraph, meta
// sentences, near-duplicate sentences). Frozen authoring-time data; the
// pin generator and the test suite both consume it.
//
// politenessParity: the politeness tier omits the W334 meta strip and the
// Jaccard dedupe (spec tier table), so politeness === suspenders bytes is
// only promised on inputs where those two stages are no-ops. Entries that
// carry meta sentences or near-duplicate sentences set it false.
export interface CorpusEntry {
	name: string;
	input: string;
	politenessParity: boolean;
}

export const CORPUS: CorpusEntry[] = [
	{
		name: "mission-login",
		politenessParity: true,
		input:
			"MISSION: fix the login regression on the settings page.\n\nHi there, could you please start by reproducing the bug on http://suspenders.local/settings and then fix packages/suspenders/hooks/lib/session.ts? Thank you very much!\n\nPlease run bun test --coverage when you are done.",
	},
	{
		name: "mission-meta",
		politenessParity: false,
		input:
			"MISSION: wire the belt router fallback.\n\nAlthough this prompt contains several items, the highest priority is the fallback path. Please add the retry ladder to packages/belt/src/router.ts and keep the timeout at 2500ms. The prompt was written in a hurry, so double-check the config keys.",
	},
	{
		name: "mission-near-dupe",
		politenessParity: false,
		input:
			"MISSION: ship the heartbeat fix.\n\nPlease regenerate the status.json heartbeat from the event loop before the probe reads it. Please regenerate the status.json heartbeat from the event loop before the sidecar reads it. The health sidecar judges by file age. The health sidecar judges by file age.",
	},
	{
		name: "code-fence",
		politenessParity: true,
		input:
			"Please update the deploy docs.\n\nThe hub push looks like:\n\n```bash\nbun deploy/hubctl.ts push nas\nbun deploy/hubctl.ts up nas\n```\n\nThank you in advance — and please mind that the NAS has no SFTP.",
	},
	{
		name: "inline-code",
		politenessParity: true,
		input:
			"Could you please check that `prompt.condense` is on by default and `prompt.enhance` stays off, then please flip the flag in ~/.config/klh/stack.yaml if needed.",
	},
	{
		name: "urls",
		politenessParity: true,
		input:
			"Read the docs at https://example.com/docs/prompt-condense#tiers and please also skim the FAQ page. Please bookmark both.",
	},
	{
		name: "paths-flags",
		politenessParity: true,
		input:
			"Please delete /var/tmp/stale-cache, then run ./scripts/prune.sh --dry-run and only after that the real prune -f. Also confirm ~/dev/dinero-auto/invoice-hunt.ts still passes bun test.",
	},
	{
		name: "dotted-identifiers",
		politenessParity: true,
		input:
			"Set prompt.condense to false in suspenders-board.json only if the board preview regresses; keep prompt.log on. The routing-policy.yaml ladder stays operator-owned.",
	},
	{
		name: "quoted-strings",
		politenessParity: true,
		input:
			'The board shows "please condense this preview" only when the toggle is on; the setting key is "prompt.debug". Please leave the quotes alone.',
	},
	{
		name: "format-lines",
		politenessParity: true,
		input:
			"Reply in this shape:\n\nFORMAT: <answer>\nANSWER: please keep it under 200 words\n\nPlease note the answer field is plain text.",
	},
	{
		name: "log-block",
		politenessParity: true,
		input:
			"The failure log is below.\n\n<log>\n2026-10-05 12:00:01 please retry the hub push\n2026-10-05 12:00:09 hub push ok after kindly waiting\n</log>\n\nPlease treat the log as immutable evidence.",
	},
	{
		name: "docquote",
		politenessParity: true,
		input:
			'The spec block stays verbatim:\n\n"""\nIt is important to note that the engine is pure.\n"""\n\nPlease import it by repo-relative path.',
	},
	{
		name: "multi-paragraph",
		politenessParity: true,
		input:
			"MISSION: audit the gate.\n\nHey, could you kindly walk the three gate moments and please note where the gate silently no-ops?\n\nThe .qlty directory must exist for the gate to run at all.\n\nThanks!",
	},
	{
		name: "doubled-words",
		politenessParity: true,
		input:
			"Please fix the the doubled word handling in the the tokenizer tests, and please please keep it deterministic.",
	},
	{
		name: "hedged-words",
		politenessParity: true,
		input:
			"Just add the retry wrapper — maybe guard the very last attempt, quite possibly with only one retry, perhaps three. Please keep it simple and really deterministic.",
	},
	{
		name: "numbers-tech",
		politenessParity: true,
		input:
			"Pin SQLite to WAL mode, keep port 7799, and please leave the 1500-line limit enforced by the gate. Deploy the board via hubctl and confirm status.json regenerates.",
	},
	{
		name: "kitchen-sink",
		politenessParity: false,
		input:
			"MISSION: land the condense engine.\n\nHi! Although this prompt is long, please bear with it.\n\nSteps:\n1. Add packages/blam/src/condense/engine.ts with the union protect grammar\n2. Wire bun test packages/blam/test/condense.test.ts --coverage\n3. Ping https://suspenders.local/fleet when landed\n\nThe prompt ends here. Thank you so much!",
	},
	{
		name: "tilde-fence",
		politenessParity: true,
		input:
			"Config template follows:\n\n~~~\nprompt.condense = true\nprompt.enhance = false\n~~~\n\nPlease apply it with hubctl render nas.",
	},
	{
		name: "greetings-classic",
		politenessParity: true,
		input:
			"Hello there,\n\nCould you please take the fleet board work item W367.1 and implement the engine? Hey, thanks in advance — kindly ping the board when the pins land.",
	},
	{
		name: "punct-mess",
		politenessParity: true,
		input:
			"Fix it!!!  now???   please.  Run the gate,, check the pins::: done;;  maybe.",
	},
	{
		name: "belt-phrase-cap",
		politenessParity: true,
		input:
			"Due to the fact that the router is down, could you retry the ladder. In order to fix it, make sure that the fallback fires. It is important to note that the CAP marker keeps capitalisation.",
	},
	{
		name: "articles",
		politenessParity: true,
		input:
			"The router retries; a timeout fires; an error surfaces. The API is stable.",
	},
	{
		name: "imperatives-numbers",
		politenessParity: true,
		input:
			"Add the shield, run the suite, verify the pins. Please do not skip the gate. Keep every number: 42, 7799, 1500.",
	},
	{
		name: "blank-runs",
		politenessParity: true,
		input:
			"First paragraph with a path ./x/y.ts.\n\n\n\nSecond paragraph after blank runs.   \nPlease tidy trailing spaces.\n",
	},
	{
		name: "mixed-meta-dupe",
		politenessParity: false,
		input:
			"MISSION: swap the consumers.\n\nAlthough this prompt carries context, the swap is mechanical. The swap is mechanical in every package. The swap is mechanical in each package. Please import the blam engine and the blam engine by repo-relative path. The prompt was long; the work is short.",
	},
];
