// hooks/lib/decant-roll.ts — W1220: the decant daily's UPWARD dual-write
// post-pass (the dosu pattern: read knowledge locally, sync it to the remote
// db, keep the local one primary). After the daily's LOCAL fact writes land,
// this pass rolls the day's CAS'd claims up to the configured hub sink via
// the W1213 transport (the postRoll ack contract), reusing the W944
// knowledge-sync machine conf (readSyncConfig — the sink is a machine-conf
// decision, never a repo one) and the W1213 claims cursor (state.claims in
// the shared knowledge-sync state file — whoever acks first stamps it, so
// the daily post-pass and the 30-min knowledge-sync never double-push).
//
// The lifecycle contract (docs/knowledge-lifecycle.md, W1220 clause):
//   - LOCAL PRIMARY (fail-open): a sink outage logs and retries the next
//     daily run; it NEVER blocks, fails, or rolls back the local write —
//     the daily's exit code stays the LOCAL result only.
//   - IDEMPOTENT: the cursor stamps only on a full ack; a same-day rerun
//     collects zero new rows; the sink side dedupes by claim hash anyway.
//   - RETRACTION: rides the W1213.3 monotonic tombstone semantics — a
//     retracted facts row rolls as a tombstone event, so a delete on the
//     origin leaves no zombie on the sink.
import {
	readSyncState,
	writeSyncState,
	syncStatePath,
	postRoll,
	type SyncState,
} from "./knowledge/knowledge-sync.ts";
import {
	readSyncConfig,
	SYNC_CONFIG_PATH,
	type SyncTarget,
} from "./knowledge/knowledge-sync-policy.ts";
import { collectClaims, type RollEntry } from "./knowledge/knowledge-roll.ts";

// ─── the pass ───────────────────────────────────────────────────────────────

/** The roll post-pass's outcome. `ok` is the PASS's flag, never the local
 *  run's — the daily keeps its own local-only ok (fail-open law). */
export interface DailyRollResult {
	/** true when the pass ran clean (pushed, nothing to push, or the roll
	 *  face is simply not configured). false = a config error or a failed
	 *  push — logged, retried by the next daily run, never fatal locally. */
	ok: boolean;
	/** the roll face is off: no machine conf, or no target with rollUrl +
	 *  rollKeyFile. Not an error — the daily is then local-only. */
	disabled: boolean;
	/** roll target origins attempted this pass. */
	targets: string[];
	/** entries collected for this pass (the day's un-acked claims). */
	sent: number;
	/** every target acked → the cursor stamped; a rerun collects zero. */
	pushed: boolean;
	skipped: string[];
	/** per-target failures — the log evidence the acceptance asks for. */
	errors: string[];
}

/** The injectable deps (tests pin temp conf/state/db paths). */
export interface DailyRollOpts {
	configPath?: string;
	statePath?: string;
	/** governor.db to read claims from (tests: fixture db). */
	dbPath?: string | null;
}

/** A clean, disabled pass — the fail-open base every early return starts
 *  from; helpers fold their outcomes into the SAME object. */
function freshResult(): DailyRollResult {
	return {
		ok: true,
		disabled: true,
		targets: [],
		sent: 0,
		pushed: false,
		skipped: [],
		errors: [],
	};
}

/** Record one failure and flip the pass flag (the fail-open fold). */
function failRoll(r: DailyRollResult, msg: string): DailyRollResult {
	r.ok = false;
	r.errors.push(msg);
	return r;
}

/** One upward roll pass: machine conf → roll targets → collect → push →
 *  stamp. Never throws — every failure degrades into the result (fail-open:
 *  the daily's local write is already banked before this runs). */
export async function pushDailyRoll(
	opts: DailyRollOpts = {},
): Promise<DailyRollResult> {
	const r = freshResult();
	let config: ReturnType<typeof readSyncConfig> = null;
	try {
		config = readSyncConfig(opts.configPath ?? SYNC_CONFIG_PATH());
	} catch (e) {
		return failRoll(r, `config: ${e instanceof Error ? e.message : String(e)}`);
	}
	// no machine conf = the roll face is off — the daily stays local-only
	if (!config) return r;
	const rollTargets = config.targets.filter((t) => t.rollUrl && t.rollKeyFile);
	if (rollTargets.length === 0) return r;
	r.disabled = false;
	const statePath = opts.statePath ?? syncStatePath();
	const state = readSyncState(statePath);
	const collected = collectClaims(state, { dbPath: opts.dbPath });
	r.skipped.push(...collected.skipped);
	r.sent = collected.send.length;
	// nothing new since the last full ack — the same-day rerun acceptance
	if (collected.send.length === 0) return r;
	return await pushTargets(
		r,
		rollTargets,
		collected.send,
		state,
		statePath,
		collected.cursor,
	);
}

/** Push to every roll target; the claims cursor stamps only on a FULL ack
 *  (the W1213.2 posture): a partial pass re-sends the whole un-acked set
 *  next daily run — the sink is idempotent by claim hash, so the retry
 *  never duplicates rows. */
async function pushTargets(
	r: DailyRollResult,
	targets: SyncTarget[],
	entries: RollEntry[],
	state: SyncState,
	statePath: string,
	cursor: Record<string, number>,
): Promise<DailyRollResult> {
	for (const t of targets) {
		r.targets.push(String(t.rollUrl));
		r.errors.push(...(await pushRollTarget(t, entries)).errors);
	}
	const clean = r.errors.length === 0;
	if (clean) {
		Object.assign(state.claims, cursor);
		writeSyncState(statePath, state);
		r.pushed = true;
	}
	r.ok = clean;
	return r;
}

/** One target push via the W1213 transport (postRoll — the credential-free
 *  machine-scoped TTL key POST with the W1213.2.1 ack validation). */
async function pushRollTarget(
	t: SyncTarget,
	entries: RollEntry[],
): Promise<{ errors: string[] }> {
	const o = await postRoll(t, entries);
	return o.ok
		? { errors: [] }
		: { errors: [`${o.target}: ${o.error ?? "roll rejected"}`] };
}
