// review-rescore.ts — W1476 (b): reviewer prompt, model or tooling changes
// are rescored against the whole review-arena set (docs/paas-engineering-
// standard-2026-10-23.md:851). The belt arena owns the fingerprints, the
// sealed set and the score ledger (packages/belt/bench/arena/review-
// rescore.ts + review-surface.json); this side owns what only the control
// plane knows: the review model pin, the scoped buckle key the lane arm
// rides, the AC gate, and the `review.rescore` event + `review.rescore.last`
// fact a finished run banks (the seam W1477's review metrics read). The
// arena CLI is spawned by path — suspenders never imports belt (W1249).
//
// Pin: SUSPENDERS_REVIEW_MODEL (the review scheduler's override), else the
// model the newest work.review receipts requested most (tie → newest), else
// none — the lane arm then idles (REVIEW_LANE_MODEL unset).
//
// check — the hourly fleet-loop heartbeat: asks the arena which arms are due
// (git + ledger reads, no LLM call); when one is and pmset says AC, launches
// `run` detached (a rescore outlives the maintenance timeout).
// SUSPENDERS_REVIEW_RESCORE=0 idles it; an explicit `run` still runs.
// run — mints a scoped key when the lane arm is due (always revoked after),
// reruns the due arms over the whole sealed set, banks the ledgered deltas.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitStoredEvent } from "../../coord/event-publish.ts";
import { launchDetachedReview } from "../gates/review-scheduler.ts";
import {
	type GovernorStore,
	openStore,
	projectIdentity,
} from "../govdb/govdb.ts";
import {
	adminKey,
	BUCKLE_FRONT,
	mintLaneKey,
	revokeLaneKey,
} from "../lanes/lane-auth.ts";

export const REVIEW_RESCORE_KIND = "review.rescore";
export const RESCORE_FACT = "review.rescore.last";
export const ARENA_CLI = "packages/belt/bench/arena/review-run.ts";
/** the arena's AC gate file (belt bench/arena/core.ts AC_FILE) */
export const AC_GATE = "/tmp/bench-ac-ok";
const PIN_WINDOW = 25;
const SOURCE = "review-rescore";
const BIN = join(import.meta.dir, "../../bin/review-rescore.ts");

export type Env = NodeJS.ProcessEnv;

export interface ChildResult {
	code: number;
	out: string;
	err: string;
}

export type Exec = (
	argv: string[],
	o: { cwd: string; env: Env },
) => Promise<ChildResult>;

export type Launch = (
	argv: string[],
	env: Env,
	cwd: string,
) => { pid: number };

/** Run a child to completion; the arena prints a bounded summary. */
export const execChild: Exec = async (argv, o) => {
	const p = Bun.spawn(argv, {
		cwd: o.cwd,
		env: o.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, out, err };
};

const tail = (text: string): string =>
	text.trim().slice(-400) || "(no stderr)";
const stamp = (): string =>
	new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function withStore<T>(
	db: GovernorStore | undefined,
	fn: (store: GovernorStore) => T,
): T {
	const store = db ?? openStore();
	try {
		return fn(store);
	} finally {
		if (!db) store.close();
	}
}

// ---------------------------------------------------------------- pin

export interface ReviewPin {
	model: string | null;
	source: "env" | "receipts" | "none";
}

/** The review model the lane arm is scored under. */
export function reviewModelPin(
	db: GovernorStore,
	project: string,
	env: Env = process.env,
): ReviewPin {
	if (env.SUSPENDERS_REVIEW_MODEL)
		return { model: env.SUSPENDERS_REVIEW_MODEL, source: "env" };
	const rows = db
		.query(
			"SELECT CASE WHEN json_valid(json_extract(payload, '$.receipt')) THEN json_extract(json_extract(payload, '$.receipt'), '$.requested_model') END AS model FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.project') = ? ORDER BY id DESC LIMIT ?",
		)
		.all(project, PIN_WINDOW) as Array<{ model: unknown }>;
	// insertion order is newest first, so the strict > keeps the newest on a tie
	const counts = new Map<string, number>();
	for (const r of rows)
		if (typeof r.model === "string" && r.model)
			counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
	let model: string | null = null;
	let best = 0;
	for (const [m, n] of counts)
		if (n > best) {
			model = m;
			best = n;
		}
	return model
		? { model, source: "receipts" }
		: { model: null, source: "none" };
}

// ---------------------------------------------------------------- AC gate

const pmsetPs = (): string => {
	try {
		return Bun.spawnSync(["pmset", "-g", "ps"]).stdout.toString();
	} catch {
		return ""; // no pmset (a Linux hub): AC is never confirmed
	}
};

/** pmset must say AC Power (the gate file alone outlives an unplug); writes
 *  the arena's gate file when absent, as belt's fleet-refresh does. */
export function ensureAc(
	power: () => string = pmsetPs,
	gate: string = AC_GATE,
): boolean {
	if (!/AC Power/i.test(power())) return false;
	if (!existsSync(gate)) writeFileSync(gate, "ac\n");
	return true;
}

// ---------------------------------------------------------------- arena face

/** The slice of the arena's RESCORE-STATUS / RESCORE lines this side reads. */
export interface ArenaArm {
	arm: string;
	due: boolean;
	why: string;
}

export interface ArenaStatus {
	head: string;
	seal: string | null;
	sealed: number;
	unsealed: string[];
	arms: ArenaArm[];
}

export interface ArenaRow {
	arm: string;
	status: string;
	[field: string]: unknown;
}

export interface ArenaSummary {
	runId: string;
	head: string | null;
	seal: string;
	rows: ArenaRow[];
	skipped: Record<string, string>;
	lines: string[];
}

/** The JSON a `<TAG> {...}` stdout line carries (the last one wins). */
function taggedJson<T>(out: string, tag: string): T | null {
	const line = out.split("\n").findLast((l) => l.startsWith(`${tag} `));
	if (!line) return null;
	try {
		return JSON.parse(line.slice(tag.length + 1)) as T;
	} catch {
		return null;
	}
}

/** The arena child's env: REVIEW_LANE_MODEL is the resolved pin and the lane
 *  leg (URL + key) is set only by a run that minted one — inherited
 *  REVIEW_LANE_* values never leak into the fingerprint or the leg. */
function arenaEnv(
	env: Env,
	pin: string | null,
	leg: Record<string, string> = {},
): Env {
	const out: Env = {};
	for (const [k, v] of Object.entries(env))
		if (v !== undefined && !k.startsWith("REVIEW_LANE_")) out[k] = v;
	if (pin) out.REVIEW_LANE_MODEL = pin;
	return { ...out, ...leg };
}

const arenaArgv = (repo: string, args: string[]): string[] => [
	process.execPath,
	join(repo, ARENA_CLI),
	...args,
];

/** Which arms are due, and why — the arena's own read (no LLM call). */
async function arenaStatus(o: {
	repo: string;
	env: Env;
	exec: Exec;
	force?: boolean;
}): Promise<ArenaStatus> {
	const r = await o.exec(
		arenaArgv(o.repo, ["--rescore-status", ...(o.force ? ["--force"] : [])]),
		{ cwd: o.repo, env: o.env },
	);
	const st =
		r.code === 0 ? taggedJson<ArenaStatus>(r.out, "RESCORE-STATUS") : null;
	if (!st)
		throw new Error(`arena --rescore-status exit ${r.code}: ${tail(r.err)}`);
	return st;
}

const pinText = (pin: ReviewPin): string =>
	pin.model
		? `${pin.model} (${pin.source})`
		: "none (set SUSPENDERS_REVIEW_MODEL or land a review receipt)";

/** Arms grouped by why: `a, b: unchanged; lane: debounced until …`. */
function armsText(arms: ArenaArm[]): string {
	const byWhy = new Map<string, string[]>();
	for (const a of arms) byWhy.set(a.why, [...(byWhy.get(a.why) ?? []), a.arm]);
	return [...byWhy]
		.map(([why, names]) => `${names.join(", ")}: ${why}`)
		.join("; ");
}

function statusInfo(st: ArenaStatus, pin: ReviewPin): string {
	const unsealed = st.unsealed.length
		? ` · unsealed incident cases: ${st.unsealed.join(", ")} (re-design the seal)`
		: "";
	return `pin ${pinText(pin)}${unsealed}`;
}

// ---------------------------------------------------------------- bank

/** Bank one finished rescore: the `review.rescore` event (rows without their
 *  fingerprint parts) and the `review.rescore.last` fact, in one
 *  transaction. Returns the event id. */
export function bankRescore(
	db: GovernorStore,
	project: string,
	o: { sum: ArenaSummary; pin: ReviewPin; reason: string },
): number {
	const rows = o.sum.rows.map((row) => ({ ...row, parts: undefined }));
	return db.transaction(() => {
		const event = emitStoredEvent(db, project, {
			kind: REVIEW_RESCORE_KIND,
			scope: o.sum.runId,
			source: SOURCE,
			note: o.sum.lines.join(" · "),
			extra: {
				runId: o.sum.runId,
				head: o.sum.head ?? "",
				seal: o.sum.seal,
				reason: o.reason,
				model: o.pin.model ?? "",
				pinSource: o.pin.source,
				rows: JSON.stringify(rows),
			},
		});
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
		).run(
			RESCORE_FACT,
			JSON.stringify({
				event,
				project,
				runId: o.sum.runId,
				head: o.sum.head,
				seal: o.sum.seal,
				reason: o.reason,
				model: o.pin.model,
				lines: o.sum.lines,
			}),
			SOURCE,
			Date.now(),
		);
		return event;
	})();
}

// ---------------------------------------------------------------- check

export interface RescoreOptions {
	/** the fleet checkout the arena lives in */
	repo: string;
	env?: Env;
	/** the governor store (default openStore(), closed after) */
	db?: GovernorStore;
	exec?: Exec;
	/** AC power confirmed (default ensureAc) */
	ac?: () => boolean;
	/** the buckle admin credential (default BUCKLE_ADMIN_KEY, else belt.env) */
	admin?: () => string | null;
}

/** The heartbeat, as one line: disabled, idle (with why), held or launched. */
export async function rescoreCheck(
	o: RescoreOptions & { launch?: Launch },
): Promise<string> {
	const env = o.env ?? process.env;
	if (env.SUSPENDERS_REVIEW_RESCORE === "0")
		return "review-rescore: disabled (SUSPENDERS_REVIEW_RESCORE=0)";
	if (!existsSync(join(o.repo, ARENA_CLI)))
		return `review-rescore: idle — no review arena under ${o.repo}`;
	const pin = withStore(o.db, (db) =>
		reviewModelPin(db, projectIdentity(o.repo), env),
	);
	const st = await arenaStatus({
		repo: o.repo,
		env: arenaEnv(env, pin.model),
		exec: o.exec ?? execChild,
	});
	const info = statusInfo(st, pin);
	const due = st.arms.filter((a) => a.due);
	if (!due.length) return `review-rescore: idle — ${armsText(st.arms)} · ${info}`;
	const acOk = o.ac ?? (() => ensureAc());
	if (!acOk())
		return `review-rescore: held — no AC power confirmed (pmset); due ${armsText(due)} · ${info}`;
	const admin = o.admin ?? (() => adminKey(env));
	if (due.every((a) => a.arm === "lane") && !admin())
		return `review-rescore: held — lane due but no buckle admin credential (BUCKLE_ADMIN_KEY / belt.env) · ${info}`;
	const child = (o.launch ?? launchDetachedReview)(
		[process.execPath, BIN, "run", "--repo", o.repo, "--reason", "heartbeat"],
		env,
		o.repo,
	);
	return `review-rescore: launched pid ${child.pid} — due ${armsText(due)} · ${info}`;
}

// ---------------------------------------------------------------- run

export interface RunOptions extends RescoreOptions {
	reason?: string;
	force?: boolean;
	fetchFn?: typeof fetch;
	/** the buckle front the key is minted on and the lane arm rides */
	front?: string;
}

export interface RunResult {
	lines: string[];
	/** every arm this run executed scored (a lost lock race executes none —
	 *  the lock holder banks), a due lane got its key, a minted key was revoked */
	ok: boolean;
}

interface LaneKey {
	env: Record<string, string>;
	revoke: () => Promise<boolean>;
}

/** A scoped buckle key for the lane arm, or why none can be had. */
async function laneKey(o: RunOptions, env: Env): Promise<LaneKey | string> {
	const admin = (o.admin ?? (() => adminKey(env)))();
	if (!admin) return "no buckle admin credential (BUCKLE_ADMIN_KEY / belt.env)";
	const front = o.front ?? BUCKLE_FRONT;
	const fetchFn = o.fetchFn ?? fetch;
	const sid = `${SOURCE}-${stamp()}`;
	const key = await mintLaneKey(sid, admin, fetchFn, front);
	if (!key) return "scoped key mint refused";
	return {
		env: {
			REVIEW_LANE_URL: `${front}/w/${sid}/v1/chat/completions`,
			REVIEW_LANE_KEY: key.key,
		},
		revoke: () => revokeLaneKey(key.keyId, admin, fetchFn, front),
	};
}

/** Rescore now: every due arm over the whole sealed set (AC-gated). */
export async function rescoreRun(o: RunOptions): Promise<RunResult> {
	const env = o.env ?? process.env;
	const exec = o.exec ?? execChild;
	if (!(o.ac ?? (() => ensureAc()))())
		throw new Error(
			"no AC power confirmed (pmset) — the arena benches on AC only",
		);
	const reason = o.reason ?? "manual";
	const project = projectIdentity(o.repo);
	const pin = withStore(o.db, (db) => reviewModelPin(db, project, env));
	const st = await arenaStatus({
		repo: o.repo,
		env: arenaEnv(env, pin.model),
		exec,
		force: o.force,
	});
	const info = statusInfo(st, pin);
	const due = st.arms.filter((a) => a.due);
	if (!due.length)
		return {
			lines: [`review-rescore: nothing due — ${armsText(st.arms)} · ${info}`],
			ok: true,
		};
	const lines = [`review-rescore: ${reason} — due ${armsText(due)} · ${info}`];
	const key = due.some((a) => a.arm === "lane") ? await laneKey(o, env) : null;
	const leg = typeof key === "string" ? null : key;
	if (typeof key === "string") {
		lines.push(`lane: not run — ${key}`);
		if (due.every((a) => a.arm === "lane")) return { lines, ok: false };
	}
	let revoked = true;
	let r: ChildResult;
	try {
		r = await exec(
			arenaArgv(o.repo, [
				"--rescore",
				"--arm",
				leg ? "all" : "both",
				"--reason",
				reason,
				...(o.force ? ["--force"] : []),
			]),
			{ cwd: o.repo, env: arenaEnv(env, pin.model, leg?.env) },
		);
	} finally {
		if (leg) revoked = await leg.revoke();
	}
	const sum = r.code === 0 ? taggedJson<ArenaSummary>(r.out, "RESCORE") : null;
	if (sum) {
		lines.push(...sum.lines);
		if (sum.rows.length) {
			const event = withStore(o.db, (db) =>
				bankRescore(db, project, { sum, pin, reason }),
			);
			lines.push(`banked ${REVIEW_RESCORE_KIND} #${event} · fact ${RESCORE_FACT}`);
		}
	} else lines.push(`arena --rescore exit ${r.code}: ${tail(r.err)}`);
	if (!revoked)
		lines.push("lane: scoped key revocation failed — its 24h TTL bounds it");
	const scored = sum?.rows.every((row) => row.status === "scored") === true;
	return { lines, ok: scored && revoked && typeof key !== "string" };
}
