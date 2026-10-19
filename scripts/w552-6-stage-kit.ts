// W552.6: stage the private demo kit in /tmp with an absolute lane-auth import,
// run live-kit prepare for take-7-single, sync the take dir back into .fleet.
import {
	cpSync,
	existsSync,
	rmSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";

const fleetRoot = "/Volumes/Sensitive/github/klh/fleet";
const kitSrc = join(fleetRoot, ".fleet/demos/ikea-recording");
const stage = "/tmp/w552-6-kit";
const takeName = "take-7-single";

// 1. fresh staging dir with just the executable kit surface
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["live-kit.ts", "answer-policy.ts"]) {
	cpSync(join(kitSrc, f), join(stage, f));
}

// 2. make the lane-auth import absolute (relative path breaks outside the repo)
const liveKitPath = join(stage, "live-kit.ts");
const src = readFileSync(liveKitPath, "utf8");
const relImport = "../../../packages/suspenders/scripts/lib/lane-auth.ts";
if (!src.includes(relImport)) throw Error("lane-auth import anchor not found");
const absImport = join(
	fleetRoot,
	"packages/suspenders/scripts/lib/lane-auth.ts",
);
writeFileSync(liveKitPath, src.replace(relImport, absImport));

// 3. prepare (fetches the fresh NAS policy manifest; throws if the NAS route is down)
const env = { ...process.env, FLEET_DEMO_TAKE: takeName };
const prep = Bun.spawnSync(["bun", liveKitPath, "prepare"], {
	env,
	stdout: "pipe",
	stderr: "pipe",
	timeout: 90000,
});
console.log("prepare exit", prep.exitCode);
console.log(prep.stdout.toString().trim());
if (prep.exitCode !== 0) {
	console.error(prep.stderr.toString().slice(-1500));
	process.exit(prep.exitCode);
}

// 4. sync the staged take dir back into the private kit lineage
const takeBack = join(kitSrc, takeName);
rmSync(takeBack, { recursive: true, force: true });
cpSync(join(stage, takeName), takeBack, { recursive: true });
console.log(
	"synced back:",
	takeBack,
	existsSync(join(takeBack, "nas-policy-manifest.json")),
);
