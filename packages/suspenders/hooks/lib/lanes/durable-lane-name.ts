// hooks/lib/lanes/durable-lane-name.ts — W2863 face (c): durable per-CLI lane
// identity. A nameless bootstrapped session gets a stable `<cli>@<short-host>`
// (collision-escaped `-2`..`-9` among LIVE holders via renameSession's
// duplicate rule) so `coord consult --to <name>` resolves without raw sids —
// pi's witness grade (c): PI_SESSION_ID dies with the session; the name is
// what peers address. Fail-open: naming never breaks a bootstrap, and an
// existing name (user /rename, W954 native title) always wins — this only
// stamps the nameless.
import { hostname } from "node:os";
import { type GovernorStore, tagNameOf } from "../govdb/govdb.ts";
import { renameSession, type RenameResult } from "./session-rename.ts";

export function shortHostname(raw = hostname()): string {
	const trimmed = raw
		.trim()
		.toLowerCase()
		.replace(/\.local\.?$/, "");
	return trimmed || "localhost";
}

export function computeDurableName(
	cli: string,
	host = shortHostname(),
): string {
	return `${cli}@${host}`;
}

// Applies the durable name to a NAMELESS RUNNING session. Returns null when
// the row is missing/not RUNNING/already named (nothing to do — W954 and user
// renames own the name), else the first accepted rename.
export function applyDurableLaneName(
	store: GovernorStore,
	sid: string,
	cli: string,
	opts: { host?: string } = {},
): RenameResult | null {
	const row = store
		.query("SELECT tags, state FROM sessions WHERE sid = ?")
		.get(sid) as { tags: string | null; state: string } | null;
	if (row?.state !== "RUNNING") return null;
	if (tagNameOf(row.tags)) return null; // named already — never steal
	const host = opts.host ?? shortHostname();
	const base = computeDurableName(cli, host);
	for (let i = 0; i < 9; i++) {
		const candidate = i === 0 ? base : `${base}-${i + 1}`;
		const r = renameSession(store, sid, candidate);
		if (r.ok) return r;
		if (r.reason !== "duplicate") return r;
	}
	return null;
}
