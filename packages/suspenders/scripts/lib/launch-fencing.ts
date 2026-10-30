import {
	readFileSync,
	realpathSync,
	mkdirSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { z } from "zod";
import { openStore, type GovernorStore } from "../../hooks/lib/govdb/govdb.ts";
import { sameMachine } from "../../hooks/lib/host-identity.ts";
import { compareProcessBirth, darwinProcessBirth } from "./process-birth.ts";

export type LaunchIntent = {
	project: string;
	item: string;
	sid: string;
	nonce: string;
	revision: number;
	executor: string;
	host: string;
	attempt: number;
	state: string;
	pid: number | null;
	birth: string | null;
};
export type ProcessBirth = { birth: string; command: string };
const TABLE = "lane_launch_intents";

// — W2317 (Kueue pattern 5): the ONE launch-refusal vocabulary ———————————
// Every pre-launch gate folds its failure into Transient (backoff + requeue)
// or Permanent (FAILED + NEED_DECISION) through classifyLaunchRefusal; the
// bounded unknown-liveness re-probe carries a RequeueSpec. No second enum,
// no second requeue shape (program contract, lesson.kueue-program-contract).

/** Kueue AdmissionCheck failure semantics: Retry ↔ Transient (release the
 *  reservation and backoff), Rejected ↔ Permanent (deactivate + surface). */
export const LaunchRefusalSchema = z.enum(["Transient", "Permanent"]);
export type LaunchRefusal = z.infer<typeof LaunchRefusalSchema>;

/** A permanent refusal is never retried by machinery: the item lands FAILED
 *  (work retry stays the operator's call) with a NEED_DECISION surfaced. */
export type LaunchRefusalVerdict = {
	disposition: LaunchRefusal;
	reason: string;
};

/** Kueue requeueState {count, requeueAt} as fleet's one re-probe shape:
 *  requeueAt epoch ms (0 = immediate); attempts/maxAttempts bound the
 *  probe so unknown liveness is an INPUT, never a slot-holding state. */
export const RequeueSpecSchema = z.object({
	disposition: LaunchRefusalSchema,
	requeueAt: z.number().int(),
	attempts: z.number().int().min(0),
	maxAttempts: z.number().int().min(1),
});
export type RequeueSpec = z.infer<typeof RequeueSpecSchema>;

/** Exit 125 = the launch fence's own refusal (registration/lease/claim) —
 *  contention with a live dispatcher, not a property of this workload. */
const REGISTRATION_EXIT = 125;
/** Configuration-class codes from classifyLaunchFailure: retrying cannot
 *  fix a bad flag, key or cert — Kueue's Rejected, not Retry. */
const PERMANENT_CODES = new Set(["invalid-launch-or-auth"]);
const PERMANENT_STDERR =
	/unknown option|unrecognized arguments?|unsupported\s*params?|invalid api key|\b401\b|\b403\b|cert(?:ificate)? (?:expired|invalid)|ERR_TLS_CERT/i;

/** Pure Transient/Permanent classifier over a launch-refusal input: code =
 *  the launch-backoff fact code (429, invalid-launch-or-auth,
 *  upstream-unavailable, transport-unavailable, launch-exited,
 *  quota-exhausted …); stderr/exitCode optional side-evidence. No store,
 *  no clock — both dispatch seams and tests share it. Unknown codes are
 *  Transient (the honest default: an unproven failure never deactivates). */
export function classifyLaunchRefusal(input: {
	code: string;
	stderr?: string;
	exitCode?: number | null;
}): LaunchRefusalVerdict {
	const code = input.code.trim();
	if (PERMANENT_CODES.has(code))
		return {
			disposition: "Permanent",
			reason: `${code}: launch configuration/auth is wrong; retrying cannot fix it`,
		};
	if (input.exitCode === REGISTRATION_EXIT)
		return {
			disposition: "Transient",
			reason: "exit 125: launch fence refused (registration/lease/claim contention)",
		};
	if (input.stderr && PERMANENT_STDERR.test(input.stderr))
		return {
			disposition: "Permanent",
			reason: `stderr matches configuration/auth refusal: ${code}`,
		};
	return {
		disposition: "Transient",
		reason: `${code}: transient launch failure — backoff and requeue`,
	};
}
export function readConfiguredLaunches<T>(
	read: (store: GovernorStore) => T,
): T {
	const store = openStore();
	try {
		return read(store);
	} finally {
		store.close();
	}
}
export function assertLaunchClaim(
	store: GovernorStore,
	intent: LaunchIntent,
	allowStarted = false,
): void {
	const claim = allowStarted
		? store
				.query(
					`SELECT 1 FROM work_items w JOIN ${TABLE} i ON i.project=w.project AND i.item=w.id WHERE w.project=? AND w.id=? AND w.owner_sid=? AND w.state IN ('CLAIMED','RUNNING') AND i.nonce=? AND i.sid=? AND i.state='REGISTERED'`,
				)
				.get(intent.project, intent.item, intent.sid, intent.nonce, intent.sid)
		: store
				.query(
					"SELECT 1 FROM work_items WHERE project=? AND id=? AND owner_sid=? AND updated_at=? AND state IN ('CLAIMED','RUNNING')",
				)
				.get(intent.project, intent.item, intent.sid, intent.revision);
	if (
		!store
			.query(
				"SELECT 1 FROM lane_launch_leases WHERE project=? AND sid=? AND nonce=? AND expires_at>?",
			)
			.get(intent.project, intent.sid, intent.nonce, Date.now()) ||
		!claim
	)
		throw new Error("launch ownership changed");
}
/** Durable intent precedes fork; an unregistered intent is uncertainty, never
 * proof of death. The item budget survives claim transfers and SID changes. */
export function launchSchema(store: GovernorStore): void {
	const tables = store
		.query(
			"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('lane_launch_intents','lane_launch_budgets')",
		)
		.get() as { n: number };
	if (tables.n === 2) return;
	store.run(
		`CREATE TABLE IF NOT EXISTS ${TABLE}(project TEXT NOT NULL,item TEXT NOT NULL,sid TEXT NOT NULL,nonce TEXT NOT NULL,revision INTEGER NOT NULL,executor TEXT NOT NULL,host TEXT NOT NULL,attempt INTEGER NOT NULL,state TEXT NOT NULL,pid INTEGER,birth TEXT,PRIMARY KEY(project,item))`,
	);
	store.run(
		"CREATE TABLE IF NOT EXISTS lane_launch_budgets(project TEXT NOT NULL,item TEXT NOT NULL,reservations INTEGER NOT NULL,PRIMARY KEY(project,item))",
	);
}
export function launchIntent(
	store: GovernorStore,
	project: string,
	item: string,
): LaunchIntent | null {
	launchSchema(store);
	return store
		.query(`SELECT * FROM ${TABLE} WHERE project=? AND item=?`)
		.get(project, item) as LaunchIntent | null;
}
export function nextReservedAttempt(
	store: GovernorStore,
	project: string,
	item: string,
	fallback = 0,
	sid?: string,
): number {
	launchSchema(store);
	const row = store
		.query(
			"SELECT reservations FROM lane_launch_budgets WHERE project=? AND item=?",
		)
		.get(project, item) as { reservations: number } | null;
	const legacy = sid
		? (store
				.query("SELECT value FROM facts WHERE key=?")
				.get(`lane.${sid}.launch-attempt`) as { value: string } | null)
		: null;
	return Math.max(
		fallback,
		row?.reservations ?? 0,
		legacy && /^\d+$/.test(legacy.value) ? Number(legacy.value) + 1 : 0,
	);
}
export function heldLaunchItems(
	store: GovernorStore,
	project: string,
): Set<string> {
	return heldLaunchReport(store, project).held;
}

// — W2317: the bounded unknown-liveness re-probe ————————————————
// An unknown inspect verdict is an INPUT to a bounded probe cycle, never a
// slot-holding state (the W417.4 disease: recycled pids + incomparable
// births held capacity forever). Each heldLaunchReport call IS one probe:
// attempts advance, requeueAt spaces them, exhaustion surfaces the intent
// (operator door: dispatch intent fail) instead of wedging the slot.

/** One probe spaced 30s → 2m → 5m; exhaustion after DEFAULT_REPROBE_MAX. */
const REPROBE_STEPS_MS = [30_000, 120_000, 300_000];
export const DEFAULT_REPROBE_MAX_ATTEMPTS = 3;
const REPROBE_PREFIX = "dispatch.intent-reprobe.";
const reprobeKey = (project: string, item: string): string =>
	`${REPROBE_PREFIX}${Bun.hash(project).toString(16)}.${item}`;

export type SurfacedIntent = {
	item: string;
	sid: string;
	pid: number | null;
	attempts: number;
	maxAttempts: number;
	/** true only on the cycle the bound was first hit — the once-per-episode
	 *  emit signal (the fact itself is the grinder-style flag). */
	justExhausted: boolean;
};
export type HeldLaunchReport = {
	held: Set<string>;
	surfaced: SurfacedIntent[];
};

function readReprobeSpec(
	store: GovernorStore,
	project: string,
	item: string,
): RequeueSpec | null {
	try {
		const row = store
			.query("SELECT value FROM facts WHERE key=?")
			.get(reprobeKey(project, item)) as { value: string } | null;
		if (!row) return null;
		// Schema law: an unparsable/foreign row is drift — fail open to a
		// fresh episode, never wedge capacity on a bad fact.
		const parsed = RequeueSpecSchema.safeParse(JSON.parse(row.value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function writeReprobeSpec(
	store: GovernorStore,
	project: string,
	item: string,
	spec: RequeueSpec,
): void {
	try {
		store
			.query(
				"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,version=version+1,ts=excluded.ts",
			)
			.run(
				reprobeKey(project, item),
				JSON.stringify(spec),
				"dispatch",
				Date.now(),
			);
	} catch {
		// a dark facts table never wedges dispatch (fail-open doctrine)
	}
}

/** Retire a re-probe episode: a fresh reservation or a FAILED transition
 *  ends it — a later unknown episode for the same item starts at attempt 1. */
function clearReprobeEpisode(
	store: GovernorStore,
	project: string,
	item: string,
): void {
	try {
		store
			.query("DELETE FROM facts WHERE key=?")
			.run(reprobeKey(project, item));
	} catch {
		// fail-open
	}
}

/** Advance one intent's re-probe bound. Verdict unknown: schedule the next
 *  probe or mark exhaustion; verdict proved: retire the episode fact. */
function reprobeStep(
	store: GovernorStore,
	intent: LaunchIntent,
	verdict: "alive" | "dead" | "unknown",
	now: number,
): "held" | "exhausted" | "cleared" {
	if (verdict !== "unknown") {
		// a proved verdict resolves the episode: the fact resets so a later
		// unknown episode starts fresh at attempt 1
		if (readReprobeSpec(store, intent.project, intent.item))
			writeReprobeSpec(store, intent.project, intent.item, {
				disposition: "Transient",
				requeueAt: 0,
				attempts: 0,
				maxAttempts: DEFAULT_REPROBE_MAX_ATTEMPTS,
			});
		return "cleared";
	}
	const prior = readReprobeSpec(store, intent.project, intent.item);
	const maxAttempts = prior?.maxAttempts ?? DEFAULT_REPROBE_MAX_ATTEMPTS;
	if (prior && prior.attempts >= maxAttempts) return "still-exhausted";
	if (prior && now < prior.requeueAt) return "held";
	const attempts = (prior?.attempts ?? 0) + 1;
	writeReprobeSpec(store, intent.project, intent.item, {
		disposition: "Transient",
		requeueAt:
			now +
			REPROBE_STEPS_MS[Math.min(attempts - 1, REPROBE_STEPS_MS.length - 1)],
		attempts: Math.min(attempts, maxAttempts),
		maxAttempts,
	});
	return attempts >= maxAttempts ? "exhausted" : "held";
}

/** The dispatch-cycle read: which items hold launch capacity, and which
 *  unknown-liveness intents exhausted their re-probe bound (surfaced —
 *  capacity released, one NEED_DECISION per episode rides the caller).
 *  This call IS the probe cadence: one dispatch cycle = one attempt. */
export function heldLaunchReport(
	store: GovernorStore,
	project: string,
	now = Date.now(),
	inspect: (
		intent: LaunchIntent,
	) => "alive" | "dead" | "unknown" = inspectLaunchIntent,
): HeldLaunchReport {
	launchSchema(store);
	const rows = store
		.query(`SELECT * FROM ${TABLE} WHERE project=? AND state!='FAILED'`)
		.all(project) as LaunchIntent[];
	const held = new Set<string>();
	const surfaced: SurfacedIntent[] = [];
	for (const row of rows) {
		const verdict = inspect(row);
		if (verdict === "dead") continue;
		const step = reprobeStep(store, row, verdict, now);
		if (step === "exhausted" || step === "still-exhausted") {
			const prior = readReprobeSpec(store, row.project, row.item);
			surfaced.push({
				item: row.item,
				sid: row.sid,
				pid: row.pid,
				attempts: prior?.attempts ?? DEFAULT_REPROBE_MAX_ATTEMPTS,
				maxAttempts: prior?.maxAttempts ?? DEFAULT_REPROBE_MAX_ATTEMPTS,
				justExhausted: step === "exhausted",
			});
		} else held.add(row.item);
	}
	return { held, surfaced };
}
function command(args: string[]): string | null {
	const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}
function darwinBirth(pid: number): string | null {
	// PROC_PIDTBSDINFO exposes microsecond start time; ps lstart has only
	// second resolution and cannot safely distinguish fast PID reuse.
	const library = dlopen("/usr/lib/libproc.dylib", {
		proc_pidinfo: {
			args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
			returns: FFIType.i32,
		},
	});
	try {
		const bytes = new Uint8Array(136);
		if (
			library.symbols.proc_pidinfo(pid, 3, 0, ptr(bytes), bytes.length) !==
			bytes.length
		)
			return null;
		const view = new DataView(bytes.buffer);
		return `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`;
	} finally {
		library.close();
	}
}
/** Birth identity is independent of prompt text and PID reuse. Unsupported or
 * unreadable inspection is unknown. Only an absent process is proven dead. */
export function processBirth(pid: number): ProcessBirth | false | null {
	if (!Number.isSafeInteger(pid) || pid < 1) return null;
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (fields[0] === "Z") return false;
			const boot = readFileSync(
				"/proc/sys/kernel/random/boot_id",
				"utf8",
			).trim();
			const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8");
			const again = readFileSync(`/proc/${pid}/stat`, "utf8");
			if (
				!/^\d+$/.test(fields[19] ?? "") ||
				again.slice(again.lastIndexOf(")") + 2).split(" ")[19] !== fields[19]
			)
				return null;
			return {
				birth: `${boot}:${fields[19]}`,
				command: argv.replaceAll("\0", " ").trim(),
			};
		}
		if (process.platform !== "darwin") return null;
		const birth = darwinBirth(pid);
		if (!birth) {
			try {
				process.kill(pid, 0);
				return null;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
			}
		}
		const state = command(["/bin/ps", "-p", String(pid), "-o", "stat="]);
		if (state?.startsWith("Z")) return false;
		const boot = command(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"]);
		const argv = command(["/bin/ps", "-p", String(pid), "-o", "command="]);
		const again = darwinBirth(pid);
		const stable = darwinProcessBirth(boot, birth);
		return stable && argv && again === birth
			? { birth: stable, command: argv }
			: null;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
	}
}
/** Same-machine verdict under the macOS .local/.localdomain flip — the
 * normalizer lives in hooks/lib/host-identity.ts (W1232: lane-liveness
 * shares it); re-exported here so controller-fence keeps its import face. */
export { sameMachine } from "../../hooks/lib/host-identity.ts";
export function inspectLaunchIntent(
	intent: LaunchIntent,
	inspect = processBirth,
): "alive" | "dead" | "unknown" {
	if (intent.state === "FAILED") return "dead";
	if (!sameMachine(intent.host, hostname()) || !intent.pid || !intent.birth)
		return "unknown";
	const current = inspect(intent.pid);
	if (current === false) return "dead";
	if (!current) return "unknown";
	const comparison = compareProcessBirth(intent.birth, current.birth);
	if (comparison === "unknown") return "unknown";
	if (comparison === "different") return "dead";
	// Executable must occupy argv[0], or the entrypoint following an interpreter.
	// A matching word anywhere in an untrusted prompt cannot establish identity.
	const exe = intent.executor;
	const cmd = current.command;
	const direct = cmd === exe || cmd.startsWith(`${exe} `);
	const interpreted = /^(?:\/[^ ]*\/)?(?:bun|node|sh|bash|zsh) /.exec(cmd);
	const script =
		interpreted &&
		(cmd.slice(interpreted[0].length) === exe ||
			cmd.slice(interpreted[0].length).startsWith(`${exe} `));
	return direct || script ? "alive" : "unknown";
}
export function reserveLaunchIntent(
	store: GovernorStore,
	input: Omit<LaunchIntent, "attempt" | "state" | "pid" | "birth" | "host">,
	limit: number,
	priorAttempt = -1,
): LaunchIntent {
	launchSchema(store);
	return store.transaction(() => {
		const previous = launchIntent(store, input.project, input.item);
		if (previous && inspectLaunchIntent(previous) !== "dead")
			throw new Error(
				"launch intent is alive or uncertain; inspect before retrying",
			);
		if (
			!store
				.query(
					"SELECT 1 FROM lane_launch_leases WHERE project=? AND sid=? AND nonce=? AND expires_at>?",
				)
				.get(input.project, input.sid, input.nonce, Date.now())
		)
			throw new Error("launch lease changed before reservation");
		if (
			!store
				.query(
					"SELECT 1 FROM work_items WHERE project=? AND id=? AND owner_sid=? AND updated_at=? AND state IN ('CLAIMED','RUNNING')",
				)
				.get(input.project, input.item, input.sid, input.revision)
		)
			throw new Error("claim changed before reservation");
		const count = store
			.query(
				"SELECT reservations FROM lane_launch_budgets WHERE project=? AND item=?",
			)
			.get(input.project, input.item) as { reservations: number } | null;
		const attempt = Math.max(count?.reservations ?? 0, priorAttempt + 1);
		if (attempt >= limit)
			throw new Error(
				`item launch budget exhausted (${limit}); operator review required`,
			);
		store
			.query(
				"INSERT INTO lane_launch_budgets VALUES (?,?,?) ON CONFLICT(project,item) DO UPDATE SET reservations=excluded.reservations",
			)
			.run(input.project, input.item, attempt + 1);
		// W2317: a fresh reservation is a fresh episode — prior unknown-liveness
		// probe state never carries into the new attempt's bound.
		clearReprobeEpisode(store, input.project, input.item);
		const intent: LaunchIntent = {
			...input,
			executor: realpathSync(input.executor),
			host: hostname(),
			attempt,
			state: "PREPARING",
			pid: null,
			birth: null,
		};
		store
			.query(
				`INSERT INTO ${TABLE} VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project,item) DO UPDATE SET sid=excluded.sid,nonce=excluded.nonce,revision=excluded.revision,executor=excluded.executor,host=excluded.host,attempt=excluded.attempt,state=excluded.state,pid=NULL,birth=NULL`,
			)
			.run(
				intent.project,
				intent.item,
				intent.sid,
				intent.nonce,
				intent.revision,
				intent.executor,
				intent.host,
				intent.attempt,
				intent.state,
				null,
				null,
			);
		return intent;
	})();
}
/** Child registers its exec-preserved shell PID before the harness can run.
 * Remote failures propagate; no local database fallback is permitted. */
export function registerLaunch(
	store: GovernorStore,
	intent: LaunchIntent,
	pid: number,
): void {
	const identity = processBirth(pid);
	if (!identity) throw new Error("process birth unavailable; executor refused");
	store.transaction(() => {
		if (
			!store
				.query(
					"SELECT 1 FROM lane_launch_leases WHERE project=? AND sid=? AND nonce=? AND expires_at>?",
				)
				.get(intent.project, intent.sid, intent.nonce, Date.now())
		)
			throw new Error("launch lease replaced; executor refused");
		// Identity = owner + live state, NOT updated_at: the revision was
		// snapshotted at reservation and any heartbeat/audit touch in the
		// seconds-to-register window fails this check — the executor then
		// exits 125 before claude runs (2026-10-15 mass lane death, W761).
		if (
			!store
				.query(
					"SELECT 1 FROM work_items WHERE project=? AND id=? AND owner_sid=? AND state IN ('CLAIMED','RUNNING')",
				)
				.get(intent.project, intent.item, intent.sid)
		)
			throw new Error("claim replaced; executor refused");
		const changed = store
			.query(
				`UPDATE ${TABLE} SET state='REGISTERED',pid=?,birth=? WHERE project=? AND item=? AND nonce=? AND sid=? AND revision=? AND executor=? AND host=? AND state='PREPARING'`,
			)
			.run(
				pid,
				identity.birth,
				intent.project,
				intent.item,
				intent.nonce,
				intent.sid,
				intent.revision,
				intent.executor,
				hostname(),
			);
		if (!changed.changes)
			throw new Error("launch intent replaced; executor refused");
	})();
}
export function finishFailedLaunch(
	store: GovernorStore,
	intent: LaunchIntent,
): void {
	store
		.query(
			`UPDATE ${TABLE} SET state='FAILED' WHERE project=? AND item=? AND nonce=?`,
		)
		.run(intent.project, intent.item, intent.nonce);
	// W2317: a FAILED intent is out of the held set by the state filter —
	// its probe episode must not linger either.
	clearReprobeEpisode(store, intent.project, intent.item);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function fencedExecutor(
	directory: string,
	intent: LaunchIntent,
): string {
	mkdirSync(directory, { recursive: true });
	const descriptor = join(directory, `launch-${intent.nonce}.json`);
	const wrapper = join(directory, `launch-${intent.nonce}.sh`);
	writeFileSync(descriptor, JSON.stringify(intent), { mode: 0o600 });
	writeFileSync(
		wrapper,
		`#!/bin/sh\n${quote(process.execPath)} ${quote(import.meta.path)} --register ${quote(descriptor)} "$$" || exit 125\nexec ${quote(intent.executor)} "$@"\n`,
		{ mode: 0o700 },
	);
	return wrapper;
}
export async function awaitLaunchRegistration(
	store: GovernorStore,
	directory: string,
	intent: LaunchIntent,
	proc: Pick<Bun.Subprocess, "pid" | "exited">,
	timeoutMs = 15_000,
): Promise<void> {
	const ack = join(directory, `launch-${intent.nonce}.json.registered`);
	let exited = false;
	proc.exited.then(() => {
		exited = true;
	});
	const until = Date.now() + timeoutMs;
	while (!existsSync(ack) && !exited && Date.now() < until) await Bun.sleep(20);
	const receipt = launchIntent(store, intent.project, intent.item);
	if (
		!existsSync(ack) ||
		receipt?.nonce !== intent.nonce ||
		receipt.pid !== proc.pid ||
		receipt.state !== "REGISTERED"
	)
		throw new Error("executor registration missing or changed");
}
/** Cleanup cannot release credentials or ownership until its own child exits. */
export async function terminateOwnLaunch(
	proc: Pick<Bun.Subprocess, "kill" | "exited" | "exitCode">,
): Promise<void> {
	if (proc.exitCode === null) {
		proc.kill("SIGTERM");
		const exited = await Promise.race([
			proc.exited.then(() => true),
			Bun.sleep(500).then(() => false),
		]);
		if (!exited && proc.exitCode === null) proc.kill("SIGKILL");
	}
	await proc.exited;
}
if (import.meta.main) {
	try {
		if (process.argv[2] !== "--register")
			throw new Error("internal launch registration only");
		const intent = JSON.parse(
			readFileSync(process.argv[3], "utf8"),
		) as LaunchIntent;
		if (Number(process.argv[4]) !== process.ppid)
			throw new Error("registration must identify its own exec parent");
		const store = openStore();
		try {
			registerLaunch(store, intent, Number(process.argv[4]));
			writeFileSync(`${process.argv[3]}.registered`, intent.nonce, {
				mode: 0o600,
			});
		} finally {
			store.close();
		}
	} catch {
		console.error("Launch registration refused; harness was not started");
		process.exitCode = 125;
	}
}
