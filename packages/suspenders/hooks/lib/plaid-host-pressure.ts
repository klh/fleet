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

/** One host-pressure sample. Fields null = that signal was unreadable. */
export interface HostPressureSample {
	freePct: number | null;
	wiredPages: number | null;
	swapouts: number | null;
	/** raw tool output (trimmed) for the pause reason + debugging. */
	raw: string;
}

export const hostPressureSampleOf = (
	freePct: number | null,
	wiredPages: number | null,
	swapouts: number | null,
	raw: string,
): HostPressureSample => ({ freePct, wiredPages, swapouts, raw });

export type HostPressureSampler = () => HostPressureSample;

// ── output parsing (pure — fixture-tested) ────────────────────────────────

/** macOS `memory_pressure -Q` line: "System-wide memory free percentage: 71%" */
export const parseFreePct = (out: string): number | null => {
	const m = /free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(out);
	if (!m) return null;
	const v = Number(m[1]);
	return Number.isFinite(v) ? v : null;
};

/** `vm_stat` "Pages wired down: 123456" → absolute pages (not a delta). */
export const parseWiredPages = (out: string): number | null => {
	const m = /Pages wired down:\s*(\d+)/i.exec(out);
	if (!m) return null;
	const v = Number(m[1]);
	return Number.isFinite(v) ? v : null;
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
	);

/** Live sample: `memory_pressure -Q` + `vm_stat` as direct argv spawns
 *  (never shell). Any failed/odd read leaves that field null — the
 *  DECIDER treats unknown as hold (fail-closed). */
export const liveHostPressureSample = (): HostPressureSample => {
	let mp = "";
	try {
		const r = Bun.spawnSync(["memory_pressure", "-Q"]);
		if (r.exitCode === 0) mp = r.stdout.toString();
	} catch {} // spawn failure = unknown free %
	let vm = "";
	try {
		const r = Bun.spawnSync(["vm_stat"]);
		if (r.exitCode === 0) vm = r.stdout.toString();
	} catch {} // spawn failure = unknown wired/swapouts
	return parseSample(mp, vm);
};

// ── the decision (pure — the gate) ────────────────────────────────────────

export interface HostPressurePolicy {
	/** launches hold below this free % (null = never on free%). */
	minFreePct: number | null;
	/** launches hold above this wired-page count (null = never on wired). */
	maxWiredPages: number | null;
	/** launches hold when cumulative swapouts grew this much since the
	 *  previous paced launch (null = never on swapout delta). */
	maxSwapoutDelta: number | null;
}

/** Owner defaults: hold under 25% free, above 6M wired pages (~24 GiB @
 *  4 KiB pages), or 2000+ swapouts between launches (a real pressure
 *  spike — raw swap totals never decide). */
export const DEFAULT_HOST_PRESSURE_POLICY: HostPressurePolicy = {
	minFreePct: 25,
	maxWiredPages: 6_000_000,
	maxSwapoutDelta: 2_000,
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
	if (policy.maxWiredPages !== null && sample.wiredPages === null)
		return {
			open: false,
			reason: "plaid host pressure: wired pages unreadable — hold",
		};
	if (
		policy.maxWiredPages !== null &&
		sample.wiredPages !== null &&
		sample.wiredPages > policy.maxWiredPages
	)
		return {
			open: false,
			reason: `plaid host pressure: wired ${sample.wiredPages} > ${policy.maxWiredPages} — hold`,
		};
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
