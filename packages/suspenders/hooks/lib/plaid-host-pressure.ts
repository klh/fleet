// hooks/lib/plaid-host-pressure.ts — W1102.1: the host-pressure gate a
// Plaid launch clears before the lane spawns. No numerical lane cap — this
// gates on the HOST's own evidence, not on a width number:
//   free %, wired pages, cumulative swapouts sampled via `memory_pressure`
//   (macOS `memory_pressure -Q`: one line "System-wide memory free
//   percentage: NN%"; wired/swapouts read from `vm_stat`, freedrained from
//   the -Q summary). Decisions ride DELTAS between paced launches, never
//   raw swap totals — this host historically carries high swap occupancy
//   at a healthy free %.
// Fail-closed: an unparseable/failed sample is "unknown" and PAUSES the
// launch with an explicit bounded reason. The sampler is injectable —
// tests feed fixture outputs, never spawn real probes.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
	modelBudgetGb,
	wiredGuardGb,
} from "../../../local-llm/memory-policy.ts";
import { readEnvValue } from "./doctor.ts";

/** One host-pressure sample. Fields null = that signal was unreadable. */
export interface HostPressureSample {
	freePct: number | null;
	wiredPages: number | null;
	/** vm_stat's own page size (bytes) — 16384 on arm64, 4096 on x86_64. */
	pageSizeBytes: number | null;
	swapouts: number | null;
	/** raw tool output (trimmed) for the pause reason + debugging. */
	raw: string;
}

export const hostPressureSampleOf = (
	freePct: number | null,
	wiredPages: number | null,
	swapouts: number | null,
	raw: string,
	pageSizeBytes: number | null = null,
): HostPressureSample => ({
	freePct,
	wiredPages,
	swapouts,
	raw,
	pageSizeBytes,
});

export type HostPressureSampler = () => HostPressureSample;

// ── output parsing (pure — fixture-tested) ────────────────────────────────

/** macOS `memory_pressure -Q` line: "System-wide memory free percentage: 71%".
 *  Bounded 0..100 — out-of-range probe output is malformed → unknown. */
export const parseFreePct = (out: string): number | null => {
	const m = /free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(out);
	if (!m) return null;
	const v = Number(m[1]);
	return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
};

/** `vm_stat` "Pages wired down: 123456" → absolute pages (not a delta). */
export const parseWiredPages = (out: string): number | null => {
	const m = /Pages wired down:\s*(\d+)/i.exec(out);
	if (!m) return null;
	const v = Number(m[1]);
	return Number.isFinite(v) ? v : null;
};

/** `vm_stat` header "(page size of 4096 bytes)" → bytes; null = unparseable
 *  (the wired gate holds fail-closed without it — page counts are
 *  page-size-relative). */
export const parsePageSizeBytes = (out: string): number | null => {
	const m = /page size of (\d+) bytes/i.exec(out);
	if (!m) return null;
	const v = Number(m[1]);
	return Number.isFinite(v) && v > 0 ? v : null;
};

/** `vm_stat` "Swapouts: 1234" — CUMULATIVE since boot; deltas decide. */
export const parseSwapouts = (out: string): number | null => {
	const m = /Swapouts:\s*(\d+)/i.exec(out);
	if (!m) return null;
	const v = Number(m[1]);
	return Number.isFinite(v) ? v : null;
};

// ── the live sampler (Bun subprocess — spawnSync, no shell) ──────────────

const parseSample = (mp: string, vm: string): HostPressureSample =>
	hostPressureSampleOf(
		parseFreePct(mp),
		parseWiredPages(vm),
		parseSwapouts(vm),
		[mp, vm]
			.map((s) => s.trim())
			.filter(Boolean)
			.join(" | ")
			.slice(0, 400),
		parsePageSizeBytes(vm),
	);

/** Live sample: `memory_pressure -Q` + `vm_stat` as direct argv spawns
 *  (never shell). Any failed/odd read leaves that field null — the
 *  DECIDER treats unknown as hold (fail-closed). Runner injectable for
 *  tests (fixture outputs, no real spawns). */
export type SpawnRunner = (
	cmd: string[],
) => { exitCode: number; stdout: Buffer } | null;
export const liveHostPressureSample = (
	run: SpawnRunner = defaultSpawnRunner,
): HostPressureSample => {
	let mp = "";
	try {
		const r = run(["memory_pressure", "-Q"]);
		if (r && r.exitCode === 0) mp = r.stdout.toString();
	} catch {} // spawn failure = unknown free %
	let vm = "";
	try {
		const r = run(["vm_stat"]);
		if (r && r.exitCode === 0) vm = r.stdout.toString();
	} catch {} // spawn failure = unknown wired/swapouts
	return parseSample(mp, vm);
};

function defaultSpawnRunner(
	cmd: string[],
): { exitCode: number; stdout: Buffer } | null {
	try {
		return Bun.spawnSync(cmd);
	} catch {
		return null;
	}
}

// ── the decision (pure — the gate) ────────────────────────────────────────
// Wired ceiling rides the Belt wired-admission guard (config-over-code):
// BELT_WIRED_GUARD_GB → wiredGuardGb() (default 60 GiB). This host runs a
// 90 GiB guard and a legitimate cold model reserves ~31 GiB — a frozen
// 24 GiB default would hold every launch. The launch ceiling = guard +
// one modelBudget headroom, and the env knob overrides for operators.

export interface HostPressurePolicy {
	/** launches hold below this free % (null = never on free%). */
	minFreePct: number | null;
	/** launches hold above this wired BYTES (GiB-scale, page-size agnostic
	 *  — never a raw page count). null = never on wired. */
	maxWiredBytes: number | null;
	/** launches hold when cumulative swapouts grew this much since the
	 *  previous paced launch (null = never on swapout delta). */
	maxSwapoutDelta: number | null;
}

/** Hold under 25% free or 2000+ swapouts between launches (a real pressure
 *  spike — raw swap totals never decide). */
export const DEFAULT_HOST_PRESSURE_POLICY: HostPressurePolicy = {
	minFreePct: 25,
	maxWiredBytes: null,
	maxSwapoutDelta: 2_000,
};

/** Launch-time wired ceiling, config-over-code (review #55096): the
 *  INSTALLED Belt guard is the source — env pin first, then belt.env's
 *  BELT_WIRED_GUARD_GB read from the machine conf (the same precedence
 *  every governance consumer uses; W1063), else the wired check is OFF
 *  (null). An unpropagated env default (60+28=88 GiB) must never
 *  false-hold a host running a 90 GiB guard. */
export const launchWiredCeilingBytes = (): number | null => {
	const env = process.env.BELT_WIRED_GUARD_GB?.trim();
	if (env) {
		const gb = wiredGuardGb(env);
		return (gb + modelBudgetGb(20)) * 1024 ** 3;
	}
	const home = process.env.HOME ?? "";
	try {
		const v = readEnvValue(
			readFileSync(`${home}/.claude/local-llm/belt.env`, "utf8"),
			"BELT_WIRED_GUARD_GB",
		);
		if (v?.trim())
			return (wiredGuardGb(v.trim()) + modelBudgetGb(20)) * 1024 ** 3;
	} catch {} // unreadable conf = no evidence — the check stays off
	return null;
};

export interface HostPressureDecision {
	/** true = launch may proceed. */
	open: boolean;
	/** explicit bounded hold reason when closed (null when open). */
	reason: string | null;
}

/** One decision: policy vs this sample (+ the previous paced launch's
 *  swapouts for the delta). Unknown signals hold (fail-closed) — free %
 *  null, or wired/swapouts null only when their check is on. */
export const hostPressureDecision = (
	sample: HostPressureSample,
	prevSwapouts: number | null,
	policy: HostPressurePolicy = DEFAULT_HOST_PRESSURE_POLICY,
): HostPressureDecision => {
	// free % is the primary signal; unknown = hold
	if (policy.minFreePct !== null && sample.freePct === null)
		return {
			open: false,
			reason: "plaid host pressure: free % unreadable — hold",
		};
	if (
		policy.minFreePct !== null &&
		sample.freePct !== null &&
		sample.freePct < policy.minFreePct
	)
		return {
			open: false,
			reason: `plaid host pressure: free ${sample.freePct}% < ${policy.minFreePct}% floor — hold`,
		};
	if (policy.maxWiredBytes !== null) {
		if (sample.wiredPages === null)
			return {
				open: false,
				reason: "plaid host pressure: wired pages unreadable — hold",
			};
		if (sample.pageSizeBytes === null)
			return {
				open: false,
				reason: "plaid host pressure: vm_stat page size unreadable — hold",
			};
		const wiredBytes = sample.wiredPages * sample.pageSizeBytes;
		if (wiredBytes > policy.maxWiredBytes) {
			const used = (wiredBytes / 1024 ** 3).toFixed(1);
			const cap = (policy.maxWiredBytes / 1024 ** 3).toFixed(0);
			return {
				open: false,
				reason: `plaid host pressure: wired ${used}GiB > ${cap}GiB — hold`,
			};
		}
	}
	// delta rule: growth between paced launches holds; raw totals never decide
	if (policy.maxSwapoutDelta !== null && sample.swapouts === null)
		return {
			open: false,
			reason: "plaid host pressure: swapouts unreadable — hold",
		};
	if (
		policy.maxSwapoutDelta !== null &&
		sample.swapouts !== null &&
		prevSwapouts !== null &&
		sample.swapouts - prevSwapouts > policy.maxSwapoutDelta
	)
		return {
			open: false,
			reason: `plaid host pressure: swapouts +${sample.swapouts - prevSwapouts} since last launch > ${policy.maxSwapoutDelta} — hold`,
		};
	return { open: true, reason: null };
};

// ── persisted baseline (dispatch-next is short-lived; the delta needs a
// previous sample across separate invocations) ────────────────────────────

/** Where the last paced launch's swapouts anchor lives (under .fleet/). */
export const HOST_PRESSURE_STATE_FILE = "host-pressure.json";

export interface HostPressureState {
	/** swapouts at the last decision (the delta baseline). */
	swapouts: number;
	/** epoch ms of that sample. */
	ts: number;
}

/** Read the persisted baseline; junk/absent/malformed = null (fresh
 *  baseline next — a NaN/negative/fractional counter never anchors). */
export const readHostPressureState = (
	fleetDir: string,
): HostPressureState | null => {
	try {
		const j = JSON.parse(
			readFileSync(`${fleetDir}/${HOST_PRESSURE_STATE_FILE}`, "utf8"),
		) as Partial<HostPressureState>;
		const ok =
			Number.isInteger(j.swapouts) &&
			(j.swapouts as number) >= 0 &&
			Number.isFinite(j.ts) &&
			(j.ts as number) > 0 &&
			(j.ts as number) <= Date.now();
		return ok
			? { swapouts: j.swapouts as number, ts: j.ts as number }
			: null;
	} catch {
		return null;
	}
};

/** Persist the baseline atomically (tmp+rename — a torn write never reads). */
export const writeHostPressureState = (
	fleetDir: string,
	state: HostPressureState,
): void => {
	mkdirSync(fleetDir, { recursive: true });
	const p = `${fleetDir}/${HOST_PRESSURE_STATE_FILE}`;
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state)}\n`);
	renameSync(tmp, p);
};

/** Baseline staleness: a persisted anchor older than this no longer
 *  supports a delta (the window is a paced-launch horizon, not a boot-age
 *  ledger) — the next sample starts a fresh baseline instead. */
export const HOST_PRESSURE_BASELINE_MAX_AGE_MS = 24 * 3600_000;

/** One launch-gate step: decision vs the persisted baseline → persist this
 *  sample as the next baseline. Reboot reset (current < previous) opens
 *  (non-negative delta) and re-anchors. Never writes a synthetic anchor:
 *  an unreadable/unknown swapout leaves the previous state byte-for-byte
 *  (and a stale previous does not refresh). */
export const hostPressureGate = (
	fleetDir: string,
	sample: HostPressureSample,
	policy: HostPressurePolicy = DEFAULT_HOST_PRESSURE_POLICY,
): HostPressureDecision => {
	const prev = readHostPressureState(fleetDir);
	const prevUsable =
		prev !== null &&
		Date.now() - prev.ts <= HOST_PRESSURE_BASELINE_MAX_AGE_MS;
	const decision = hostPressureDecision(
		sample,
		prevUsable ? (prev?.swapouts ?? null) : null,
		policy,
	);
	if (sample.swapouts === null) return decision; // no anchor write
	writeHostPressureState(fleetDir, { swapouts: sample.swapouts, ts: Date.now() });
	return decision;
};

/** Dispatch-side one-shot (W1102.1): live sample → gate → hold reason or
 *  null. Called before EACH Plaid claim/take — the dispatcher is
 *  short-lived, so the swapout baseline rides the persisted .fleet state
 *  across invocations. Sampler injectable for tests. */
export const plaidLaunchHold = (
	fleetDir: string,
	sample: HostPressureSample = liveHostPressureSample(),
	policy: HostPressurePolicy = DEFAULT_HOST_PRESSURE_POLICY,
): string | null => {
	const d = hostPressureGate(fleetDir, sample, policy);
	return d.open ? null : (d.reason ?? "plaid host pressure: hold");
};
