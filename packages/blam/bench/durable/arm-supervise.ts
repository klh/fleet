// bench/durable/arm-supervise.ts — W2971.3 supervise phase: keep the leaf
// process (which OWNS the durable job) alive while the run executes, with
// a hard wall-clock deadline. Terminal detection rides the DURABLE
// JOURNAL (the truth that outlives processes): pi.generation tasks are
// pending/running while the agent turn chain works; the run is settled
// when no task is active for a settled window. The adapter's submit
// drops the submission handle (control-plane-only return), so polling
// the journal is the supervise contract — replay tokens stay untouched.
// On deadline the run is stopped (revoking the lease) — honest timeout.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SuperviseResult {
	state: "completed" | "timeout";
	wallClockMs: number;
}

const ACTIVE = new Set(["pending", "running"]);
const POLL_MS = 5_000;
/** consecutive settled polls required — a mid-turn model pause must not
 *  read as terminal; two clean windows (~10s of silence) close it */
const SETTLED_WINDOWS = 2;

function activeTaskCount(journalDir: string): number {
	const stateDir = join(journalDir, "state");
	if (!existsSync(stateDir)) return 1; // journal not born yet — still active
	const latest = new Map<string, string>();
	for (const file of readdirSync(stateDir)) {
		if (!file.startsWith("task-") || !file.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(stateDir, file), "utf8").split("\n")) {
			if (!line.includes('"state"')) continue;
			try {
				const record = JSON.parse(line) as {
					payload?: {
						type?: string;
						value?: { id?: number; kind?: string; state?: { status?: string } };
					};
				};
				const task = record.payload?.value;
				if (record.payload?.type === "task" && task?.id !== undefined) {
					latest.set(String(task.id), task.state?.status ?? "unknown");
				}
			} catch {
				// torn trailing line — the next record supersedes it
			}
		}
	}
	let active = 0;
	for (const status of latest.values()) if (ACTIVE.has(status)) active += 1;
	return active;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function superviseRun(
	journalDir: string,
	deadlineMs: number,
	stopRun: () => Promise<void>,
): Promise<SuperviseResult> {
	const started = Date.now();
	let settled = 0;
	while (Date.now() < deadlineMs) {
		const active = activeTaskCount(journalDir);
		settled = active === 0 ? settled + 1 : 0;
		if (settled >= SETTLED_WINDOWS)
			return { state: "completed", wallClockMs: Date.now() - started };
		await sleep(POLL_MS);
	}
	// fence the run: control revokes the lease, the job closes, the
	// container stops — never leave a live key behind
	await stopRun();
	return { state: "timeout", wallClockMs: Date.now() - started };
}
