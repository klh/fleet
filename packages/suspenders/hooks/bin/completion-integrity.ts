#!/usr/bin/env bun
// hooks/bin/completion-integrity.ts — W2949 post-DONE branch-drift census.
// Generic detection only: walks DONE items that banked a result_sha and
// compares it to the live branch head at refs/heads/suspenders/<id> —
// descendant = base moved ahead (benign base move), divergent = history
// rewritten (finding). Never resets content, never re-banks (DONE records
// are immutable), never hardcodes rider paths; write-time rejection of
// post-DONE mutation is W2954's lane. Companion to the Part-A one-off
// re-anchors of W2941/W2942 (both root-verified).
//
//   bun hooks/bin/completion-integrity.ts [--act] [--repo <dir>]
//
// Exit 1 when a dry-run finds drift (a human or the loop should notice);
// 0 clean or after an acted census. Episode state rides
// .fleet/completion-integrity.json (re-emit only on head change).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import { openStore, projectIdentity } from "../lib/govdb/govdb.ts";
import { canonicalProjectRoot } from "../lib/lanes/lane-registry.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "completion-integrity",
	usage:
		"usage: bun completion-integrity.ts [--act] [--repo <dir>] — census DONE items whose branch head drifted from the banked result_sha; work.completion_drift + NEED_DECISION per finding with --act",
	flags: ["--repo"],
	switches: ["--act"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("completion-integrity")(outcome.message ?? SPEC.usage ?? "");

const act = outcome.parsed.flag("--act") === "true";
const repo = outcome.parsed.flag("--repo") ?? process.cwd();
const root = canonicalProjectRoot(repo);

interface DriftEpisode {
	head: string;
	at: number;
}
interface DriftState {
	[item: string]: DriftEpisode;
}
const stateFile = join(root, ".fleet", "completion-integrity.json");
const loadState = (): DriftState => {
	try {
		return JSON.parse(readFileSync(stateFile, "utf8")) as DriftState;
	} catch {
		return {};
	}
};

const store = openStore();
const project = projectIdentity(root);
const state = loadState();
const next: DriftState = {};
const now = Date.now();
const findings: string[] = [];

// live branch heads under refs/heads/suspenders/ — refname:short keeps the
// `suspenders/<id>` form, so the map key matches the branch name directly
const heads = new Map<string, string>();
const refs = Bun.spawnSync(
	[
		"git",
		"-C",
		root,
		"for-each-ref",
		"refs/heads/suspenders/",
		"--format=%(refname:short) %(objectname)",
	],
	{ stdout: "pipe", stderr: "pipe" },
);
for (const line of refs.stdout.toString().split("\n")) {
	const m = line.trim().match(/^(\S+)\s+([0-9a-f]{40})$/);
	if (m) heads.set(m[1], m[2]);
}

// one acted finding: work.completion_drift + NEED_DECISION on the item.
// DONE is immutable — the decision asks for a re-anchor or an explicit
// repair item, never a silent re-bank.
const fireDrift = (
	item: string,
	banked: string,
	head: string,
	relation: string,
): void => {
	emitLoopEvent(
		"work.completion_drift",
		item,
		{ project, banked, head, relation },
		store,
	);
	emitLoopEvent(
		"NEED_DECISION",
		item,
		{
			project,
			reason: `DONE branch suspenders/${item} head ${head.slice(0, 8)} is a ${relation} of banked ${banked.slice(0, 8)} — re-anchor the branch to the banked sha or mints an explicit repair item`,
		},
		store,
	);
};

// census: DONE items with a banked result_sha, compared to the branch head.
// absent → skip; head === banked → skip (drops healed episodes from next);
// unchanged head → carry the prior episode silently; else a new episode.
const rows = store
	.query(
		"SELECT id, result_sha FROM work_items WHERE project = ? AND state = 'DONE' AND result_sha IS NOT NULL AND result_sha != ''",
	)
	.all(project) as Array<{ id: string; result_sha: string }>;
for (const row of rows) {
	const branch = `suspenders/${row.id}`;
	const head = heads.get(branch);
	if (!head) continue; // branch gone or never created — nothing to guard
	if (head === row.result_sha) continue; // at-banked: healed or never moved
	const prior = state[row.id];
	if (prior && prior.head === head) {
		next[row.id] = prior; // same-head carry: already banked, stay silent
		continue;
	}
	next[row.id] = { head, at: now };
	const rel = Bun.spawnSync(
		["git", "-C", root, "merge-base", "--is-ancestor", row.result_sha, head],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const relation = rel.exitCode === 0 ? "descendant" : "divergent";
	findings.push(
		`COMPLETION-DRIFT ${row.id} — suspenders/${row.id} head ${head.slice(0, 8)} is a ${relation} of banked ${row.result_sha.slice(0, 8)} (${act ? "acted" : "dry-run"})`,
	);
	if (act) fireDrift(row.id, row.result_sha, head, relation);
}

// episode state: banked ONLY on --act, atomically (tmp + rename) — a torn
// write would break the dedupe and re-fire events every cycle. mkdirSync
// first: .fleet/ may not exist in a fresh repo.
if (act && JSON.stringify(next) !== JSON.stringify(state)) {
	try {
		mkdirSync(join(root, ".fleet"), { recursive: true });
		const tmp = `${stateFile}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
		renameSync(tmp, stateFile);
	} catch (error) {
		console.error(`completion-integrity: state write failed: ${String(error)}`);
		store.close();
		process.exit(1);
	}
}
console.log(
	findings.length > 0 ? findings.join("\n") : "completion-integrity: clean",
);
store.close();
process.exit(findings.length > 0 && !act ? 1 : 0);
