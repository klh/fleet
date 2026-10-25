// hooks/lib/notify/pulse.ts — W822: the periodic fleet-pulse digest. One
// notification per fire: an always-sent heartbeat line (silence must mean
// outage, never quiet) plus the delta contract — work graph + watchdog
// state since the last pulse. State rides ~/.cache/claude-governor/
// pulse-state.json so only deltas repeat. Read-only over the work graph;
// every source is injectable for tests.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../govdb/govdb.ts";
import {
	auditLanes,
	type LaneAuditRow,
	type LaneRef,
} from "../lanes/lane-liveness.ts";
import { loadLaneRegistry } from "../lanes/lane-registry.ts";
import {
	type ChannelName,
	type Notification,
	type NotifyConfig,
	type Sender,
	scrubOutbound,
} from "./notify.ts";
import type { FleetWarm } from "../usage/cache-drilldown.ts";
import { dualStamp } from "../wallclock.ts";

/** W822 pulse state — only deltas repeat; the heartbeat never skips. */
export interface PulseState {
	lastSentAt: number;
	lastDigest: string;
}

export const PULSE_STATE_PATH = (): string =>
	process.env.KLH_PULSE_STATE ??
	join(homedir(), ".cache", "claude-governor", "pulse-state.json");

/** Absent/corrupt state = first pulse: everything reads as delta. */
export function loadPulseState(path: string): PulseState | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PulseState>;
		if (typeof raw.lastSentAt !== "number" || !Number.isFinite(raw.lastSentAt))
			return null;
		return {
			lastSentAt: raw.lastSentAt,
			lastDigest: typeof raw.lastDigest === "string" ? raw.lastDigest : "",
		};
	} catch {
		return null;
	}
}

export function savePulseState(path: string, state: PulseState): void {
	try {
		Bun.write(path, `${JSON.stringify(state)}\n`);
	} catch {
		/* a lost state write only widens the next delta — never fatal */
	}
}

// djb2 — non-crypto content key; a collision only over-keys one quiet pulse
export const digestKeyOf = (s: string): string => {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	return `d${h.toString(36)}`;
};

export const ageOf = (ms: number): string => {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 90) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 90) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 36) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
};

export interface PulseWatchdog {
	state: string;
	at: string | null;
}

/** Last verdict: the state json first, the aggregate log line as fallback. */
export function readWatchdog(fleetRoot: string): PulseWatchdog {
	try {
		const raw = JSON.parse(
			readFileSync(join(fleetRoot, ".fleet", "dispatch-watchdog.json"), "utf8"),
		) as { at?: string; health?: { state?: string } };
		if (typeof raw.health?.state === "string")
			return {
				state: raw.health.state,
				at: typeof raw.at === "string" ? raw.at : null,
			};
	} catch {}
	try {
		const lines = readFileSync(
			join(fleetRoot, ".fleet", "dispatch-watchdog.log"),
			"utf8",
		)
			.trim()
			.split("\n");
		const last = lines[lines.length - 1] ?? "";
		const m = /aggregate (\S+)/.exec(last);
		if (m)
			return {
				state: m[1],
				at: m.index > 0 ? last.slice(0, m.index).trim() : null,
			};
	} catch {}
	return { state: "unknown", at: null };
}

export interface PulseDeps {
	store: GovernorStore;
	/** work-graph partition key (the repo's git-common-dir realpath) */
	project: string;
	/** the fleet checkout root — .fleet/ + git log resolve here */
	fleetRoot: string;
	now?: () => number;
	state?: PulseState | null;
	registry?: () => LaneRef[];
	/** liveness override (default: the W652.1 auditLanes projection) */
	liveness?: (l: LaneRef) => boolean;
	/** commit log override (default: git -C fleetRoot log --oneline) */
	git?: (root: string, n: number) => string[];
	/** watchdog verdict override (default: state json + aggregate log line) */
	watchdog?: () => PulseWatchdog;
	/** W826 fleet cache warm-rate (default: not wired — the composition root
	 *  in notify.ts injects the live ledger read). Null = omit honestly. */
	warm?: () => FleetWarm | null;
	/** W826 mining candidate lines (default: none). */
	mining?: () => string[];
	/** W828 license-health lines (default: none). */
	license?: () => string[];
}

export interface PulseDigest {
	/** the always-sent one-liner (silence must mean outage, never quiet) */
	heartbeat: string;
	/** send-ready body: heartbeat, plus the delta sections when one exists */
	body: string;
	title: string;
	/** number of work-graph deltas represented in the body */
	deltas: number;
	/** content key of the state sections — unchanged content = quiet pulse */
	digestKey: string;
}

const gitLog = (root: string, n: number): string[] => {
	try {
		const r = Bun.spawnSync(["git", "-C", root, "log", `-${n}`, "--oneline"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (r.exitCode !== 0) return [];
		return new TextDecoder()
			.decode(r.stdout)
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
};

function lanesOf(deps: PulseDeps): LaneAuditRow[] {
	const registryRows: LaneRef[] =
		deps.registry?.() ?? loadLaneRegistry(deps.fleetRoot);
	if (deps.liveness)
		return registryRows.map((l) => ({
			sid: l.sid,
			item: l.item,
			verdict: deps.liveness(l) ? "alive" : "dead",
			live: deps.liveness(l) as boolean,
			host: l.host ?? null,
		}));
	return auditLanes(registryRows);
}

// project-bound on both sides (the work-graph scoping invariant)
const READY_SQL =
	"SELECT id, title, created_at FROM work_items w WHERE project = ? AND state = 'READY' AND NOT EXISTS (SELECT 1 FROM work_deps d JOIN work_items p ON p.project = d.project AND p.id = d.depends_on WHERE d.project = w.project AND d.work_id = w.id AND p.state != 'DONE') ORDER BY created_at ASC LIMIT 8";

function readyRows(
	deps: PulseDeps,
): Array<{ id: string; title: string; created_at: number }> {
	return deps.store.query(READY_SQL).all(deps.project) as unknown as Array<{
		id: string;
		title: string;
		created_at: number;
	}>;
}

function doneRows(
	deps: PulseDeps,
	since: number,
): Array<{ id: string; title: string; result_sha: string | null }> {
	return deps.store
		.query(
			"SELECT id, title, result_sha FROM work_items WHERE project = ? AND state = 'DONE' AND updated_at > ? ORDER BY updated_at DESC LIMIT 12",
		)
		.all(deps.project, since) as unknown as Array<{
		id: string;
		title: string;
		result_sha: string | null;
	}>;
}

function decisionCount(deps: PulseDeps): number | null {
	try {
		const row = deps.store
			.query(
				"SELECT COUNT(*) AS n FROM decisions WHERE project = ? AND state = 'OPEN'",
			)
			.get(deps.project) as { n: number } | undefined;
		return Number(row?.n ?? 0);
	} catch {
		return null; // the board owns this table — absent until its first open
	}
}

function sectionsOf(args: {
	since: number;
	now: number;
	ready: Array<{ id: string; title: string; created_at: number }>;
	done: Array<{ id: string; result_sha: string | null; title: string }>;
	dec: number | null;
	wd: PulseWatchdog;
	wdAge: string;
	commits: string[];
	mining: string[];
	license: string[];
}): string[] {
	const out: string[] = [];
	if (args.done.length > 0) {
		out.push(
			`landed since ${args.since > 0 ? dualStamp(args.since) : "first pulse"}`,
		);
		for (const d of args.done)
			out.push(
				`  ${d.id} ${d.result_sha ? d.result_sha.slice(0, 10) : "no-sha"} ${d.title}`,
			);
	}
	if (args.ready.length > 0) {
		out.push("READY pool (oldest first):");
		for (const r of args.ready)
			out.push(`  ${r.id} ${ageOf(args.now - r.created_at)} ${r.title}`);
	}
	if (args.dec !== null && args.dec > 0)
		out.push(`open NEED_DECISION: ${args.dec}`);
	if (args.wd.state !== "ok")
		out.push(`watchdog: ${args.wd.state}${args.wdAge}`);
	if (args.mining.length > 0)
		out.push(
			"cache offenders (weekly mining):",
			...args.mining.map((m) => `  ${m}`),
		);
	if (args.license.length > 0)
		out.push(
			"license perimeter (daily audit):",
			...args.license.map((l) => `  ${l}`),
		);
	if (args.commits.length > 0) {
		out.push("commits:");
		for (const c of args.commits) out.push(`  ${c}`);
	}
	return out;
}

// degraded watchdog outranks open decisions in the heartbeat verdict
function verdictOf(dec: number | null, wdState: string): string {
	if (wdState !== "ok") return `wd-${wdState}`;
	return dec !== null && dec > 0 ? "dec-open" : "ok";
}

export function composePulse(deps: PulseDeps): PulseDigest {
	const now = deps.now ?? Date.now;
	const state = deps.state ?? null;
	const since = state?.lastSentAt ?? 0;
	const lanes = lanesOf(deps);
	const ready = readyRows(deps);
	const done = doneRows(deps, since);
	const dec = decisionCount(deps);
	const wd = deps.watchdog?.() ?? readWatchdog(deps.fleetRoot);
	const commits = (deps.git ?? gitLog)(deps.fleetRoot, 3);
	const wdAge = wd.at ? ` (${ageOf(now() - Date.parse(wd.at))} old)` : "";
	const verdict = verdictOf(dec, wd.state);
	const warm = deps.warm?.() ?? null;
	const mining = deps.mining?.() ?? [];
	const license = deps.license?.() ?? [];
	const warmFrag =
		warm !== null ? ` · warm ${(warm.rate * 100).toFixed(1)}%` : "";
	// W902: the report header carries its own generated-at stamp — UTC Z first,
	// local twin beside it (hub clocks drift; silence ≠ same clock)
	const heartbeat = `pulse ${verdict} · lanes ${lanes.filter((l) => l.live).length}/${lanes.length} · READY ${ready.length} · DEC ${dec === null ? "n/a" : dec} · wd ${wd.state}${wdAge}${warmFrag} · gen ${dualStamp(now())}`;
	const sections = sectionsOf({
		since,
		now: now(),
		ready,
		done,
		dec,
		wd: { state: wd.state, at: wd.at },
		wdAge,
		commits,
		mining,
		license,
	});
	const digestKey = digestKeyOf(sections.join("\n"));
	const deltas =
		done.length + (digestKey !== (state?.lastDigest ?? "") ? 1 : 0);
	const body = deltas === 0 ? heartbeat : [heartbeat, ...sections].join("\n");
	return {
		heartbeat,
		body,
		title: `[fleet] pulse${verdict === "ok" ? "" : ` — ${verdict}`}`,
		deltas,
		digestKey,
	};
}

/** Per-channel isolated send — a failing channel never blocks the others. */
async function sendPulse(
	channels: ChannelName[],
	senders: Partial<Record<ChannelName, Sender>>,
	n: Notification,
): Promise<Partial<Record<ChannelName, string>>> {
	const results: Partial<Record<ChannelName, string>> = {};
	await Promise.all(
		channels.map(async (c) => {
			try {
				await senders[c]?.(n);
				results[c] = "ok";
			} catch (e) {
				results[c] = e instanceof Error ? e.message : String(e);
			}
		}),
	);
	return results;
}

export interface FirePulseDeps extends PulseDeps {
	config: NotifyConfig;
	senders: Partial<Record<ChannelName, Sender>>;
	statePath: string;
	log?: (m: string) => void;
}

export interface FirePulseResult {
	digest: PulseDigest;
	channels: Partial<Record<ChannelName, string>>;
	advanced: boolean;
}

/** Fire one pulse: compose → per-channel isolated send → advance state
 *  ONLY when at least one channel delivered (a silent channel must not
 *  consume deltas). Failures land in the result, never thrown. */
export async function firePulse(deps: FirePulseDeps): Promise<FirePulseResult> {
	const log = deps.log ?? ((): void => {});
	const active = deps.config.classes.pulse.channels.filter(
		(c) => deps.senders[c],
	);
	const digest = composePulse(deps);
	const n: Notification = {
		cls: "pulse",
		key: `pulse:${deps.now?.() ?? Date.now()}`,
		title: scrubOutbound(digest.title),
		body: scrubOutbound(digest.body),
	};
	const channels = await sendPulse(active, deps.senders, n);
	const advanced = active.some((c) => channels[c] === "ok");
	if (advanced)
		savePulseState(deps.statePath, {
			lastSentAt: deps.now?.() ?? Date.now(),
			lastDigest: digest.digestKey,
		});
	if (active.length === 0)
		log("pulse: no active channels — state not advanced");
	log(`pulse: ${digest.heartbeat}`);
	return { digest, channels, advanced };
}
