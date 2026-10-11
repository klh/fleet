#!/usr/bin/env bun
// morph.ts — AST-grade structural edits with transactional guardrails (W79).
// Recipes mutate an in-memory ts-morph project of every .ts under --root,
// then either print the unified diff (dry-run, default) or land everything in
// ONE saveSync (lib/morph.ts finish()). Abort conditions: zero matches, a
// --count mismatch (splice.ts discipline), or any NEW pre-emit diagnostic —
// in every abort case nothing reaches disk.
//
// usage: GENERATED from the verb registry — `morph --help`.
import { loadSession } from "../lib/morph";
import type { Outcome } from "../lib/morph";
import { moveSymbol, organizeImports, renameSymbol } from "../lib/morph";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderRegistryHelp,
	type Parsed,
	type VerbSpec,
} from "../lib/verb-kit.ts";

const die = dieFor("morph");

const VERBS: VerbSpec[] = [
	defineVerb({
		name: "rename",
		usage:
			"usage: morph rename <file> --symbol OLD --to NEW [--count N] [--apply]",
		flags: ["--count", "--symbol", "--to", "--root"],
		reqFlags: ["--symbol", "--to"],
		switches: ["--apply"],
		minPos: 1,
	}),
	defineVerb({
		name: "move",
		usage: "usage: morph move <file> --symbol NAME --to TARGET.ts [--apply]",
		flags: ["--symbol", "--to", "--root"],
		reqFlags: ["--symbol", "--to"],
		switches: ["--apply"],
		minPos: 1,
	}),
	defineVerb({
		name: "organize",
		usage: "usage: morph organize [file...] [--apply]",
		flags: ["--root"],
		switches: ["--apply"],
	}),
];

const EPILOG = `recipes:
  rename <file> --symbol OLD --to NEW [--count N]
      AST rename across every loaded file (language-service backed).
  move <file> --symbol NAME --to TARGET.ts
      Move one top-level declaration to TARGET and add imports where used.
      Moves only the declaration — its own dependencies stay put; the
      diagnostics gate aborts if that leaves NEW type errors.
  organize [file...]
      organizeImports on the named files (default: all loaded files).

guardrails: dry-run by default. Zero matches, a --count mismatch, or any NEW
pre-emit diagnostic after mutation aborts with exit 2 and writes nothing.
On success everything lands through exactly one project.saveSync().`;

// kit door (W656.2): resolve the recipe, parse its flags — the kit owns
// help, unknown recipes and parse violations (uniform `morph: message` die)
const argv = process.argv.slice(2);
if (!argv.length) die("usage: morph <recipe> — try `morph --help`");
if (argv[0] === "--help" || argv[0] === "-h") {
	console.log(
		renderRegistryHelp(
			"morph",
			"morph — AST-grade structural edits (W79).",
			VERBS,
			EPILOG,
		),
	);
	process.exit(0);
}
const spec = VERBS.find((v) => v.name === argv[0]);
if (!spec)
	die(`unknown recipe "${String(argv[0])}" — try rename | move | organize`);
const outcome = parseVerb(spec, argv.slice(1));
if (!outcome.ok) die(outcome.message || (spec.usage ?? ""));
const p: Parsed = outcome.parsed;

const countRaw = p.flag("--count");
const count = countRaw === null ? undefined : Number(countRaw);
if (count !== undefined && (!Number.isInteger(count) || count < 1))
	die(`--count must be a positive integer, got ${countRaw ?? ""}`);

const symbol = p.flag("--symbol") ?? undefined;
const to = p.flag("--to") ?? undefined;
const apply = p.flag("--apply") === "true";
const roots = p.all("--root").filter(Boolean);
if (roots.length === 0) roots.push(process.cwd());
// reqFlags guarantee --symbol/--to for rename/move at parse — narrowing only
if (p.name !== "organize" && (!symbol || !to))
	die(`${p.name} needs --symbol and --to`);

const s = await loadSession(roots);
let out: Outcome;
if (p.name === "rename") {
	out = renameSymbol(s, { file: p.pos[0], from: symbol, to, count, apply });
} else if (p.name === "move") {
	out = moveSymbol(s, { file: p.pos[0], name: symbol, target: to, apply });
} else {
	out = organizeImports(s, { only: p.pos, apply });
}

if (!out.ok) {
	console.error(`morph: ${out.error}`);
	for (const d of out.diags ?? []) console.error(`  TS: ${d}`);
	process.exit(2);
}
if (out.diff) console.log(out.diff);
console.log(`morph: ${out.note}`);
process.exit(0);
