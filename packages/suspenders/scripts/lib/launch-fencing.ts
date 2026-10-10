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
import { openStore, type GovernorStore } from "../../hooks/lib/govdb.ts";

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
	launchSchema(store);
	const rows = store
		.query(`SELECT * FROM ${TABLE} WHERE project=? AND state!='FAILED'`)
		.all(project) as LaunchIntent[];
	return new Set(
		rows
			.filter((row) => inspectLaunchIntent(row) !== "dead")
			.map((row) => row.item),
	);
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
		const boot = command(["/usr/sbin/sysctl", "-n", "kern.boottime"]);
		const argv = command(["/bin/ps", "-p", String(pid), "-o", "command="]);
		const again = darwinBirth(pid);
		return boot && argv && again === birth
			? { birth: `${boot}:${birth}`, command: argv }
			: null;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
	}
}
/** macOS flips a host between `.local` and `.localdomain` (mDNS/DHCP); the
 * same machine must stay inspectable across the flip or its pre-flip launch
 * intents are uncertain forever and the launch pool leaks its capacity. Only
 * that exact suffix pair normalizes — pid+birth+argv fencing stays the gate. */
const normalizeHost = (host: string): string =>
	host.replace(/(?:\.(?:local|localdomain))+$/i, "");
const sameMachine = (a: string, b: string): boolean =>
	normalizeHost(a) === normalizeHost(b);
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
	if (current.birth !== intent.birth) return "dead";
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
		if (
			!store
				.query(
					"SELECT 1 FROM work_items WHERE project=? AND id=? AND owner_sid=? AND updated_at=? AND state IN ('CLAIMED','RUNNING')",
				)
				.get(intent.project, intent.item, intent.sid, intent.revision)
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
	if (proc.exitCode === null) proc.kill("SIGKILL");
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
