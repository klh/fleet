#!/usr/bin/env bun
// hooks/bin/cred-gap-scan.ts — W1211 misroute detection. Scans recent lane
// logs for auth/credential failures (classifyCredError) and turns a hit
// into a requires.gap event + an automatic requires-stamp on the item: the
// next dispatch briefs the REAL requirement (routes to a machine that
// declared the scope) instead of retrying blind. Dry-run default (monitor
// doctrine — the report is the product); the W779 maintenance registry
// fires it with --act every 10 min. Episode state rides
// .fleet/cred-gaps.json (re-emit only on scope change or 24h).
//
//   bun hooks/bin/cred-gap-scan.ts [--act] [--repo <dir>]
//
// Exit 1 when a dry-run finds candidates (a human or the loop should
// notice); 0 clean or after an acted scan.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCredError, stampRequires } from "../lib/cred-scope.ts";
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import { openStore, projectIdentity } from "../lib/govdb.ts";
import {
	canonicalProjectRoot,
	readLaneRegistry,
	type RegistryLane,
} from "../lib/lane-registry.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "cred-gap-scan",
	usage:
		"usage: bun cred-gap-scan.ts [--act] [--repo <dir>] — scan lane logs for credential/auth failures; requires.gap event + item requires-stamp per hit",
	flags: ["--repo"],
	switches: ["--act"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("cred-gap-scan")(outcome.message || (SPEC.usage ?? ""));

const act = outcome.parsed.flag("--act") === "true";
const repo = outcome.parsed.flag("--repo") ?? process.cwd();
const root = canonicalProjectRoot(repo);

// bounded tail: the newest 256 KiB is plenty for a launch/first-turn failure
const TAIL_BYTES = 256 * 1024;
const tailLines = (file: string): string[] => {
	try {
		const buf = readFileSync(file);
		const slice =
			buf.length > TAIL_BYTES ? buf.subarray(buf.length - TAIL_BYTES) : buf;
		return slice.toString("utf8").split("\n").slice(-400);
	} catch {
		return [];
	}
};

interface GapState {
	[item: string]: { scope: string; at: number };
}
const EPISODE_TTL_MS = 24 * 60 * 60 * 1000;
const LANE_WINDOW_MS = 24 * 60 * 60 * 1000;
const stateFile = join(root, ".fleet", "cred-gaps.json");
const loadState = (): GapState => {
	try {
		return JSON.parse(readFileSync(stateFile, "utf8")) as GapState;
	} catch {
		return {};
	}
};

const store = openStore();
const project = projectIdentity(root);
const state = loadState();
const now = Date.now();
let next = state;
const findings: string[] = [];

// one acted gap: requires.gap event + the item's requires-stamp. The stamp
// IS the misroute fix — the next dispatch brief carries the real scope and
// routes to a machine that declared it. Failures stay per-item.
const fireGap = (
	store: ReturnType<typeof openStore>,
	project: string,
	item: string,
	scope: string,
	sid: string,
	findings: string[],
): void => {
	try {
		emitLoopEvent(
			"requires.gap",
			item,
			{ missing: scope, evidence: `lane ${sid} log hit` },
			store,
		);
		stampRequires(store, project, item, scope, {
			die: (msg) => {
				throw new Error(msg);
			},
			emit: (kind, id, extra) => emitLoopEvent(kind, id, extra, store),
		});
		findings.push(`CRED-GAP ${item} needs ${scope} — stamped (lane ${sid})`);
	} catch (error) {
		findings.push(
			`CRED-GAP ${item} scope ${scope} — act failed: ${String(error)}`,
		);
	}
};

const lanes = readLaneRegistry<RegistryLane>(root);
if (lanes.known) {
	for (const lane of lanes.lanes) {
		if (!lane.item || !lane.sid) continue;
		const launchedAt = Number(lane.launchedAt ?? 0);
		if (launchedAt && now - launchedAt > LANE_WINDOW_MS) continue;
		const log = join(root, ".fleet", `lane-${lane.sid}.log`);
		const scopes = new Set<string>();
		for (const line of tailLines(log)) {
			const scope = classifyCredError(line);
			if (scope) scopes.add(scope);
		}
		if (scopes.size === 0) continue;
		for (const scope of scopes) {
			const prior = state[lane.item];
			if (prior && prior.scope === scope && now - prior.at < EPISODE_TTL_MS)
				continue; // episode already banked
			next = { ...next, [lane.item]: { scope, at: now } };
			findings.push(
				act
					? `CRED-GAP ${lane.item} needs ${scope} — acted (lane ${lane.sid})`
					: `CRED-GAP ${lane.item} scope ${scope} — dry-run (lane ${lane.sid})`,
			);
			if (act) fireGap(store, project, lane.item, scope, lane.sid, findings);
		}
	}
}
if (Object.keys(next).length !== Object.keys(state).length || act) {
	try {
		writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`);
	} catch {}
}
console.log(findings.length > 0 ? findings.join("\n") : "cred-gap-scan: clean");
store.close();
process.exit(findings.length > 0 && !act ? 1 : 0);
