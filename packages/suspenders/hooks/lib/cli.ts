// cli.ts — tiny typed arg/cmd toolkit for the fleet's CLIs (W421). One
// declarative spec per verb — flags, switches, required flags, minimum
// positionals, usage line — replaces the hand-rolled parseArgs/SCHEMA/usage
// copies that work.ts, coord.ts and fleet-loop.ts each carried. Zero deps,
// zero internal imports: self-contained by design so any repo in the stack
// (or beyond it) can vendor this one file.
//
// Semantics (byte-compatible with the plumbing this replaces):
//   - value flags: first occurrence wins, a known flag consumes the next
//     token verbatim, a trailing flag yields null
//   - `--help` / `-h` anywhere short-circuits before validation — help
//     never dies on unknown options or missing required flags
//   - unknown `--options` die with the usage line unless the command is lax
//   - violations die with the command's usage line BEFORE any state is
//     touched; parseCommand only throws — the caller owns the exit
//   - `--flag=value` is intentionally NOT parsed: token-based like the
//     plumbing it replaces (handlers with equals-syntax parse their own)

export interface FlagDef {
	/** "string" (default) consumes the next token; "switch" is boolean */
	type?: "string" | "switch";
	/** die with the usage line when absent (value flags only) */
	required?: boolean;
	/** one-line description shown by helpOf() */
	desc?: string;
}

export interface CommandDef {
	/** full invocation path as shown in usage lines, e.g. "coord emit" */
	name: string;
	/** one-liner for command lists and help */
	about?: string;
	/** usage line override (die + help) — generated from flags when omitted */
	usage?: string;
	/** positional sketch for generated usage lines, e.g. "<id>" */
	posHint?: string;
	flags?: Record<string, FlagDef>;
	/** die when fewer positionals */
	minPos?: number;
	/** unknown --options pass through (commands that predate strict parsing) */
	lax?: boolean;
}

export interface Parsed {
	pos: string[];
	/** `--help` / `-h` seen — validation skipped, caller prints helpOf() */
	help: boolean;
	/** was the flag seen at all (switches and value flags alike) */
	has(name: string): boolean;
	/** value-flag read: null when absent or trailing */
	flag(name: string): string | null;
	/** numeric read with default; a non-finite value dies with the usage */
	num(name: string, dflt: number): number;
}

// thrown on parse/validation failure; `helpText` is the full help block the
// caller should print, `message` the one-line usage violation
export class CliError extends Error {
	constructor(
		message: string,
		readonly helpText: string,
	) {
		super(message);
	}
}

// auto usage line: `usage: coord emit [--scope <v>] [--json] <id>`
export function usageOf(def: CommandDef): string {
	if (def.usage) return def.usage; // explicit line always wins
	const parts: string[] = [`usage: ${def.name}`];
	for (const [flagName, f] of Object.entries(def.flags ?? {})) {
		if (f.required) parts.push(`${flagName} <v>`);
		else if (f.type === "switch") parts.push(`[${flagName}]`);
		else parts.push(`[${flagName} <v>]`);
	}
	if (def.posHint) parts.push(def.posHint);
	return parts.join(" ");
}

// full help block: the usage line + one line per declared flag
export function helpOf(def: CommandDef): string {
	const lines: string[] = [def.usage ?? usageOf(def)];
	if (def.about) lines.push(`  ${def.about}`);
	for (const [flagName, f] of Object.entries(def.flags ?? {})) {
		const use = f.type === "switch" ? flagName : `${flagName} <v>`;
		const tag = f.required ? " (required)" : "";
		const desc = f.desc ? ` — ${f.desc}` : "";
		lines.push(`  ${use}${tag}${desc}`);
	}
	return lines.join("\n");
}

export function parseCommand(def: CommandDef, argv: string[]): Parsed {
	const flags = def.flags ?? {};
	const help = argv.includes("--help") || argv.includes("-h");
	const pos: string[] = [];
	const vals = new Map<string, string | null>();
	const seen = new Set<string>();
	if (!help) {
		for (let i = 0; i < argv.length; i++) {
			const t = argv[i];
			if (t === undefined) break;
			if (flags[t]?.type === "switch") {
				seen.add(t);
				vals.set(t, "true"); // switches read like flags: flag("--json") === "true"
				continue;
			}
			if (flags[t]) {
				if (!vals.has(t)) vals.set(t, argv[i + 1] ?? null);
				seen.add(t);
				i++;
				continue;
			}
			if (t.startsWith("--")) {
				if (def.lax) continue;
				throw new CliError(`unknown option: ${t}`, helpOf(def));
			}
			pos.push(t);
		}
	}
	const missing = Object.entries(flags).filter(
		([flagName, f]) => f.required && (!vals.has(flagName) || vals.get(flagName) === null),
	);
	if (
		!help &&
		(pos.length < (def.minPos ?? 0) || missing.length > 0)
	)
		throw new CliError(def.usage ?? usageOf(def), helpOf(def));
	return {
		pos,
		help,
		has: (name: string): boolean => seen.has(name),
		flag: (name: string): string | null => vals.get(name) ?? null,
		num: (name: string, dflt: number): number => {
			const v = vals.get(name);
			if (v === null || v === undefined) return dflt;
			const n = Number(v);
			if (!Number.isFinite(n))
				throw new CliError(
					`option ${name} wants a number, got "${v}"`,
					helpOf(def),
				);
			return n;
		},
	};
}

// ---- cmd level: one binary, many verbs ------------------------------------

export interface CliDef {
	/** binary name, leads the overview line */
	name: string;
	/** one-liner after the binary name in the overview */
	about?: string;
	/** verb → spec; insertion order is the printed verb-list order */
	commands: Record<string, CommandDef>;
	/** trailing overview lines (verbatim) */
	notes?: string[];
}

// the verb list behind both the overview and the unknown-command die —
// one source, never two copy-pasted strings
export function verbList(cli: CliDef): string {
	return Object.keys(cli.commands).join(" | ");
}

export function cliHelp(cli: CliDef): string {
	const lines = [`${cli.name} — ${cli.about ?? ""}`, `  ${verbList(cli)}`];
	if (cli.notes) lines.push(...cli.notes);
	return lines.join("\n");
}

// top-level dispatcher. Bare invocation or a leading `--help`/`-h` prints
// the overview to stdout and exits 0; `<verb> --help` prints the verb's
// help block and exits 0; an unknown verb throws CliError (caller dies).
// Success returns the verb, the RAW post-verb tokens (for handlers that
// close over argv) and the parsed args.
export function runCli(
	cli: CliDef,
	argv: string[],
): { cmd: string; rest: string[]; args: Parsed } {
	const cmd = argv[0];
	if (!cmd || cmd === "--help" || cmd === "-h") {
		console.log(cliHelp(cli));
		process.exit(0);
	}
	const def = cli.commands[cmd];
	if (!def) throw new CliError(`unknown command — try ${verbList(cli)}`, cliHelp(cli));
	const args = parseCommand(def, argv.slice(1));
	if (args.help) {
		console.log(helpOf(def));
		process.exit(0);
	}
	return { cmd, rest: argv.slice(1), args };
}
