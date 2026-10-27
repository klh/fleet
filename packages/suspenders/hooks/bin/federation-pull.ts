// hooks/bin/federation-pull.ts — W154 spoke pull client entry. Loop mode by
// default (FEDERATION_PULL_INTERVAL_S, default 300s); --once for the sim and
// tests. Hub URL from BUCKLE_HUB_URL only (no real host in committed files;
// sim: source sim/spoke-profile.env and map SIM_HUB_BUCKLE_URL). Degradation
// is normal operation: a failed pull logs one honest line, keeps last-known,
// never blocks routing. --once exits 2 on degraded (honest signal for the
// caller), loop mode never exits on hub-down.
import {
	manifestCapabilities,
	pullFederation,
} from "../lib/federation/federation.ts";
import { reconcileWorkCrs } from "../lib/work/work-cr.ts";
import { openGovernorDb } from "../lib/govdb/govdb.ts";
import { defineVerb, runCli } from "../lib/verb-kit.ts";
import { HUB_ONLY_CAPABILITIES } from "../lib/federation/profile.ts";

const INTERVAL_S = Number(process.env.FEDERATION_PULL_INTERVAL_S ?? "300");

async function cycle(): Promise<boolean> {
	const out = await pullFederation();
	if (out.ok) {
		const models = out.menu.hub_models.length;
		const crs = out.manifest?.cr_queue.length ?? 0;
		const caps = manifestCapabilities(out.manifest);
		const on = HUB_ONLY_CAPABILITIES.filter((k) => caps[k]).join(",");
		console.log(
			`[federation-pull] ok version=${out.manifest?.version} models=${String(models)} cr_queue=${String(crs)} caps=${on || "none"}`,
		);
		// W352: reconcile work.add CRs into this machine's work graph and
		// report status back. Only when a spoke token is wired; a reconcile
		// error degrades one cycle (logged), never the loop.
		if (crs > 0 && (process.env.BUCKLE_SPOKE_TOKEN ?? "").length > 0) {
			try {
				const r = await reconcileWorkCrs({
					manifest: out.manifest,
					db: openGovernorDb(),
					hubUrl: process.env.BUCKLE_HUB_URL ?? "",
					spokeKey: process.env.BUCKLE_SPOKE_TOKEN ?? null,
				});
				if (r.scanned > 0)
					console.log(
						`[federation-pull] work-cr: scanned=${String(r.scanned)} delivered=${String(r.delivered)} applied=${String(r.applied)} failed=${String(r.failed)}`,
					);
				for (const e of r.errors)
					console.error(`[federation-pull] work-cr: ${e}`);
			} catch (e) {
				console.error(
					`[federation-pull] work-cr: reconcile error: ${String(e)}`,
				);
			}
		}
		return true;
	}
	console.error(`[federation-pull] degraded: ${out.reason ?? "unknown"}`);
	return false;
}

if (import.meta.main) {
	// legacy `--once` flag rides as an alias of the `once` verb; BARE (the
	// services.yaml/plist contract) and any other flag head ride `loop`
	const rest = process.argv.slice(2);
	const tokens = rest[0] === "--once" ? ["once", ...rest.slice(1)] : rest;
	await runCli({
		prog: "federation-pull",
		about: "federation-pull — W154 spoke pull client.",
		verbs: [
			defineVerb({
				name: "once",
				usage:
					"usage: federation-pull once — one cycle; exits 2 when the hub is down",
			}),
			defineVerb({
				name: "loop",
				usage:
					"usage: federation-pull loop — cycle every FEDERATION_PULL_INTERVAL_S (default 300s)",
			}),
		],
		defaultVerb: "loop",
		argv: ["bun", "hooks/bin/federation-pull.ts", ...tokens],
		dispatch: async (name) => {
			if (name === "loop") {
				console.log(
					`[federation-pull] loop every ${String(INTERVAL_S)}s (BUCKLE_HUB_URL=${process.env.BUCKLE_HUB_URL ?? "unset"})`,
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
