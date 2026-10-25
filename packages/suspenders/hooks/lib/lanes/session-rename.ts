// hooks/lib/lanes/session-rename.ts — W930 native-rename sync: a supported agent
// CLI's user rename (claude-code writes a `custom-title` JSONL line on
// /rename — verified live 2026-10-19) lands in sessions.tags JSON (`name`
// key, the W293 bridge all @name resolution reads) via the shared stop gate,
// which every dialect rides. The ONE shared verb is `coord rename` (coord/
// fleet.ts) — the gate sync and the verb share renameSession below, so the
// duplicate rule has one source of truth: refuse when another live session
// in the same project holds the slug-equal name; the gate path skips (never
// steals), the verb refuses unless --force.
import { existsSync, statSync } from "node:fs";
import {
	openStore,
	tagNameOf,
	projectIdentity,
	type GovernorStore,
} from "../govdb/govdb.ts";
import { resolveTranscriptPath, transcriptTail } from "./transcript.ts";
import { slugifyLabelPart } from "./addressing.ts";

// liveness windows for the duplicate-holder check. Mirrors coord/bus.ts
// isLiveSession (30-min hb / 15-min transcript) — duplicated, NOT imported:
// coord/ modules open the global store eagerly at module load, and this lib
// must stay store-parameterized for temp-HOME tests.
const LIVE_HB_MS = 30 * 60_000;
const LIVE_TRANSCRIPT_MS = 15 * 60_000;

type HolderRow = {
	sid: string;
	state: string;
	hb: number;
	parent_sid: string | null;
	transcript_path: string | null;
	tags: string | null;
};

function holderLive(row: HolderRow, now: number): boolean {
	if (row.hb > now - LIVE_HB_MS) return true;
	if (row.parent_sid !== null) return false;
	try {
		if (
			row.transcript_path &&
			statSync(row.transcript_path).mtimeMs > now - LIVE_TRANSCRIPT_MS
		)
			return true;
	} catch {
		// transcript unreadable — fall through
	}
	return false;
}

// The claude-code native-name reader: the LAST `custom-title` line in a
// bounded transcript tail wins (the CLI re-emits it every ~10 lines, so the
// tail always carries it). ai-title is the CLI's auto title — never synced.
export function nativeTitleFromTranscript(path: string | null): string | null {
	if (!path || !existsSync(path)) return null;
	const tail = transcriptTail(path, 64 * 1024);
	for (const line of tail.split("\n").reverse()) {
		if (!line.includes('"custom-title"')) continue;
		try {
			const j = JSON.parse(line) as { customTitle?: unknown };
			const t = j.customTitle;
			if (typeof t === "string" && t.trim()) return t.trim();
		} catch {
			// malformed line: keep scanning back
		}
	}
	return null;
}

export type RenameResult =
	| { ok: true; name: string; previous: string | null }
	| {
			ok: false;
			reason: "no-session" | "not-running" | "empty-name" | "duplicate";
			holder?: string;
	  };

// The ONE rename core. Merges `name` into the session row's tags JSON
// (parse-safe, other keys preserved) and inserts a `session.renamed` event —
// both through the caller's store (temp-HOME tests pass a fixture store).
export function renameSession(
	store: GovernorStore,
	sid: string,
	name: string,
	opts: { force?: boolean; now?: number } = {},
): RenameResult {
	const trimmed = name.trim();
	if (!trimmed) return { ok: false, reason: "empty-name" };
	const now = opts.now ?? Date.now();
	const row = store
		.query(
			"SELECT sid, project, tags, state, hb, parent_sid, transcript_path FROM sessions WHERE sid = ?",
		)
		.get(sid) as {
		sid: string;
		project: string;
		tags: string | null;
		state: string;
		hb: number;
		parent_sid: string | null;
		transcript_path: string | null;
	} | null;
	if (!row) return { ok: false, reason: "no-session" };
	if (row.state !== "RUNNING") return { ok: false, reason: "not-running" };
	const previous = tagNameOf(row.tags);
	if (previous === trimmed) return { ok: true, name: trimmed, previous };
	// duplicate-name handling at resolution parity: slug equality is what
	// @name resolution compares, so slug-equal live holders collide
	const slug = slugifyLabelPart(trimmed, sid.slice(0, 8));
	for (const other of store
		.query(
			"SELECT sid, tags, state, hb, parent_sid, transcript_path FROM sessions WHERE project = ? AND sid != ? AND state = 'RUNNING'",
		)
		.all(row.project, sid) as HolderRow[]) {
		if (!holderLive(other, now)) continue;
		if (slugifyLabelPart(tagNameOf(other.tags) ?? "", other.sid) !== slug)
			continue;
		if (!opts.force)
			return { ok: false, reason: "duplicate", holder: other.sid };
	}
	const merged: Record<string, unknown> = {};
	try {
		if (row.tags) Object.assign(merged, JSON.parse(row.tags) as object);
	} catch {}
	merged.name = trimmed;
	store
		.query("UPDATE sessions SET tags = ? WHERE sid = ?")
		.run(JSON.stringify(merged), sid);
	store
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'session.renamed', ?, ?, NULL)",
		)
		.run(
			Date.now(),
			sid,
			row.project,
			JSON.stringify({ project: projectIdentity(), name: trimmed, previous }),
		);
	return { ok: true, name: trimmed, previous };
}

// The stop-gate sync: claude-code payload in, tags update out, fail-open on
// every absence (no sid/transcript, no session row, dead plane, duplicate —
// a display sync never gates a turn end). SUSPENDERS_RENAME_SYNC=0 disables.
export function syncNativeRename(
	hook: { session_id?: string; transcript_path?: string; cwd?: string },
	projectsRoot?: string,
): RenameResult | null {
	if (process.env.SUSPENDERS_RENAME_SYNC === "0") return null;
	const sid = hook.session_id;
	if (!sid) return null;
	const file =
		hook.transcript_path && existsSync(hook.transcript_path)
			? hook.transcript_path
			: resolveTranscriptPath(hook, projectsRoot);
	const native = nativeTitleFromTranscript(file);
	if (!native) return null;
	try {
		const store = openStore();
		const r = renameSession(store, sid, native);
		store.close();
		return r;
	} catch {
		return null; // dead plane: fail-open, like the heartbeat touch
	}
}
