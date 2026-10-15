// hubs.ts — remote buckle hubs as supervised rows (W351 probe-only, W371
// self-healing).
//
// ~/.claude/local-llm/hubs.json is the label → candidate-URLs registry
// suspenders' resolveHub() walks (hooks/lib/hub-locate.ts). Belt reads the
// SAME file (env SUSPENDERS_HUBS_FILE overrides, same key) and turns each
// label into a supervisor Target so the dashboard's Supervisor section and
// /llms.txt can surface the hubs visibly.
//
// W371: a hub whose stack.yaml profile declares deploy.dir is RESTARTABLE —
// belt runs docker compose up on the hub when it is down (ssh-wrapped for a
// remote deploy.ssh target, local /bin/sh for a local-docker hub). Labels
// join case-insensitively (coord hubs precedent); a hub without a profile
// stays probe-only. Belt still never spawns ON another host — the restart
// is one compose-up command the hub executes.

import { readFileSync } from "node:fs";
import { composeUpArgv } from "../../suspenders/deploy/hub-remote.ts";
import {
	inQuietHours,
	tryLoadStack,
	type HubProfile,
} from "../../suspenders/hooks/lib/stack-config.ts";
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
	for (const [label, entry] of Object.entries(raw as Record<string, unknown>)) {
		const candidates =
			entry && typeof entry === "object" && !Array.isArray(entry)
				? (entry as { candidates?: unknown }).candidates
				: null;
		const base =
			typeof candidates === "string"
				? candidates
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

/** W371: stack.yaml profiles that declare deploy.dir, keyed by lowercased
 *  hub label — the restartable set. Missing/unparseable stack.yaml = no
 *  restartable hubs (belt runs heal-less, same tolerance as coord hubs). */
function healProfiles(): Map<string, HubProfile> {
	const out = new Map<string, HubProfile>();
	for (const [label, hub] of Object.entries(tryLoadStack()?.hubs ?? {})) {
		if (hub.deploy?.dir) out.set(label.toLowerCase(), hub);
	}
	return out;
}

/** One whole-heal budget: compose up may pull images / start cold containers.
 *  The supervisor polls the port for this long after a clean compose exit. */
export const HUB_BIND_TIMEOUT_MS = 90_000;

const HEAL_CMD_TIMEOUT_MS = 120_000;

/** W371 heal closure: docker compose up on the hub. Null = clean run; a
 *  string is a bounded failure note (last stderr/out lines). */
export function hubHeal(profile: HubProfile): () => Promise<string | null> {
	return async () => {
		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn(composeUpArgv(profile), {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (e) {
			return `heal spawn failure: ${String(e)}`;
		}
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
		}, HEAL_CMD_TIMEOUT_MS);
		try {
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code === 0) return null;
			const note = `${err}${out}`.trim();
			const lines = note.split("\n").slice(-3).join(" | ");
			return `compose up exit ${code}: ${lines.slice(0, 300)}`;
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Supervisor targets for the registry. Probe-only by default; rows whose
 *  stack.yaml profile declares deploy.dir carry a heal closure + quiet-hours
 *  hold (W483: a hub is EXPECTED down in its window — no restart attempts,
 *  no paging). */
export function hubTargets(): Target[] {
	const profiles = healProfiles();
	return readHubs().map((h) => {
		const row: Target = {
			name: h.label,
			port: h.port,
			kind: "hub",
			owned: false,
			host: h.host,
			...(h.tls ? { scheme: "https" as const } : {}),
			healthPath: "/api/health",
		};
		const profile = profiles.get(h.label.toLowerCase());
		if (!profile) return row;
		return {
			...row,
			heal: hubHeal(profile),
			quietHours: () => inQuietHours(profile),
			bindTimeoutMs: HUB_BIND_TIMEOUT_MS,
		};
	});
}

/** One llms.txt row per hub: `- LABEL base — state`. */
export function hubLlmsRows(
	rows: HubRow[],
	stateOf: (h: HubRow) => string,
): string[] {
	return rows.map((h) => `- ${h.label} ${h.base} — ${stateOf(h)}`);
}
