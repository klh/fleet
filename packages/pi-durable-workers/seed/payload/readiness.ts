// seed/payload/readiness.ts — W2958 in-image readiness probe.
// Runs inside the seed container; prints ONE readiness JSON line and the
// READY marker on success. Exit 1 with the failed check names otherwise.
// Mirrors the OpenHands sandbox /health contract: readiness only after
// tools initialize — here the real @klh/pi-durable-workers extension
// factory, the pi-durable registry, git presence and tmp writability.
import { READY_MARKER, realProbes, runReadinessChecks } from "../src/seed-readiness.ts";

const expectedBun = process.argv[2] ?? "1.4.2";
const result = runReadinessChecks(realProbes(expectedBun));
console.log(JSON.stringify(result));
if (result.ready) {
	console.log(READY_MARKER);
	process.exit(0);
}
process.exit(1);
