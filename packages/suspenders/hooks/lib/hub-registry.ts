// hooks/lib/hub-registry.ts — W1256.2: ~/.claude/local-llm/hubs.json is a
// GENERATED projection of the ONE stack config (stack.yaml `hubs:`), written
// at install (seedLocalLlm). This retires the hand-maintained second
// registry: the file converges to ONE shape — label → {candidates, token?} —
// the shape hub-locate.readRegistry, belt readHubs/hubTargets and
// cross-hub-usage already parse. speedy's W230 spoke roster (a `{hubs:[…]}`
// array at the same path, written by enrollHub) is migrated url-only so an
// enrolled spoke URL keeps resolving; its token lives in hub.env (0600) and
// is referenced by env name — never copied into the registry.
//
// Fail-closed lines: a machine with no stack config is never touched (the
// spoke roster flow owns the file at that path); a stack hub without a url
// projects no registry entry (nothing to probe); write failures degrade to a
// note at install (the resolveHub chain still resolves stack labels at
// runtime).
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { REGISTRY_PATH } from "./hub-locate.ts";
import { tryLoadStack, type HubProfile } from "./stack-config.ts";

/** The registry entry shape every consumer parses (hub-locate/belt/cross-hub). */
export interface HubRegistryEntry {
	candidates: string[];
	token?: string;
}

export type HubRegistry = Record<string, HubRegistryEntry>;

/** Inline stack token first, then the 0600 token_file content. A missing or
 *  unreadable file yields undefined — the entry still projects its URL. */
function readTokenFile(file?: string): string | undefined {
	if (!file) return undefined;
	try {
		const t = readFileSync(file, "utf8").trim();
		return t.length > 0 ? t : undefined;
	} catch {
		return undefined;
	}
}

/** Project the stack hubs into the registry shape. Labels keep the stack
 *  profile key verbatim; consumers join case-insensitively (belt hubProfiles,
 *  resolveHub both normalize). */
export function hubRegistryFromStack(stack: {
	hubs: Record<string, HubProfile>;
}): HubRegistry {
	const out: HubRegistry = {};
	for (const [label, profile] of Object.entries(stack.hubs ?? {})) {
		const url = profile.url?.trim().replace(/\/+$/, "");
		if (!url) continue;
		const entry: HubRegistryEntry = { candidates: [url] };
		const token = profile.token ?? readTokenFile(profile.token_file);
		if (token) entry.token = token;
		out[label] = entry;
	}
	return out;
}

/** Roster-shape leftover (speedy W230 enrollHub's `{hubs:[…]}` array) →
 *  url-only map entries, so an enrolled spoke URL keeps resolving after the
 *  generated map replaces the roster. Token env NAMES never migrate. */
export function rosterUrlEntries(text: string): HubRegistry {
	const out: HubRegistry = {};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return out;
	}
	if (!raw || typeof raw !== "object") return out;
	const roster = (raw as { hubs?: unknown }).hubs;
	if (!Array.isArray(roster)) return out;
	for (const row of roster) {
		if (!row || typeof row !== "object") continue;
		const name = (row as { name?: unknown }).name;
		const url = (row as { url?: unknown }).url;
		if (typeof name !== "string" || typeof url !== "string") continue;
		const base = url.trim().replace(/\/+$/, "");
		if (!base) continue;
		out[name] = { candidates: [base] };
	}
	return out;
}

export type HubRegistryWrite =
	| { status: "ok"; labels: string[]; note: string }
	| { status: "absent" | "failed"; labels?: string[]; note: string };

/** Regenerate the registry from the stack config (install step). Writes only
 *  when a stack config exists — a stack-less machine (spoke) keeps whatever
 *  the enrollment flow wrote. Stack labels win; roster-shape leftovers
 *  migrate url-only; hand-added keys the stack does not name retire. */
export function writeHubRegistry(
	file: string = REGISTRY_PATH(),
	stack: { hubs: Record<string, HubProfile> } | null = tryLoadStack(),
): HubRegistryWrite {
	if (!stack) return { status: "absent", note: "no stack config — untouched" };
	const out: HubRegistry = hubRegistryFromStack(stack);
	try {
		const roster = rosterUrlEntries(readFileSync(file, "utf8"));
		for (const [label, entry] of Object.entries(roster)) {
			if (out[label]) continue;
			out[label] = entry;
		}
	} catch {
		// unreadable or missing file — nothing to migrate
	}
	const body = `${JSON.stringify(out, null, "\t")}\n`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
		chmodSync(file, 0o600);
	} catch (err) {
		return {
			status: "failed",
			note: `write failed — ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return {
		status: "ok",
		labels: Object.keys(out),
		note: `hub registry generated from stack (${Object.keys(out).length} hubs)`,
	};
}
