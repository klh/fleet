// tests/helpers/review-rescore.fixture.ts — W1476 (b) runner fixture for
// tests/review-rescore.e2e.ts: an in-memory governor store carrying the two
// tables the review-model pin reads and the rescore bank writes, an arena
// child double speaking the RESCORE-STATUS / RESCORE stdout contract, a
// buckle-front double for the scoped-key mint + revoke, the dead-leg env the
// real arena CLI runs under, and the CLI spawn. Keys are fake
// (bksk_fixture_*); the front is a .invalid host only the double answers.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { emitStoredEvent } from "../../packages/suspenders/hooks/coord/event-publish.ts";
import {
	AC_GATE,
	type ArenaArm,
	type ArenaRow,
	type ArenaStatus,
	type ArenaSummary,
	type ChildResult,
	type Env,
	type Exec,
	ensureAc,
	type Launch,
	RESCORE_FACT,
	REVIEW_RESCORE_KIND,
} from "../../packages/suspenders/hooks/lib/fleet-loop/review-rescore.ts";
import {
	type GovernorStore,
	openMemoryStore,
	projectIdentity,
} from "../../packages/suspenders/hooks/lib/govdb/govdb.ts";
import { REPO_ROOT } from "./review-evals.fixture.ts";

export const PROJECT = projectIdentity(REPO_ROOT);
export const ADMIN = "bksk_fixture_admin";
export const LANE_KEY = "bksk_fixture_lane";
export const FRONT = "http://buckle.fixture.invalid";
export const RUNNER_BIN = join(
	REPO_ROOT,
	"packages/suspenders/hooks/bin/review-rescore.ts",
);
export const NO_PIN =
	"none (set SUSPENDERS_REVIEW_MODEL or land a review receipt)";
export const HEAD = "f".repeat(40);
export const SEAL = "0123456789abcdef";
/** the arena's skip reason for an arm whose leg port is dead */
export const DEAD_LEG =
	"leg port 1 not answering — re-point REVIEW_*_PORT or load the tier";
const LEG_PORT_KNOBS = [
	"REVIEW_ARM_A_PORT",
	"REVIEW_HUNTER_PORT",
	"REVIEW_REVIEWER_PORT",
	"REVIEW_VERIFIER_PORT",
	"REVIEW_FIXER_PORT",
	"REVIEW_TRIAGE_PORT",
];

// ---------------------------------------------------------------- store

/** The two tables the pin reads and the bank writes (govdb-open.ts DDL). */
export function memoryStore(): GovernorStore {
	const db = openMemoryStore();
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	return db;
}

/** `n` work.review receipts requesting `model` — the receipt rides the
 *  payload as JSON text, as review-receipt.ts banks it (`raw` replaces it). */
export function seedReview(
	db: GovernorStore,
	model: string | null,
	o: { project?: string; raw?: string; n?: number } = {},
): void {
	for (let i = 0; i < (o.n ?? 1); i++)
		emitStoredEvent(db, o.project ?? PROJECT, {
			kind: "work.review",
			source: "w1476-test",
			extra: { receipt: o.raw ?? JSON.stringify({ requested_model: model }) },
		});
}

export interface BankedEvent {
	id: number;
	scope: string | null;
	source: string;
	payload: Record<string, unknown>;
}

/** The banked review.rescore events, oldest first. */
export function rescoreEvents(db: GovernorStore): BankedEvent[] {
	const rows = db
		.query(
			"SELECT id, scope, source, payload FROM events WHERE kind = ? ORDER BY id",
		)
		.all(REVIEW_RESCORE_KIND) as Array<
		Omit<BankedEvent, "payload"> & { payload: string }
	>;
	return rows.map((r) => ({
		...r,
		payload: JSON.parse(r.payload) as Record<string, unknown>,
	}));
}

/** A banked event's rows (JSON text in the payload) as [arm, status]. */
export function rowStatuses(e: BankedEvent | undefined): string[][] {
	const rows = JSON.parse(String(e?.payload.rows ?? "[]")) as ArenaRow[];
	return rows.map((r) => [r.arm, r.status]);
}

export interface BankedFact {
	value: Record<string, unknown>;
	source: string;
	version: number;
}

/** The review.rescore.last fact (value parsed), or null. */
export function rescoreFact(db: GovernorStore): BankedFact | null {
	const row = db
		.query("SELECT value, source, version FROM facts WHERE key = ?")
		.get(RESCORE_FACT) as (Omit<BankedFact, "value"> & { value: string }) | null;
	return row
		? { ...row, value: JSON.parse(row.value) as Record<string, unknown> }
		: null;
}

// ---------------------------------------------------------------- arena double

export const arm = (name: string, due: boolean, why: string): ArenaArm => ({
	arm: name,
	due,
	why,
});

export const arenaStatus = (
	arms: ArenaArm[],
	unsealed: string[] = [],
): ArenaStatus => ({ head: HEAD, seal: SEAL, sealed: 3, unsealed, arms });

/** A ledgered row; `parts` is the fingerprint the bank strips. */
export const row = (name: string, status = "scored"): ArenaRow => ({
	arm: name,
	status,
	n: 3,
	parts: [`path:${name}.ts`],
});

export const arenaSummary = (
	rows: ArenaRow[],
	lines: string[] = rows.map((r) => `${r.arm}: ${r.status} n=3`),
): ArenaSummary => ({
	runId: "rescore-r1",
	head: HEAD,
	seal: SEAL,
	rows,
	skipped: {},
	lines,
});

/** One call-order log the arena and buckle doubles share. */
export const callLog = (): string[] => [];

export interface ExecCall {
	argv: string[];
	cwd: string;
	env: Env;
}

function arenaReply(
	argv: string[],
	status: ArenaStatus | null,
	summary: ArenaSummary | null,
): ChildResult {
	if (argv.includes("--rescore-status"))
		return status
			? {
					code: 0,
					out: `arena chatter\nRESCORE-STATUS ${JSON.stringify(status)}\n`,
					err: "",
				}
			: { code: 3, out: "", err: "seal hash mismatch: /x/tasks.json\n" };
	return summary
		? {
				code: 0,
				out: `a: scored n=3\nRESCORE ${JSON.stringify(summary)}\n`,
				err: "",
			}
		: { code: 3, out: "", err: "no sealed set at /x — run --design\n" };
}

/** The arena CLI as a double (a null status / summary = its exit-3
 *  refusal); `log` records the call order shared with buckleFront. */
export function arenaChild(
	status: ArenaStatus | null,
	summary: ArenaSummary | null = null,
	log: string[] = [],
): { exec: Exec; calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	const exec: Exec = (argv, o) => {
		calls.push({ argv, cwd: o.cwd, env: o.env });
		log.push(argv.includes("--rescore-status") ? "status" : "rescore");
		return Promise.resolve(arenaReply(argv, status, summary));
	};
	return { exec, calls };
}

// ---------------------------------------------------------------- buckle double

export interface FrontCall {
	url: string;
	method: string;
	auth: string | null;
	body: Record<string, unknown> | null;
}

/** The buckle admin API as a double: a 200 mint answers {key, key_id}. */
export function buckleFront(
	o: { mint?: number; revoke?: number } = {},
	log: string[] = [],
): { fetchFn: typeof fetch; calls: FrontCall[] } {
	const calls: FrontCall[] = [];
	const fetchFn = (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = String(input);
		const revoke = url.endsWith("/revoke");
		log.push(revoke ? "revoke" : "mint");
		calls.push({
			url,
			method: init?.method ?? "GET",
			auth: new Headers(init?.headers).get("authorization"),
			body:
				typeof init?.body === "string"
					? (JSON.parse(init.body) as Record<string, unknown>)
					: null,
		});
		const status = (revoke ? o.revoke : o.mint) ?? 200;
		if (revoke) return Promise.resolve(new Response("{}", { status }));
		return Promise.resolve(
			status === 200
				? Response.json({ key: LANE_KEY, key_id: "k1" })
				: Response.json({ error: "admin scope required" }, { status }),
		);
	};
	return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

// ---------------------------------------------------------------- processes

export interface LaunchCall {
	argv: string[];
	env: Env;
	cwd: string;
}

export function launcher(pid = 4242): { launch: Launch; calls: LaunchCall[] } {
	const calls: LaunchCall[] = [];
	return {
		launch: (argv, env, cwd) => {
			calls.push({ argv, env, cwd });
			return { pid };
		},
		calls,
	};
}

/** process.env minus every key under `prefixes`. */
function envWithout(...prefixes: string[]): Env {
	const env: Env = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !prefixes.some((p) => k.startsWith(p))) env[k] = v;
	return env;
}

/** The real arena CLI's env: no REVIEW_* knob and no review pin or rescore
 *  switch inherited (the lane arm idles unpinned, so no key is ever minted),
 *  every leg on dead port 1, the seal + results dirs on scratch. */
export function deadLegEnv(sealDir: string, resDir: string): Env {
	const env = envWithout("REVIEW_", "SUSPENDERS_REVIEW_");
	for (const knob of LEG_PORT_KNOBS) env[knob] = "1";
	env.REVIEW_SEAL_DIR = sealDir;
	env.REVIEW_RESULTS_DIR = resDir;
	return env;
}

/** AC confirmed the way the heartbeat confirms it (pmset, then the arena
 *  gate file); `undo` removes a gate file this call created, leaving the
 *  machine as found. */
export function confirmAc(): { ok: boolean; undo: () => void } {
	const had = existsSync(AC_GATE);
	const ok = ensureAc();
	return {
		ok,
		undo: () => {
			if (!had) rmSync(AC_GATE, { force: true });
		},
	};
}

/** The review-rescore CLI, spawned without the operator's review knobs. */
export function runnerBin(args: string[], env: Env = {}): ChildResult {
	const p = Bun.spawnSync([process.execPath, RUNNER_BIN, ...args], {
		cwd: REPO_ROOT,
		env: { ...envWithout("SUSPENDERS_REVIEW_"), ...env },
		stdin: "ignore",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
