// hooks/lib/capacity/ramp-report.ts — W1713 the operator-readable run report.
// Pure text from RampResult + the optional ledger/fleet cross-checks; every
// concurrency figure is labelled with WHICH counter it is (own in-flight,
// gateway-wide in-flight, own lanes at the gateway, live lane processes,
// distinct successful lane ids) — they are never interchangeable.
import type { LedgerSide, LedgerView } from "./ramp-gateway.ts";
import type { RampResult } from "./ramp-run.ts";
import type { StepStats } from "./ramp-stats.ts";

const ms = (v: number | null): string => {
	if (v === null) return "-";
	return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${String(Math.round(v))}ms`;
};
const n1 = (v: number | null): string =>
	v === null ? "-" : String(Math.round(v * 10) / 10);
const pct = (v: number | null): string =>
	v === null ? "-" : `${(v * 100).toFixed(1)}%`;

export function renderStep(s: StepStats): string {
	const bad =
		Object.entries(s.byClass)
			.filter(([c, n]) => c !== "ok" && n > 0)
			.map(([c, n]) => `${c}:${String(n)}`)
			.join(",") || "-";
	const u = s.usage;
	return [
		`${s.route} n=${String(s.concurrency)}`,
		`held ${s.actualS.toFixed(1)}s (ok-window ${s.okWindowS.toFixed(1)}s)`,
		`ok ${String(s.ok)}/${String(s.completed)} err ${s.errPct.toFixed(1)}%`,
		`p50 ${ms(s.latencyMs.p50)} p95 ${ms(s.latencyMs.p95)} max ${ms(s.latencyMs.max)}`,
		`${n1(s.okPerMin)} ok/min`,
		`rpc own-peak ${String(s.rpc.ownPeak)} gateway-peak ${n1(s.rpc.gatewayPeak)} own-at-gateway-peak ${n1(s.rpc.gatewayOwnPeak)} (${String(s.rpc.samples)} samples)`,
		`lanes ok ${String(s.lanesOk)}/${String(s.lanesTried)}`,
		`tok fresh ${String(u.fresh)} cached ${String(u.cached)} write ${String(u.cacheWrite)} out ${String(u.out)} cache-hit ${pct(u.cacheHitShare)}`,
		`non-ok ${bad}`,
	].join(" | ");
}

const floor = (truncated: boolean): string =>
	truncated ? " [floor: ledger page budget hit]" : "";

/** distinct productive lane ids; the page budget cutting the window makes it a floor. */
export const lanesNote = (s: LedgerSide | null, truncated: boolean): string =>
	s === null ? "unreadable" : `${String(s.lanesOk)}${floor(truncated)}`;

const side = (name: string, s: LedgerSide, truncated: boolean): string =>
	`${name}: rows ${String(s.rows)} ok ${String(s.okRows)} err ${String(s.errRows)} lanes-ok ${String(s.lanesOk)} lanes-err ${String(s.lanesErr)} status ${JSON.stringify(s.byStatus)} tok in ${String(s.tokens.in)} out ${String(s.tokens.out)} cache-read ${String(s.tokens.cacheRead)} cache-write ${String(s.tokens.cacheWrite)}${floor(truncated)}`;

export function renderRun(
	r: RampResult,
	extra?: {
		ledger?: LedgerView | null;
		liveBefore?: number | null;
		liveAfter?: number | null;
	},
): string {
	const lines = [
		`run ${r.runId}: ${String(r.requests)} requests, wall ${((r.endedMs - r.startedMs) / 1000).toFixed(1)}s, ${String(r.steps.length)} step(s)`,
		...r.steps.map(renderStep),
	];
	for (const v of r.verdicts) {
		const bad = v.firstBad
			? `first-bad n=${String(v.firstBad.concurrency)} (${v.firstBad.reason})`
			: "no bad step";
		lines.push(
			`verdict ${v.route}: clean-through n=${String(v.cleanMax ?? "none")} (lower bound, not a max), ${bad}, steps ${String(v.stepsRun)}`,
		);
	}
	lines.push(
		r.stop
			? `stop: ${r.stop.reason} at ${r.stop.route ?? "-"} n=${String(r.stop.concurrency ?? "-")}`
			: "stop: none at run level (no throttle/cap/abort) — the verdicts above say where each route's ramp ended",
	);
	lines.push(
		`drain: own lanes still at gateway ${String(r.drainResidual ?? "unobservable")}`,
		`keys: revoked ${String(r.keys.filter((k) => k.revoked).length)}/${String(r.keys.length)}`,
	);
	if (extra?.ledger) {
		lines.push(side("ledger own", extra.ledger.own, extra.ledger.truncated));
		lines.push(
			side(
				"ledger other-lanes (collateral window)",
				extra.ledger.others,
				extra.ledger.truncated,
			),
		);
	} else if (extra?.ledger === null) {
		lines.push("ledger: unreadable (admin requests endpoint did not answer)");
	}
	if (extra) {
		lines.push(
			`live lane processes (work lanes) before ${String(extra.liveBefore ?? "-")} after ${String(extra.liveAfter ?? "-")}`,
		);
	}
	return lines.join("\n");
}
