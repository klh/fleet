// hold-drain.ts bin — W2318: the fleet-loop heartbeat face of HoldAndDrain.
// ONE pass per fire: when the active dispatch hold carries mode:"drain",
// steer live lanes to checkpoint and land (never kill). Cadence and
// pause-file handling ride the maintenance task registry; the bin owns only
// the disable knob and the repo/cwd seam.
import { drainPass } from "../lib/lanes/hold-drain.ts";

const main = (): number => {
	if (process.env.SUSPENDERS_HOLD_DRAIN === "0") {
		console.log("hold-drain disabled (SUSPENDERS_HOLD_DRAIN=0)");
		return 0;
	}
	const repo = process.cwd();
	const result = drainPass(repo, `${repo}/.fleet`);
	if (result.mode !== "drain") {
		console.log("no drain-mode hold — idle");
		return 0;
	}
	for (const [sid, why] of result.failed)
		console.log(`DRAIN-FAIL ${sid} (${why})`);
	for (const sid of result.resting) console.log(`DRAIN-REST ${sid}`);
	for (const sid of result.steered) console.log(`DRAIN-STEERED ${sid}`);
	return 0;
};
main();
