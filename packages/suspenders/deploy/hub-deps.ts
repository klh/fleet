// fleet-deps boot (hub compose): install the pinned checkout, then bridge
// the git-dep workspace gap. Overlay hubs run base code from
// node_modules/fleet/packages, where bun does not create workspace links —
// cross-package imports like @klh/blam die at boot (W689). Plain fleet
// checkouts (public hub posture) have no node_modules/fleet and skip step 2.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
} from "node:fs";

const ROOT = "/src/fleet";

const install = Bun.spawnSync(
	["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
	{ cwd: ROOT, stdout: "inherit", stderr: "inherit" },
);
if (install.exitCode !== 0) process.exit(install.exitCode ?? 1);

// Link every base-monorepo workspace under its real package name so
// node resolution from node_modules/fleet/packages/<pkg> finds siblings.
const basePkgs = `${ROOT}/node_modules/fleet/packages`;
if (!existsSync(basePkgs)) process.exit(0);

for (const dir of readdirSync(basePkgs)) {
	const manifest = `${basePkgs}/${dir}/package.json`;
	if (!existsSync(manifest)) continue;
	const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string })
		.name;
	if (!name) continue;
	const link = `${ROOT}/node_modules/${name}`;
	if (existsSync(link)) continue;
	mkdirSync(`${ROOT}/node_modules/${name.split("/")[0]}`, { recursive: true });
	symlinkSync(`fleet/packages/${dir}`, link);
	console.log(`linked ${name} -> fleet/packages/${dir}`);
}
