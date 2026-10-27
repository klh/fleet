// hooks/lib/capacity/ramp-session.ts — W1713 one operator-run capacity session:
// scoped artifacts dir (0600 manifest + NDJSON rows + summary), the pre/post
// fleet snapshots (live lane processes, gateway in-flight, recent productive
// lane ids), the ramp itself, the ledger cross-check, and revocation proof.
// Everything outward-facing is injected so the e2e spec drives it against a
// fake gateway.
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fetchInflight,
	fetchKeyRevocations,
	fetchLedgerAll,
	ledgerView,
} from "./ramp-gateway.ts";
import { writeManifest, type Manifest } from "./ramp-manifest.ts";
import { lanesNote, renderRun, renderStep } from "./ramp-report.ts";
import { runRamp, type RampConfig, type RampResult } from "./ramp-run.ts";

export interface SessionIo {
	fetch: typeof fetch;
	front: string;
	admin: string;
	outDir: string;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	mint: (sid: string) => Promise<{ key: string; keyId: string } | null>;
	revoke: (keyId: string) => Promise<boolean>;
	/** live lane PROCESSES (work lanes), distinct from in-flight RPCs; null = unreadable */
	liveLanes: () => Promise<number | null>;
	log: (line: string) => void;
	signal: AbortSignal;
}

export interface SessionOutcome {
	result: RampResult;
	report: string;
	revokeVerified: boolean | null;
	summaryPath: string;
}

const BASELINE_WINDOW_MS = 15 * 60_000;
const LEDGER_SLACK_MS = 2_000;

export async function runSession(
	cfg: RampConfig,
	io: SessionIo,
): Promise<SessionOutcome> {
	mkdirSync(io.outDir, { recursive: true, mode: 0o700 });
	const manifestPath = join(io.outDir, "manifest.json");
	const rowsPath = join(io.outDir, "rows.ndjson");
	const summaryPath = join(io.outDir, "summary.json");
	writeFileSync(rowsPath, "", { mode: 0o600 });
	const manifest: Manifest = {
		runId: cfg.runId,
		front: io.front,
		createdMs: io.now(),
		keys: [],
	};
	writeManifest(manifestPath, manifest);

	const liveBefore = await io.liveLanes();
	const gwBefore = await fetchInflight(io.fetch, io.front, io.admin);
	const t0 = io.now();
	const baseline = ledgerView(
		await fetchLedgerAll(io.fetch, io.front, io.admin, {
			sinceIso: new Date(t0 - BASELINE_WINDOW_MS).toISOString(),
			untilIso: new Date(t0 + LEDGER_SLACK_MS).toISOString(),
		}),
		() => false,
	);
	io.log(
		`baseline: live lane processes ${String(liveBefore ?? "-")}, gateway in-flight ${String(gwBefore?.active ?? "-")}, productive lane ids last 15m ${lanesNote(baseline?.others ?? null, baseline?.truncated ?? false)}`,
	);

	const result = await runRamp(cfg, {
		fetch: io.fetch,
		front: io.front,
		now: io.now,
		sleep: io.sleep,
		mint: io.mint,
		revoke: io.revoke,
		inflight: () => fetchInflight(io.fetch, io.front, io.admin),
		onKey: (sid, keyId) => {
			manifest.keys.push({ sid, keyId });
			writeManifest(manifestPath, manifest);
		},
		onRow: (row) => appendFileSync(rowsPath, `${JSON.stringify(row)}\n`),
		onStep: (s) => io.log(renderStep(s)),
		signal: io.signal,
	});

	const liveAfter = await io.liveLanes();
	const own = (lane: string): boolean => lane.startsWith(cfg.lanePrefix);
	const ledger = ledgerView(
		await fetchLedgerAll(io.fetch, io.front, io.admin, {
			sinceIso: new Date(result.startedMs).toISOString(),
			untilIso: new Date(result.endedMs + LEDGER_SLACK_MS).toISOString(),
		}),
		own,
	);
	const state = await fetchKeyRevocations(
		io.fetch,
		io.front,
		io.admin,
		result.keys.map((k) => k.keyId),
	);
	const revokeVerified =
		state === null
			? null
			: result.keys.every((k) => state.get(k.keyId) !== false);

	const report = renderRun(result, { ledger, liveBefore, liveAfter });
	writeFileSync(
		summaryPath,
		`${JSON.stringify({ result, baseline, ledger, liveBefore, liveAfter, revokeVerified }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	chmodSync(summaryPath, 0o600);
	return { result, report, revokeVerified, summaryPath };
}
