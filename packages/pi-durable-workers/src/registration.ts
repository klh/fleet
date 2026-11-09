// registration.ts — announce payload shape + a CLI-backed registration
// client. Wire shape agreed with W2886's `worker_registrations` table /
// `coord workers register` verb (consult 2026-11-09): sid, name,
// description, purpose, origin kind/id, compute kind/host/region/hub,
// owner_sid, state, task, activity. The verb may not exist yet on an older
// fleet install — the client swallows that as a soft miss (hub-dark
// tolerant), never throwing into the caller's loop.

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
	readonly activity?: string;
};

/** Registers and refreshes announcements. Implementations must never throw into the caller. */
export interface RegistrationClient {
	register(announcement: WorkerAnnouncement): Promise<RegistrationResult>;
}

export type RegistrationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/** Spawns a child process; swapped out in tests for a fake. */
export type Spawn = (
	cmd: readonly string[],
) => Promise<{ readonly exitCode: number; readonly stderr: string }>;

const defaultSpawn: Spawn = async (cmd) => {
	const proc = Bun.spawn(cmd as string[], { stdout: "ignore", stderr: "pipe" });
	const exitCode = await proc.exited;
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stderr };
};

/**
 * CLI-backed client: shells to `<coordBin> workers register <json>`. Any
 * failure (verb absent on an older install, hub unreachable, non-zero exit)
 * is reported as a non-ok result, never an exception — callers treat
 * registration as best-effort self-report, same posture as heartbeat.
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
					JSON.stringify(toWirePayload(announcement)),
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

/** camelCase announcement -> the wire's snake_case field names. */
export function toWirePayload(a: WorkerAnnouncement): Record<string, unknown> {
	return {
		sid: a.sid,
		name: a.name,
		description: a.description,
		purpose: a.purpose,
		origin_kind: a.origin.kind,
		origin_id: a.origin.id,
		compute_kind: a.compute.kind,
		compute_host: a.compute.host,
		compute_region: a.compute.region,
		hub_id: a.compute.hubId,
		owner_sid: a.ownerSid,
		state: a.state,
		task: a.task,
		activity: a.activity,
	};
}
