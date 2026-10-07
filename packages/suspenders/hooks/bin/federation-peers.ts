// hooks/bin/federation-peers.ts — W362 peer policy propagation entry.
// Loop mode by default (FEDERATION_PEERS_INTERVAL_S, default 300s); --once
// for the sim and tests. Peer labels from HUB_PEERS (the hubctl-rendered,
// compose-forwarded form) or stack.yaml hubs.<KLH_HUB_NAME>.peers. Every
// peer degrades independently: a failed pull logs one honest line, keeps
// last-known, never blocks the hub. --once exits 2 when any peer degraded
// (honest signal for the caller), loop mode never exits on peer-down.
import { pullPeerPolicy, resolvePeerLabels } from "../lib/federation-peers.ts";

const INTERVAL_S = Number(process.env.FEDERATION_PEERS_INTERVAL_S ?? "300");

async function cycle(): Promise<boolean> {
	const labels = resolvePeerLabels();
	if (labels.length === 0) {
		console.log(
			"[federation-peers] no peer edges declared (HUB_PEERS / stack.yaml hubs.<me>.peers) — idle",
		);
		return true;
	}
	let ok = true;
	for (const row of await pullPeerPolicy()) {
		if (row.degraded) {
			ok = false;
			console.error(
				`[federation-peers] ${row.label}: degraded — ${row.reason ?? "unknown"}; keeping last-known ${row.version === null ? "(none yet)" : `(${row.version})`}`,
			);
			continue;
		}
		const what = row.seeded ? "seeded" : row.changed ? "CHANGED" : "unchanged";
		console.log(
			`[federation-peers] ${row.label}: ${what} version=${row.version} via=${row.via} rules=${String(row.rules)} cr_queue=${String(row.cr_queue)}`,
		);
	}
	return ok;
}

if (import.meta.main) {
	if (process.argv.includes("--once")) {
		const ok = await cycle();
		process.exit(ok ? 0 : 2);
	}
	console.log(
		`[federation-peers] loop every ${String(INTERVAL_S)}s (HUB_PEERS=${process.env.HUB_PEERS ?? "unset"} KLH_HUB_NAME=${process.env.KLH_HUB_NAME ?? "unset"})`,
	);
	for (;;) {
		await cycle();
		await Bun.sleep(INTERVAL_S * 1000);
	}
}
