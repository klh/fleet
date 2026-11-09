// registration.ts — announce payload shape + a CLI-backed registration
// client. Wire contract pinned against the real `coord workers register`
// receiver (W2886 58fe2897/bcd2361a, packages/suspenders/hooks/coord/
// workers.ts registerWorker): `--as <sid>` plus one flag per field, not a
// JSON blob. owner_sid is a one-time claim on the hub side — a later
// heartbeat that passes a DIFFERENT --owner-sid than the stored one dies
// loud there, so callers should omit ownerSid on repeat heartbeats once
// registered (or keep it a true constant). The verb may not exist yet on
// an older fleet install — the client swallows that as a soft miss
// (hub-dark tolerant), never throwing into the caller's loop.

/** Origin: who holds the worker's lifetime. */
export type WorkerOrigin = {
	readonly kind: "session" | "controller" | "service" | "user";
	readonly id: string;
};

/** Compute location: where the worker's process actually runs. */
export type WorkerCompute = {
	readonly kind: "hub" | "cloud" | "local";
	readonly host: string;
	readonly region?: string;
	readonly hubId?: string;
};

/** One activity-log entry, shaped per the workers verb's `activitySchema`. */
export type WorkerActivityEntry = {
	readonly at: number;
	readonly kind: string;
	readonly text?: string | null;
};

/** One announce/heartbeat payload — the executor's self-report. */
export type WorkerAnnouncement = {
	readonly sid: string;
	readonly name: string;
	readonly description?: string;
	readonly purpose?: string;
	readonly origin: WorkerOrigin;
	readonly compute: WorkerCompute;
	readonly ownerSid?: string;
	readonly state: string;
	readonly task?: string;
	readonly activity?: readonly WorkerActivityEntry[];
};

/** Registers and refreshes announcements. Implementations must never throw into the caller. */
export interface RegistrationClient {
	register(announcement: WorkerAnnouncement): Promise<RegistrationResult>;
}

export type RegistrationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/** Runs a command, draining stdout/stderr concurrently with the wait so a full pipe buffer can't deadlock it. */
export type Spawn = (
	cmd: readonly string[],
) => Promise<{ readonly exitCode: number; readonly stderr: string }>;

const defaultSpawn: Spawn = async (cmd) => {
	const proc = Bun.spawn(cmd as string[], { stdout: "ignore", stderr: "pipe" });
	const [stderr, exitCode] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stderr };
};

/** `coord workers register --as <sid> --name n [--description d] ...` — the real flag set (no JSON blob). */
export function toRegisterArgs(a: WorkerAnnouncement): string[] {
	const flags: [string, string | undefined][] = [
		["--as", a.sid],
		["--name", a.name],
		["--description", a.description],
		["--purpose", a.purpose],
		["--origin-kind", a.origin.kind],
		["--origin-id", a.origin.id],
		["--compute-kind", a.compute.kind],
		["--host", a.compute.host],
		["--region", a.compute.region],
		["--hub-id", a.compute.hubId],
		["--owner-sid", a.ownerSid],
		["--state", a.state],
		["--task", a.task],
		["--activity", a.activity ? JSON.stringify(a.activity) : undefined],
	];
	return flags.flatMap(([flag, value]) =>
		value === undefined ? [] : [flag, value],
	);
}

/**
 * CLI-backed client: shells to `<coordBin> workers register --as <sid>
 * ...`. Any failure (verb absent on an older install, hub unreachable,
 * non-zero exit — including the hub-side one-time owner_sid claim
 * refusing a mismatched re-announce) is reported as a non-ok result,
 * never an exception — callers treat registration as best-effort
 * self-report, same posture as heartbeat.
 */
export function createCoordRegistrationClient(options: {
	readonly coordBin: string;
	readonly spawn?: Spawn;
}): RegistrationClient {
	const spawn = options.spawn ?? defaultSpawn;
	return {
		async register(announcement) {
			try {
				const { exitCode, stderr } = await spawn([
					"bun",
					options.coordBin,
					"workers",
					"register",
					...toRegisterArgs(announcement),
				]);
				if (exitCode !== 0)
					return { ok: false, reason: stderr.trim() || `exit ${exitCode}` };
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}
