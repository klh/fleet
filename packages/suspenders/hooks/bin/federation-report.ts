// hooks/bin/federation-report.ts — W171 federation phase 3 spoke entry.
// Opt-in aggregate self-report: gated by the pulled manifest's
// federation.self_report rule (default OFF — no rule, no POST), the
// operator env (BUCKLE_SPOKE_TEAM + the pull client's BUCKLE_HUB_URL/
// BUCKLE_SPOKE_TOKEN), and honest degradation when the hub is down (the
// cursor never advances, the next cycle re-reports). Loop mode default
// (FEDERATION_REPORT_INTERVAL_S, default 300s); --once for sim/tests.
// Sim mapping: source sim/spoke-profile.env first.
import { runSelfReportCycle } from "../lib/federation/federation-report.ts";
import { defineVerb, runCli } from "../lib/verb-kit.ts";

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
	// legacy `--once` flag rides as an alias of the `once` verb; BARE (the
	// daemon contract) and any other flag head ride `loop`
	const rest = process.argv.slice(2);
	const tokens = rest[0] === "--once" ? ["once", ...rest.slice(1)] : rest;
	await runCli({
		prog: "federation-report",
		about: "federation-report — W171 opt-in spoke self-report.",
		verbs: [
			defineVerb({
				name: "once",
				usage:
					"usage: federation-report once — one cycle; exits 2 on a failed report",
			}),
			defineVerb({
				name: "loop",
				usage:
					"usage: federation-report loop — cycle every FEDERATION_REPORT_INTERVAL_S (default 300s)",
			}),
		],
		defaultVerb: "loop",
		argv: ["bun", "hooks/bin/federation-report.ts", ...tokens],
		dispatch: async (name) => {
			if (name === "loop") {
				console.log(
					`[federation-report] loop every ${String(INTERVAL_S)}s (BUCKLE_HUB_URL=${process.env.BUCKLE_HUB_URL ?? "unset"}, BUCKLE_SPOKE_TEAM=${process.env.BUCKLE_SPOKE_TEAM ?? "unset"})`,
				);
				for (;;) {
					await cycle();
					await Bun.sleep(INTERVAL_S * 1000);
				}
			}
			return (await cycle()) ? 0 : 2;
		},
	});
}
