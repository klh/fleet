// hubs.ts — remote buckle hubs as supervised probe-only rows (W351).
//
// ~/.claude/local-llm/hubs.json is the label → candidate-URLs registry
// suspenders' resolveHub() walks (hooks/lib/hub-locate.ts). Belt reads the
// SAME file (env SUSPENDERS_HUBS_FILE overrides, same key) and turns each
// label into a supervisor Target so the dashboard's Supervisor section and
// /llms.txt can surface the hubs visibly. Belt never spawns on another
// host — hub rows are probe-only (owned: false): TCP connect + any HTTP
// answer on the health path = up; port bound, no HTTP = degraded; no TCP
// = down.

import { readFileSync } from "node:fs";
import type { Target } from "./supervisor.ts";

const HUBS_PATH = () =>
	process.env.SUSPENDERS_HUBS_FILE ??
	`${process.env.HOME}/.claude/local-llm/hubs.json`;

export interface HubRow {
	label: string;
	/** First candidate URL (hub-locate precedence: candidates are ordered). */
	base: string;
	host: string;
	port: number;
	tls: boolean;
}

/** Parse the hub registry — entries with a usable candidate URL only.
 *  Missing or unreadable file = no rows (belt runs hub-less). */
export function readHubs(file = HUBS_PATH()): HubRow[] {
	const rows: HubRow[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return rows;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rows;
	for (const [label, entry] of Object.entries(
		raw as Record<string, unknown>,
	)) {
		const candidates =
			entry && typeof entry === "object" && !Array.isArray(entry)
				? (entry as { candidates?: unknown }).candidates
				: null;
		const base =
			typeof candidates === "string" ? candidates
			: Array.isArray(candidates) && typeof candidates[0] === "string"
				? candidates[0]
				: "";
		if (!base) continue;
		let url: URL;
		try {
			url = new URL(base);
		} catch {
			continue;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") continue;
		rows.push({
			label,
			base: base.replace(/\/$/, ""),
			host: url.hostname,
			port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
			tls: url.protocol === "https:",
		});
	}
	return rows;
}

/** Supervisor targets for the registry — probe-only rows, never spawned. */
export function hubTargets(): Target[] {
	return readHubs().map((h) => ({
		name: h.label,
		port: h.port,
		kind: "hub" as const,
		owned: false,
		host: h.host,
		...(h.tls ? { scheme: "https" as const } : {}),
		healthPath: "/api/health",
	}));
}

/** One llms.txt row per hub: `- LABEL base — state`. */
export function hubLlmsRows(
	rows: HubRow[],
	stateOf: (h: HubRow) => string,
): string[] {
	return rows.map((h) => `- ${h.label} ${h.base} — ${stateOf(h)}`);
}
