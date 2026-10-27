// fleet-loop/rogue-sweep.ts — W266.3: the P1 rogue-process sweep in the
// fleet-loop tick — spots plane processes running outside launchd
// supervision. The services.yaml manifest (W488.1) is the service truth:
// every entry renders to launchd label <labelPrefix>.<name>, so an
// instance of a manifest service whose process ancestry lacks that label's
// pid is a ROGUE — the hand-started dev copy / stale orphan class (the
// double-main EADDRINUSE and zombie-lane incidents). SPOT, never kill:
// ROGUE lines land in the loop log, one plane.rogue / plane.rogue.clear
// event per episode on the coord bus (governor events table). The sweep is
// darwin-only — hubs run containers, CI runs linux; elsewhere no-op.
import { writeFileSync } from "node:fs";
import {
	LABEL_PREFIX,
	loadManifest,
} from "../../../scripts/install/install-services.ts";
import { emitLoopEvent } from "./events.ts";
import { type LoopDeps, readJsonSync } from "./runtime.ts";

export type PsRow = { pid: number; ppid: number; cmd: string };
type ServiceRow = { label: string; marker: string };
type RogueState = Record<string, string>; // pid -> command

// Plane labels outside the suspenders manifest (it covers com.suspenders.*
// only): the belt dashboard — belt/launchd/com.belt.dashboard.plist runs
// the runtime-home copy, while packages/belt/bin/dashboard.ts is the same
// plane service from a checkout — and the klh-local Caddy front (klh-local
// register mints com.klh-local.caddy). Basename markers: both entries have
// distinctive basenames and a checkout copy at another path.
const EXTRA_PLANE_SERVICES: ServiceRow[] = [
	{ label: "com.belt.dashboard", marker: "dashboard.ts" },
	{ label: "com.klh-local.caddy", marker: "caddy run" },
];

// marker = the trailing literal path of the manifest bunEntry — placeholder
// tokens, .. and dot-dirs (.claude/.local home fragments) are install-machine
// substitution, so the last ≤3 literal segments match BOTH the
// installed-prefix run and a checkout run of the same entry
// ("__REPO__/../buckle/src/server.ts" -> "buckle/src/server.ts").
export function markerOf(bunEntry: string): string {
	const segs = bunEntry
		.split("/")
		.filter(
			(s) =>
				s.length > 0 && !s.startsWith("__") && s !== ".." && !s.startsWith("."),
		);
	return segs.slice(-3).join("/");
}

// `ps -axo pid=,ppid=,command=` — headerless, one row per process.
export function parsePs(out: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
	}
	return rows;
}

// `launchctl list` rows: PID	Status	Label — "-" pid (loaded, not running)
// and the header row are skipped; every label is kept so the supervision
// verdict is exact, never prefix-assumed.
export function parseLaunchctlList(out: string): Map<string, number> {
	const pids = new Map<string, number>();
	for (const line of out.split("\n")) {
		const cols = line.split("\t");
		if (cols.length < 3) continue;
		const pid = Number(cols[0]);
		if (Number.isInteger(pid) && pid > 0) pids.set(cols[2].trim(), pid);
	}
	return pids;
}

// supervised = the label-held pids plus every transitive descendant — the
// belt swarm supervisor's model children and the fleet-loop watch's
// --once cycle children are supervised THROUGH their label parent.
export function supervisedPids(
	rows: PsRow[],
	labelPids: number[],
): Set<number> {
	const kids = new Map<number, number[]>();
	for (const r of rows) {
		const arr = kids.get(r.ppid);
		if (arr) arr.push(r.pid);
		else kids.set(r.ppid, [r.pid]);
	}
	const seen = new Set<number>(labelPids);
	const queue = [...labelPids];
	while (queue.length > 0) {
		const pid = queue.pop() ?? 0;
		for (const c of kids.get(pid) ?? []) {
			if (!seen.has(c)) {
				seen.add(c);
				queue.push(c);
			}
		}
	}
	return seen;
}

const spawnOut = (cmd: string[]): string => {
	try {
		const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
		return p.stdout ? new TextDecoder().decode(p.stdout) : "";
	} catch {
		return "";
	}
};

// pid->cmd set equality — the episode dedupe key (a resident rogue logs
// once, not per tick).
const sameRogueSet = (a: RogueState, b: RogueState): boolean => {
	const ka = Object.keys(a).sort();
	const kb = Object.keys(b).sort();
	return (
		ka.length === kb.length &&
		ka.every((_k, i) => ka[i] === kb[i] && a[ka[i]] === b[ka[i]])
	);
};

// one sweep: launchctl + ps snapshots -> manifest markers matched against
// the unsupervised population -> episode transitions (state in
// .fleet/rogue.json survives loop restarts — the stall.json idiom).
export function createRogueSweep(
	deps: LoopDeps & {
		manifestPath: string;
		launchctlList?: () => string;
		psOut?: () => string;
	},
): { rogueSweep: () => void } {
	const { log, REPO } = deps;
	const statePath = `${REPO}/.fleet/rogue.json`;
	let services: ServiceRow[] = [];
	try {
		services = [
			...loadManifest(deps.manifestPath).map(
				(s): ServiceRow => ({
					label: `${LABEL_PREFIX}.${s.name}`,
					marker: markerOf(s.bunEntry),
				}),
			),
			...EXTRA_PLANE_SERVICES,
		];
	} catch (e) {
		log(
			`ROGUE-SWEEP-IDLE — services.yaml unreadable: ${e instanceof Error ? e.message : String(e)}`,
		);
		return { rogueSweep: () => {} };
	}
	return { rogueSweep: () => sweepTick({ ...deps, services, statePath, log }) };
}

type SweepCtx = {
	launchctlList?: () => string;
	psOut?: () => string;
	services: ServiceRow[];
	statePath: string;
	log: (msg: string) => void;
};

function sweepTick(ctx: SweepCtx): void {
	if (process.platform !== "darwin") return;
	const lc = ctx.launchctlList?.() ?? spawnOut(["launchctl", "list"]);
	const ps = ctx.psOut?.() ?? spawnOut(["ps", "-axo", "pid=,ppid=,command="]);
	if (lc === "" && ps === "") {
		ctx.log("ROGUE-SWEEP-EMPTY — launchctl/ps produced nothing, sweep skipped");
		return;
	}
	const labelPids = parseLaunchctlList(lc);
	const rows = parsePs(ps);
	const supervised = supervisedPids(rows, [...labelPids.values()]);
	sweepVerdict(ctx, rows, supervised);
}

function sweepVerdict(
	ctx: SweepCtx,
	rows: PsRow[],
	supervised: Set<number>,
): void {
	const rogues = rows
		.filter((r) => !supervised.has(r.pid))
		.filter((r) => ctx.services.some((s) => r.cmd.includes(s.marker)))
		.map((r) => ({ pid: r.pid, cmd: r.cmd.slice(0, 160) }));
	// episode transitions only — a resident rogue logs once, not per tick
	const prev = readJsonSync<RogueState>(ctx.statePath) ?? {};
	const next = Object.fromEntries(rogues.map((r) => [String(r.pid), r.cmd]));
	if (sameRogueSet(prev, next)) return;
	writeFileSync(ctx.statePath, JSON.stringify(next), { mode: 0o600 });
	if (rogues.length > 0) {
		for (const r of rogues)
			ctx.log(`ROGUE pid=${r.pid} ${r.cmd.slice(0, 120)}`);
		emitLoopEvent("plane.rogue", "plane", {
			pids: rogues.map((r) => r.pid),
			cmds: rogues.map((r) => r.cmd),
		});
	} else {
		ctx.log("ROGUE-CLEAR — no plane processes outside launchd supervision");
		emitLoopEvent("plane.rogue.clear", "plane", {});
	}
}
