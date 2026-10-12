// hooks/bin/policy-advisor.ts — W161 policy advisor entry. Runs the
// machine-checkable policy catalog (hooks/lib/policy/) against a repo root —
// the worked-on service. Violations surface as SUGGESTIONS with policy
// citation + opt-in implement-and-PR offer; never a silent mutation: this
// tool never edits, never commits, never opens a PR — the implement-and-PR
// step is a human opt-in, and PRs land on branches, never straight to main.
//
// CLI (W656.3 verb-kit): `policy-advisor --help` for the generated face —
// the `check` verb is the default (bare/flag-first argv rides it, the old
// verb-less face preserved): [root] [--rule <id>]... [--json] [--manifest]
// [--strict].

import { catalogManifest } from "../lib/policy/catalog.ts";
import { runPolicyChecks } from "../lib/policy/checks.ts";
import { defineVerb, runCli, type VerbSpec } from "../lib/verb-kit.ts";
import type { PolicyRunResult } from "../lib/policy/types.ts";

// exported for the test suite — parse semantics ride the kit (parseVerb)
export const CHECK_VERB: VerbSpec = defineVerb({
	name: "check",
	usage:
		"usage: policy-advisor [check] [root] [--rule <id>]... [--json] [--manifest] [--strict]",
	flags: ["--rule"],
	switches: ["--json", "--manifest", "--strict"],
});

/** Human report: finding → where + detail, policy citation, fix, offer. */
export function renderHuman(out: PolicyRunResult): string {
	const L: string[] = [];
	L.push(
		`[policy ${out.version}] root: ${out.root} — ${String(out.checked.length)} rules`,
	);
	for (const f of out.findings) {
		L.push("");
		L.push(`  ✗ ${f.rule} — ${f.title}`);
		L.push(`    where:  ${f.where} — ${f.detail}`);
		L.push(`    policy: ${f.citation}`);
		L.push(`    fix:    ${f.fix}`);
		L.push(`    offer:  ${f.offer}`);
	}
	L.push("");
	const dirty = new Set(out.findings.map((f) => f.rule));
	const clean = out.checked.filter((r) => !dirty.has(r)).length;
	L.push(
		`${String(out.findings.length)} finding(s) · ${String(clean)} rule(s) clean · ${String(out.skipped.length)} skipped`,
	);
	for (const n of out.notes) L.push(`  note: ${n}`);
	if (out.findings.length === 0) L.push("  ✓ no policy violations found");
	return L.join("\n");
}

if (import.meta.main) {
	// the old verb-less face: a non-verb, non-flag head token is the root
	// positional, not a command — prefix the default verb and let the kit parse
	const rest = process.argv.slice(2);
	const head = rest[0];
	const tokens =
		head !== undefined && head !== "check" && !head.startsWith("-")
			? ["check", ...rest]
			: rest;
	await runCli({
		prog: "policy-advisor",
		about: "policy-advisor — W161 policy catalog vs a repo root.",
		verbs: [CHECK_VERB],
		defaultVerb: "check",
		argv: ["bun", "hooks/bin/policy-advisor.ts", ...tokens],
		dispatch: async (_name, p) => {
			if (p.flag("--manifest")) {
				console.log(JSON.stringify(catalogManifest(), null, "\t"));
				return 0;
			}
			const rules = p.all("--rule");
			const out = runPolicyChecks(
				p.pos[0] ?? process.cwd(),
				rules.length > 0 ? { rules } : {},
			);
			if (p.flag("--json")) console.log(JSON.stringify(out, null, "\t"));
			else console.log(renderHuman(out));
			return p.flag("--strict") && out.findings.length > 0 ? 1 : undefined;
		},
	});
}
