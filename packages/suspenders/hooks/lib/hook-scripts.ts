// hooks/lib/hook-scripts.ts — W422.17.1: the interactive-session enrollment
// hooks. The shared lane-auth/lane modules moved into hooks/lib (W1255.2
// scripts-independence), so they resolve from this directory directly — no
// cross-tree layout probing.
import { existsSync } from "node:fs";

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
 *  no git toplevel / no shared lib). probeFn + front injectable for tests —
 *  lane.ts pins BUCKLE_FRONT at module load, so a cached module in a shared
 *  test process would otherwise aim the mint at the live spoke. null =
 *  not enrollable (no git toplevel). */
export const enrollTopLevel = async (o: {
	hookDir: string;
	sid: string;
	cwd: string;
	govMode: "strict" | "solo";
	probeFn?: (front: string) => Promise<string | null>;
	front?: string;
}): Promise<string | null> => {
	const top = gitToplevel(o.cwd);
	if (!top) return null;
	const la = await import("./lanes/lane-auth.ts");
	const lm = await import("./lanes/lane.ts");
	const front: string = o.front ?? lm.BUCKLE_FRONT;
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
	const top = gitToplevel(o.cwd);
	if (!top) return;
	const { laneKeyMetaPath, retireLaneKey } = await import(
		"./lanes/lane-auth.ts"
	);
	const fleet = `${top}/.fleet`;
	if (!existsSync(laneKeyMetaPath(fleet, o.sid))) return;
	await retireLaneKey({ fleet, sid: o.sid, fetchFn: o.fetchFn });
};
