// hooks/board/runner-overview.ts — W2869.2.1: the /console/buckle Runner
// card payload. Presentation-only: this module calls the W2869.2 control-
// plane's own HTTP surface (never the durable/executor code or its sqlite
// store directly) to list runs and open read-only per-reader cursor
// subscriptions (attach/replay/detach — no submit/resume/abort/park here).
// Absent/unreachable control plane = honest ok:false; unavailable beats a
// fake empty list (the network-overview.ts precedent).
import { withRecovery } from "./service-probe.ts";
import { cachedProbes } from "./console-view.ts";

export interface RunnerRow {
	runId: string;
	owner: string;
	generation: number;
	kind: string;
	model: string;
	provider: string;
	state: string;
	updatedAt: number;
}

export interface RunnerCursorState {
	/** The reader's own examined-advance cursor after the last replay. */
	cursor: number;
	/** Event kinds handed since the previous cursor — payloads stay server-side. */
	eventKinds: string[];
}

export type RunnerOverviewResult =
	| { ok: false; reason: string }
	| { ok: true; runs: RunnerRow[]; nextCursor: string | null };

const RUNNER_CARD_SERVICE_ID = "runner-control";

/** `env.RUNNER_CONTROL_URL` — unset until a hub's control-plane listener
 *  (W2869.2 + the api/ adapter, parked/W2879) deploys; absent = honest
 *  "not wired here", never a silent empty table. */
export function resolveRunnerControlUrl(
	env: Record<string, string | undefined>,
): string | null {
	return env.RUNNER_CONTROL_URL ?? null;
}

async function fetchRunnerRuns(
	base: string,
	keyFile: string | undefined,
): Promise<RunnerOverviewResult> {
	if (!keyFile)
		return { ok: false, reason: "runner.private_credential_required" };
	try {
		const response = await fetch(new URL("/v1/runner/runs", base), {
			redirect: "error",
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok)
			return { ok: false, reason: `runner.http_${response.status}` };
		const body = (await response.json()) as {
			runs: RunnerRow[];
			nextCursor: string | null;
		};
		return { ok: true, runs: body.runs, nextCursor: body.nextCursor };
	} catch {
		return { ok: false, reason: "runner.unreachable" };
	}
}

/** /api/console/runner payload: the control-plane run listing + the local
 *  monitored-service row for the control listener itself. */
export interface RunnerPayload {
	ok: true;
	ts: string;
	runner: RunnerOverviewResult;
	control: ReturnType<typeof withRecovery> | null;
}

export async function runnerPayload(
	env: Record<string, string | undefined> = process.env,
): Promise<RunnerPayload> {
	const base = resolveRunnerControlUrl(env);
	const control =
		(await cachedProbes()).find((p) => p.id === RUNNER_CARD_SERVICE_ID) ?? null;
	const runner: RunnerOverviewResult = base
		? await fetchRunnerRuns(base, env.RUNNER_CONTROL_KEY_FILE)
		: { ok: false, reason: "runner.control_url_unset" };
	return {
		ok: true,
		ts: new Date().toISOString(),
		runner,
		control: control ? withRecovery(control) : null,
	};
}
