// hooks/lib/hook-scripts.ts — W422.17.1: hooks that need the shared
// scripts/lib modules resolve them in BOTH install layouts: the repo has
// hooks/ beside scripts/; the installed prefix flattens hooks/ to its root
// (session-start.ts beside scripts/). Null = not found (caller degrades).
import { existsSync } from "node:fs";
import { join } from "node:path";

export const scriptsLibPath = (base: string, name: string): string | null => {
	for (const p of [
		join(base, "scripts", "lib", name),
		join(base, "..", "scripts", "lib", name),
	])
		if (existsSync(p)) return p;
	return null;
};

const gitToplevel = (cwd: string): string | null => {
	const top = Bun.spawnSync(
		["git", "-C", cwd, "rev-parse", "--show-toplevel"],
		{ stdout: "pipe", stderr: "ignore" },
	);
	return top.exitCode === 0
		? new TextDecoder().decode(top.stdout).trim()
		: null;
};

/** Interactive-session enrollment for a top-level session: resolve the
 *  shared lane-auth/lane modules, probe the buckle front, reuse-or-mint the
 *  per-session key, return the GOVERNANCE note (null = not enrollable —
 *  no git toplevel / no shared lib). probeFn injectable for tests. */
export const enrollTopLevel = async (o: {
	hookDir: string;
	sid: string;
	cwd: string;
	govMode: "strict" | "solo";
	probeFn?: (front: string) => Promise<string | null>;
}): Promise<string | null> => {
	const laP = scriptsLibPath(o.hookDir, "lane-auth.ts");
	const laneP = scriptsLibPath(o.hookDir, "lane.ts");
	const top = gitToplevel(o.cwd);
	if (!laP || !laneP || !top) return null;
	const la = await import(laP);
	const lm = await import(laneP);
	const front: string = lm.BUCKLE_FRONT;
	const probe = o.probeFn ?? lm.probeBuckleFront;
	const r = await la.enrollSessionKey({
		fleet: `${top}/.fleet`,
		sid: o.sid,
		front,
		frontUp: await probe(front),
		govMode: o.govMode,
	});
	return r.note;
};

/** Session-end counterpart: revoke + delete the 0600 enrollment files when
 *  this session minted one (meta-file existence guard). fetchFn injectable
 *  for tests. */
export const retireTopLevel = async (o: {
	hookDir: string;
	sid: string;
	cwd: string;
	fetchFn?: typeof fetch;
}): Promise<void> => {
	const laP = scriptsLibPath(o.hookDir, "lane-auth.ts");
	const top = gitToplevel(o.cwd);
	if (!laP || !top) return;
	const { laneKeyMetaPath, retireLaneKey } = await import(laP);
	const fleet = `${top}/.fleet`;
	if (!existsSync(laneKeyMetaPath(fleet, o.sid))) return;
	await retireLaneKey({ fleet, sid: o.sid, fetchFn: o.fetchFn });
};
