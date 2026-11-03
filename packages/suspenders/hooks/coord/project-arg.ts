import { existsSync } from "node:fs";
import { db, die, projectIdentity, resolve } from "./shared.ts";

// hooks/coord/project-arg.ts — W1242 `--project <path|name>` resolution for
// `coord fleet`. Extracted from fleet.ts in W2214 to hold fleet.ts under the
// 1200-line stop rule while the W1242 supervisor-table face lands.

/** display name of a project key: basename with a trailing .git stripped
 *  (…/fleet/.git → fleet; bare keys pass through). */
export const projectDisplayName = (project: string): string =>
	project
		.split("/")
		.pop()
		?.replace(/\.git$/, "") ||
	project.split("/").slice(-2, -1).pop() ||
	project;

/** W1242 --project <path|name>: a path (contains "/", or "." / "..") resolves
 *  through the ONE identity resolver (projectIdentity — the coord project
 *  resolution every other verb rides); a bare name matches the graph's
 *  distinct project keys by display name. Misses die with the known set. */
export const resolveProjectArg = (ref: string): string => {
	if (ref.includes("/") || ref === "." || ref === "..") {
		const p = resolve(ref);
		if (!existsSync(p)) die(`fleet --project: no such path: ${ref}`);
		return projectIdentity(p);
	}
	const byName = new Map<string, string[]>();
	for (const r of db.query("SELECT DISTINCT project FROM work_items").all() as {
		project: string;
	}[]) {
		const k = projectDisplayName(r.project);
		byName.set(k, [...(byName.get(k) ?? []), r.project]);
	}
	const hits = byName.get(ref);
	if (hits?.length === 1) return hits[0];
	if (hits)
		die(
			`fleet --project: ambiguous name ${JSON.stringify(ref)} — candidates: ${hits.join(", ")}`,
		);
	die(
		`fleet --project: no project ${JSON.stringify(ref)} — known: ${[...byName.keys()].sort().join(", ") || "(none)"}`,
	);
};
