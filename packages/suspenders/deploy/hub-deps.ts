// fleet-deps boot (hub compose): install the pinned checkout, then bridge
// the git-dep workspace gap. Overlay hubs run base code from
// node_modules/fleet/packages, where bun does not create workspace links —
// cross-package imports like @klh/blam die at boot (W689). Plain fleet
// checkouts (public hub posture) have no node_modules/fleet and skip step 2.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

/** Boot root: the compose volume overlay hubs install + link into (W689).
 *  W714 dropped the const — every post-W714 boot main() died with
 *  ReferenceError before the install ran; restored for the W688.6 bump. */
export const HUB_FLEET_ROOT = "/src/fleet";

export interface BaseLink {
	name: string;
	dir: string;
}

/** Plan the workspace links for one base-monorepo tree. All manifests are
 *  validated BEFORE any link is applied, so a malformed manifest fails the
 *  boot loudly instead of leaving a half-linked tree (W714). */
export function planBaseWorkspaces(root: string): BaseLink[] {
	const basePkgs = `${root}/node_modules/fleet/packages`;
	if (!existsSync(basePkgs)) return [];
	const planned: BaseLink[] = [];
	for (const dir of readdirSync(basePkgs)) {
		const manifest = `${basePkgs}/${dir}/package.json`;
		if (!existsSync(manifest)) continue;
		let name: string | undefined;
		try {
			name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string })
				.name;
		} catch (cause) {
			throw new Error(
				`malformed workspace manifest ${manifest}: ${String(cause)}`,
			);
		}
		if (!name) {
			throw new Error(`workspace manifest ${manifest} has no "name"`);
		}
		planned.push({ name, dir });
	}
	return planned;
}

/** Apply the planned links, replacing dangling symlinks, keeping real
 *  files/dirs as-is. Returns the links that were applied. */
export function linkBaseWorkspaces(root: string): BaseLink[] {
	const planned = planBaseWorkspaces(root);
	for (const { name, dir } of planned) {
		const link = `${root}/node_modules/${name}`;
		// lstat (no follow) sees a dangling link where existsSync (follow)
		// reports nothing: replace broken links, keep real files/dirs as-is
		const st = lstatSync(link, { throwIfNoEntry: false });
		if (st && !st.isSymbolicLink()) continue;
		if (st) unlinkSync(link);
		// mkdir the link's PARENT (dirname), never the link path itself —
		// an unscoped name made the old split("/")[0] mkdir collide with
		// the symlink below (EEXIST); @klh/* names masked it until W714
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(
			`${name.startsWith("@") ? "../" : ""}fleet/packages/${dir}`,
			link,
		);
	}
	return planned;
}

if (import.meta.main) {
	const install = Bun.spawnSync(
		["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
		{ cwd: HUB_FLEET_ROOT, stdout: "inherit", stderr: "inherit" },
	);
	if (install.exitCode !== 0) process.exit(install.exitCode ?? 1);

	// public hub posture: absent base-monorepo dep is correct, but the skip
	// must be visible in the boot log (W714)
	const basePkgs = `${HUB_FLEET_ROOT}/node_modules/fleet/packages`;
	if (!existsSync(basePkgs)) {
		console.log(`no ${basePkgs} — plain fleet checkout, linking skipped`);
		process.exit(0);
	}
	for (const { name, dir } of linkBaseWorkspaces(HUB_FLEET_ROOT)) {
		console.log(`linked ${name} -> fleet/packages/${dir}`);
	}
}
