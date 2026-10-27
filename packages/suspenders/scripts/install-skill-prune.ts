// scripts/install-skill-prune.ts — W2177: a clean install owns ONLY the skills
// the fleet catalog installed. registerSkills removes every lock entry whose
// source is a fleet `skills/` catalog — the current checkout, an older
// checkout or item worktree, the pre-monorepo suspenders repo — so renamed
// or retired catalog skills stop hanging around, then re-adds the catalog.
// Skills from any other source (github repos, hand installs) are never
// touched.
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

interface SkillLock {
	skills?: Record<string, { source?: unknown }>;
}

const FLEET_CATALOG_PARENTS = new Set(["fleet", "suspenders"]);

/** True when a lock `source` names a fleet-owned local skills catalog. */
export function isFleetCatalogSource(
	source: string,
	skillsDir: string,
): boolean {
	if (source === skillsDir) return true;
	if (!isAbsolute(source) || basename(source) !== "skills") return false;
	const parent = dirname(source);
	return (
		FLEET_CATALOG_PARENTS.has(basename(parent)) ||
		basename(dirname(parent)) === ".worktrees"
	);
}

/** Skill names the fleet catalog installed, read from the skills CLI lock. */
export function fleetSkillNames(lock: SkillLock, skillsDir: string): string[] {
	return Object.entries(lock.skills ?? {})
		.filter(
			([, entry]) =>
				typeof entry.source === "string" &&
				isFleetCatalogSource(entry.source, skillsDir),
		)
		.map(([name]) => name)
		.sort();
}

/** The lock the skills CLI keeps for global installs; absent = empty. */
export function readSkillLock(home: string): SkillLock {
	try {
		return JSON.parse(
			readFileSync(join(home, ".agents", ".skill-lock.json"), "utf8"),
		) as SkillLock;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}
