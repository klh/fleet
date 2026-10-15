// models.catalog.ts — W754.1: the ONE model-acquisition catalog. Binds
// ACQUISITION (repo / revision / license / runtime) to belt's SERVING
// registry (port↔model pairs live only there). The repo copy is the reviewed
// public default with PINNED revisions; the machine-level
// ~/.claude/local-llm/models.catalog.json adds private entries and wins id
// collisions (config-over-code — hub-only / org-internal models live only
// in the machine copy, never committed).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	EXTERNAL,
	SPECIALISTS,
	platformDefinitions,
	type Platform,
} from "../belt/bin/registry.ts";

export interface CatalogEntry {
	id: string;
	/** HF org/name, or hub://host/path for hub-store-only artifacts. */
	repo: string;
	/** Pinned commit sha (7-40 hex) — floating branches are rejected. */
	revision: string;
	quant?: string;
	/** SPDX identifier — acquisition without a license is a supply risk. */
	license: string;
	runtime: "mlx" | "gguf";
	/** Platforms this row serves — default = runtime-implied (mlx→darwin,
	 * gguf→win32+linux via belt's platformDefinitions). */
	platforms?: Platform[];
	/** Belt registry port this model serves. */
	specialist: number;
	/** always = ship with fleet; optin = dev pulls from their hub. */
	tier: "always" | "optin";
	sizeGb?: number;
	note?: string;
}

export interface Catalog {
	version: 1;
	models: CatalogEntry[];
}

const REPO_RE = /^(hub:\/\/[\w.-]+\/.+|[\w.-]+\/[\w.-]+)$/;
const REVISION_RE = /^[0-9a-f]{7,40}$/;
const FLOATING = new Set(["main", "master"]);

/** Platforms implied by the runtime — the platformDefinitions inverse. */
export const platformsForRuntime = (runtime: "mlx" | "gguf"): Platform[] =>
	runtime === "mlx" ? ["darwin"] : ["win32", "linux"];

/** Platforms a row serves — explicit platforms or the runtime-implied default. */
export const entryPlatforms = (
	m: Pick<CatalogEntry, "runtime" | "platforms">,
): Platform[] => m.platforms ?? platformsForRuntime(m.runtime);

export function validateCatalog(
	models: CatalogEntry[],
	registry: Pick<(typeof SPECIALISTS)[number], "port" | "model">[] = [
		...SPECIALISTS,
		...EXTERNAL,
	],
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	const seen = new Set<string>();
	const byPort = new Map(registry.map((s) => [s.port, s.model]));
	const litPort = new Map<string, string>();
	for (const m of models) {
		const at = (label: string, cond: boolean) => {
			if (!cond) errors.push(`${m.id}: ${label}`);
		};
		const dupe = seen.has(m.id);
		if (!dupe) seen.add(m.id);
		at("duplicate id", !dupe);
		at(`repo format (${m.repo})`, REPO_RE.test(m.repo));
		at(
			`revision must be a pinned sha, not a floating branch (${m.revision})`,
			!FLOATING.has(m.revision) && REVISION_RE.test(m.revision),
		);
		at("license missing", Boolean(m.license?.trim()));
		at(
			`runtime unknown (${m.runtime})`,
			m.runtime === "mlx" || m.runtime === "gguf",
		);
		at(`tier unknown (${m.tier})`, m.tier === "always" || m.tier === "optin");
		const served = byPort.get(m.specialist);
		at(
			`specialist :${m.specialist} not in belt registry`,
			served !== undefined,
		);
		// mlx entries acquire exactly what the registry serves — the id in
		// the registry IS the acquisition target; gguf entries are the
		// cross-platform variants (W751.1 lights up their runtime rows).
		if (served && m.runtime === "mlx") {
			at(
				`mlx repo (${m.repo}) must equal the :${m.specialist} registry model (${served})`,
				m.repo === served,
			);
		}
		// W765: rows light up per platform — mlx rows darwin-only, gguf rows
		// win32/linux; the pairing IS belt's platformDefinitions table.
		for (const p of entryPlatforms(m)) {
			const want = m.runtime === "mlx" ? "mlx" : "llama.cpp";
			at(
				`runtime ${m.runtime} invalid on ${p} (platform runtime is ${platformDefinitions[p].runtime})`,
				platformDefinitions[p].runtime === want,
			);
			const key = `${p}:${m.specialist}`;
			const prior = litPort.get(key);
			if (prior) {
				errors.push(
					`${m.id}: duplicate ${p} row for :${m.specialist} (${prior} vs ${m.id})`,
				);
			} else litPort.set(key, m.id);
		}
	}
	return { ok: errors.length === 0, errors };
}

/** Entries lit on a platform — gguf rows light up on win32/linux (W765). */
export const catalogForPlatform = (
	models: CatalogEntry[],
	platform: Platform,
): CatalogEntry[] => models.filter((m) => entryPlatforms(m).includes(platform));

export interface CatalogPaths {
	repo: string;
	machine: string;
}

export function catalogPaths(machine?: string): CatalogPaths {
	return {
		repo: new URL("./models.catalog.json", import.meta.url).pathname,
		machine:
			machine ?? join(homedir(), ".claude", "local-llm", "models.catalog.json"),
	};
}

/** Repo default ∪ machine-level additions; machine wins id collisions. */
export function loadCatalog(paths: CatalogPaths = catalogPaths()): Catalog {
	const read = (file: string): CatalogEntry[] => {
		const doc = JSON.parse(readFileSync(file, "utf8")) as Catalog;
		return doc.models;
	};
	const merged = new Map<string, CatalogEntry>();
	for (const m of read(paths.repo)) merged.set(m.id, m);
	if (existsSync(paths.machine)) {
		for (const m of read(paths.machine)) merged.set(m.id, m);
	}
	const models = [...merged.values()];
	const v = validateCatalog(models);
	if (!v.ok) throw new Error(`model catalog invalid:\n${v.errors.join("\n")}`);
	return { version: 1, models };
}
