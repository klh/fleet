// hooks/bin/federation-report.ts — W171 federation phase 3 spoke entry.
// Opt-in aggregate self-report: gated by the pulled manifest's
// federation.self_report rule (default OFF — no rule, no POST), the
// operator env (BUCKLE_SPOKE_TEAM + the pull client's BUCKLE_HUB_URL/
// BUCKLE_SPOKE_TOKEN), and honest degradation when the hub is down (the
// cursor never advances, the next cycle re-reports). Loop mode default
// (FEDERATION_REPORT_INTERVAL_S, default 300s); --once for sim/tests.
// Sim mapping: source sim/spoke-profile.env first.
import { runSelfReportCycle } from "../lib/federation-report.ts";

const INTERVAL_S = Number(process.env.FEDERATION_REPORT_INTERVAL_S ?? "300");

async function cycle(): Promise<boolean> {
	const out = await runSelfReportCycle();
	if (out.action === "reported") {
		console.log(
			`[federation-report] reported ${String(out.windows)} window(s)`,
		);
		return true;
	}
	console.error(
		`[federation-report] ${out.action}: ${out.reason ?? "unknown"}`,
	);
	return out.action === "skipped";
}

if (import.meta.main) {
	if (process.argv.includes("--once")) {
		const ok = await cycle();
		process.exit(ok ? 0 : 2);
	}
	console.log(
		`[federation-report] loop every ${String(INTERVAL_S)}s (BUCKLE_HUB_URL=${process.env.BUCKLE_HUB_URL ?? "unset"}, BUCKLE_SPOKE_TEAM=${process.env.BUCKLE_SPOKE_TEAM ?? "unset"})`,
	);
	for (;;) {
		await cycle();
		await Bun.sleep(INTERVAL_S * 1000);
	}
}
