// verb-kit.ts — W651: the ONE way klh CLIs declare, parse, and explain
// verbs. One declaration per verb (defineVerb) into a typed registry; the
// kit owns argv parsing (including the Bun strips-`--` reality, W250),
// per-verb + whole-registry help rendering, the uniform `prog: message`
// die format, and `--help` for every verb. Replaces the three dispatch
// styles that coexisted before (work.ts inline schema, coord.ts hand-maintained
// usage block, one-off USAGE consts) — new CLIs MUST ride this kit.
//
// Two doors:
//   process-owned CLIs   → runCli({prog, about, verbs, ...}): resolves the
//                          verb, intercepts --help, parses, validates, dies
//                          with the caller's prog prefix, dispatches (spec.run
//                          or a local dispatch callback for legacy chains).
//   embedded mains       → parseVerb / renderVerbHelp / renderRegistryHelp
//                          return values and throw nothing — the host owns
//                          exit codes and output streams.

// W250: Bun strips a leading `--` BEFORE process.argv — no kit parser
// assumes a `--` slot anywhere; tokens are argv.slice(2) verbatim. A
// `--` that survives (node/deno exec, mid-argv) parses as an end-of-options
// separator: everything after it becomes positionals.

export type Parsed = {
	name: string;
	pos: string[];
	rest: string[];
	flag: (name: string) => string | null;
	all: (name: string) => string[];
};

export type VerbSpec = {
	name: string;
	/** one-line usage — die'd on parse violation, printed by per-verb help */
	usage?: string;
	/** value-taking flags; a known flag consumes the next token (first wins) */
	flags?: string[];
	/** boolean switches — checked BEFORE flags, consume no value */
	switches?: string[];
	minPos?: number;
	reqFlags?: string[];
	/** ignore unknown options (legacy verbs that predate strict parsing) */
	lax?: boolean;
	/** returning a number exits the process with it (embedded-main door) */
	run?: (p: Parsed) => unknown;
};

export type ParseOutcome =
	| { ok: true; parsed: Parsed }
	| { ok: false; kind: "error" | "help"; message: string };

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export const defineVerb = (spec: VerbSpec): VerbSpec => {
	if (!NAME_RE.test(spec.name))
		throw new Error(`verb-kit: bad verb name: ${spec.name}`);
	const flags = spec.flags ?? [];
	for (const f of spec.reqFlags ?? [])
		if (!flags.includes(f))
			throw new Error(
				`verb-kit: ${spec.name}: required flag ${f} is not a declared flag`,
			);
	if ((spec.minPos ?? 0) > 0 && !spec.usage)
		throw new Error(
			`verb-kit: ${spec.name}: minPos > 0 requires a usage line`,
		);
	return spec;
};

// generic parse + validate: known flags consume their value (first occurrence
// wins, a trailing flag yields null), everything non-flag is a positional,
// every occurrence lands in all(). Violations return an error carrying the
// verb's usage line — before any state is touched.
export const parseVerb = (spec: VerbSpec, rest: string[]): ParseOutcome => {
	const flags = spec.flags ?? [];
	const switches = spec.switches ?? [];
	const pos: string[] = [];
	const vals = new Map<string, string | null>();
	const seen = new Map<string, string[]>();
	let endOfFlags = false;
	for (let i = 0; i < rest.length; i++) {
		const t = rest[i];
		if (!endOfFlags && t === "--") {
			endOfFlags = true; // end-of-options: the rest are positionals
			continue;
		}
		if (!endOfFlags && switches.includes(t)) {
			vals.set(t, "true");
			continue;
		}
		if (!endOfFlags && flags.includes(t)) {
			const v = rest[i + 1] ?? null;
			if (!vals.has(t)) vals.set(t, v);
			seen.set(t, [...(seen.get(t) ?? []), v ?? ""]);
			i++;
			continue;
		}
		if (!endOfFlags && t.startsWith("--")) {
			if (spec.lax) continue;
			return { ok: false, kind: "error", message: `unknown option: ${t}` };
		}
		pos.push(t);
	}
	const missing = (spec.reqFlags ?? []).some(
		(f) => !vals.has(f) || vals.get(f) === null,
	);
	if (pos.length < (spec.minPos ?? 0) || missing)
		return { ok: false, kind: "error", message: spec.usage ?? "" };
	return {
		ok: true,
		parsed: {
			name: spec.name,
			pos,
			rest,
			flag: (n: string): string | null => vals.get(n) ?? null,
			all: (n: string): string[] => seen.get(n) ?? [],
		},
	};
};

// per-verb help: the usage line + the flag vocabulary (switches fold in)
export const renderVerbHelp = (spec: VerbSpec): string => {
	const lines: string[] = [];
	if (spec.usage) lines.push(spec.usage);
	const flags = [...(spec.flags ?? [])];
	for (const s of spec.switches ?? [])
		if (!flags.includes(s)) flags.push(s);
	if (flags.length) lines.push(`  flags: ${flags.join(" ")}`);
	return lines.join("\n");
};

// whole-registry help: about + every verb name in registration order (+epilog)
export const renderRegistryHelp = (
	prog: string,
	about: string,
	verbs: VerbSpec[],
	epilog?: string,
): string => {
	void prog;
	const lines = [`${about} ${verbs.map((v) => v.name).join(" | ")}`];
	if (epilog) lines.push(epilog);
	return lines.join("\n");
};

export const dieFor =
	(prog: string) =>
	(m: string): never => {
		console.error(`${prog}: ${m}`);
		process.exit(2);
	};

export type RunCliOpts = {
	prog: string;
	about: string;
	verbs: VerbSpec[];
	epilog?: string;
	/** tokens AFTER the script path; defaults to process.argv (kit slices :2) */
	argv?: string[];
	/** notified with the parsed verb right before dispatch */
	onVerb?: (name: string, parsed: Parsed) => void;
	/** legacy dispatch callback — used when the resolved spec has no run */
	dispatch?: (name: string, parsed: Parsed) => unknown;
	/** runs after a verb completes without dying (mirror refresh, sweeps) */
	after?: (name: string) => void;
};

export const runCli = async (opts: RunCliOpts): Promise<void> => {
	const die = dieFor(opts.prog);
	// W250: never assume a `--` slot — argv.slice(2) verbatim
	const tokens = (opts.argv ?? process.argv).slice(2);
	const byName = new Map(opts.verbs.map((v) => [v.name, v]));
	const names = opts.verbs.map((v) => v.name);
	if (!tokens.length) {
		console.error(
			`usage: ${opts.prog} <command> [args] — try \`${opts.prog} --help\``,
		);
		process.exit(2);
	}
	if (tokens[0] === "--help" || tokens[0] === "-h") {
		console.log(
			renderRegistryHelp(opts.prog, opts.about, opts.verbs, opts.epilog),
		);
		process.exit(0);
	}
	const spec = byName.get(tokens[0]);
	if (!spec) die(`unknown command — try ${names.join(" | ")}`);
	const rest = tokens.slice(1);
	// --help anywhere wins before any parsing that could create state
	if (rest.includes("--help") || rest.includes("-h")) {
		const help = renderVerbHelp(spec);
		if (help) console.log(help);
		process.exit(0);
	}
	const outcome = parseVerb(spec, rest);
	if (!outcome.ok)
		die(
			outcome.message ||
				`usage: ${spec.name} — see \`${opts.prog} ${spec.name} --help\``,
		);
	const parsed = outcome.parsed;
	opts.onVerb?.(spec.name, parsed);
	if (spec.run) {
		const r = await spec.run(parsed);
		if (typeof r === "number") process.exit(r);
	} else if (opts.dispatch) {
		const r = await opts.dispatch(spec.name, parsed);
		if (typeof r === "number") process.exit(r);
	} else {
		die(`verb has no handler: ${spec.name}`);
	}
	opts.after?.(spec.name);
};
