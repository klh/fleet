#!/usr/bin/env bun
// hooks/bin/knowledge-sync.ts — W944: the knowledge-sync RUNNER. Invoked by
// the W779 heartbeat (fleet-loop maintenance task `knowledge-sync`) and by
// hand (`bun hooks/bin/knowledge-sync.ts --json` for a machine-readable
// status pass). One pass per fire: config → collect (decant + facts) →
// per-target POST; the lib stamps the machine-local cursor only when every
// target accepted the pass. Exit 0 on ok/disabled; exit 1 on config error
// or any failed target (the heartbeat fail-logs it; next cadence retries).
import { syncOnce } from "../lib/knowledge/knowledge-sync.ts";

const json = process.argv.includes("--json");
const result = await syncOnce();
if (json) {
	console.log(JSON.stringify(result));
} else {
	if (result.disabled)
		console.log("knowledge-sync: disabled (no machine-level config)");
	if (result.configError)
		console.error(`knowledge-sync: ${result.configError}`);
	for (const o of result.outcomes) {
		if (o.ok)
			console.log(
				`knowledge-sync: ${o.target} ok (${o.sentMetrics} metrics rows, ${o.sentFacts} facts)`,
			);
		else console.error(`knowledge-sync: ${o.target} FAILED: ${o.error}`);
	}
	for (const s of result.skipped) console.error(`knowledge-sync: skip ${s}`);
}
if (result.disabled || result.configError === null) {
	const failed = result.outcomes.some((o) => !o.ok);
	if (!failed) process.exit(0);
}
process.exit(1);
