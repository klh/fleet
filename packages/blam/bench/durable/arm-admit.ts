// bench/durable/arm-admit.ts — W2971.3 leaf-admission handoff: one fresh,
// mechanically repeatable admission per attempt. Composes the IN-TREE
// production leaf (createDesktopRunnerLeaf) exactly as the host service
// does: mint authority check → scoped key mint (canonical scopes) →
// admitAndStart with the staged clean archive as seedRoot → submit the
// verbatim issue text (the controller drives adapter.start from the
// submission) → persist the run identity (0600) for the supervise phase.
// Fail-closed at every step; on any throw the leaf revokes the
// just-minted key itself (abort-observing admit).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const AdmitInputSchema = z.strictObject({
	runId: z.string().uuid(),
	issueText: z.string().min(40),
	seedRoot: z.string().min(1), // dir holding the staged clean archive (/seed/source.tar contract)
	mintCredentialFile: z.string().min(1), // 0600, hub-minted root — NEVER committed
	model: z.string().min(1),
	wallClockMin: z.number().positive().nullable(), // null = leaf maximum
	imageDigest: z.string().min(8),
});
export type AdmitInput = z.infer<typeof AdmitInputSchema>;

export const AdmitReceiptSchema = z.strictObject({
	runId: z.string().uuid(),
	/** The admitted lease epoch — revocation rides this generation. */
	epoch: z.number().int().positive(),
	/** The leaf-minted credential id (credentials.resolve after ensure). */
	keyId: z.string().min(4),
	/** Deterministic executor container name (containerNameOf(runId)) —
	 *  the supervise phase finds the run's container with it. */
	containerName: z.string().min(1),
	seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
	policyDigest: z.string().length(64),
	/** Replay-safe submission id — the supervise phase re-submits with this
	 *  exact requestId; the durable job's dedupe returns the SAME submission
	 *  handle (Root #118412 idempotent replay), whose wait() resolves at
	 *  run terminal. Part of the frozen receipt: re-drive = re-run, never
	 *  re-attach to someone else's submission. */
	requestId: z.string().uuid(),
	startedAt: z.number(),
	deadline: z.number(),
});
export type AdmitReceipt = z.infer<typeof AdmitReceiptSchema>;

/** The leaf surface the arm needs post-admission (structural — keeps the
 *  schema layer import-light; the real type arrives with the lazy import). */
export interface DesktopLeafHandle {
	durable: {
		submit(
			runId: string,
			text: string,
			opts: { requestId: string },
		): Promise<{
			id: string;
			wait(signal?: AbortSignal): Promise<void>;
			status(): Promise<{ state: string }>;
		}>;
	};
	stopRun(runId: string): Promise<void>;
}

/**
 * Perform one admission. The heavy composition (docker probe, env,
 * credential manager, durable job) is the production leaf's job — this
 * module ONLY stages inputs, calls admitAndStart, submits the task, and
 * freezes the receipt. Import of the leaf is lazy so the schema layer
 * stays testable without docker.
 */
export async function admitArm(input: AdmitInput): Promise<AdmitReceipt> {
	const parsed = AdmitInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new Error(`admit input drift refused:\n${parsed.error.message}`);
	}
	const {
		runId,
		issueText,
		seedRoot,
		mintCredentialFile,
		model,
		wallClockMin,
	} = parsed.data;
	if (!existsSync(seedRoot)) throw new Error(`seedRoot missing: ${seedRoot}`);
	if (!existsSync(mintCredentialFile))
		throw new Error(`mint credential missing: ${mintCredentialFile}`);

	// production leaf, in-tree — package-name import (import law W1249;
	// runtime file ⇒ declared dependency @klh/suspenders, hooks/* wildcard export)
	const { createDesktopRunnerLeaf } = await import(
		"@klh/suspenders/hooks/lib/runners/desktop/wiring.ts"
	);
	const { RunnerSpecSchema } = await import(
		"@klh/suspenders/hooks/lib/runners/control/control-state.ts"
	);
	const { canonicalSeedDigest, scanSeedDir } = await import(
		"@klh/suspenders/hooks/lib/runners/desktop/seed.ts"
	);
	const { containerNameOf } = await import(
		"@klh/suspenders/hooks/lib/runners/desktop/docker-executor.ts"
	);
	const { RUNNER_SCOPES } = await import(
		"@klh/suspenders/hooks/lib/runners/control/rights.ts"
	);
	const deps = await loadLeafDeps(seedRoot, model, wallClockMin);
	const leaf = createDesktopRunnerLeaf(deps);
	const seedDigest = canonicalSeedDigest(await scanSeedDir(seedRoot));
	const spec = RunnerSpecSchema.parse({
		version: 1,
		runId,
		owner: "bench",
		generation: 1,
		kind: "coding",
		seedDigest,
		policyDigest: leaf.policyDigest(),
		provider: "belt",
		model,
	});
	const { token } = await leaf.admitAndStart({
		spec,
		actor: {
			sid: `bench-${runId.slice(0, 8)}`,
			scopes: [RUNNER_SCOPES.control],
		},
		seedRoot,
	});
	// submit the verbatim issue text — the controller drives adapter.start
	// (container + durable journal) from the submission; admit alone parks.
	// requestId is the supervise phase's replay key (frozen in the receipt).
	const requestId = crypto.randomUUID();
	await leaf.controller.submit({
		runId,
		text: issueText,
		requestId,
		actor: {
			sid: `bench-${runId.slice(0, 8)}`,
			scopes: [RUNNER_SCOPES.control],
		},
	});
	const credential = leaf.credentials.resolve(runId);
	if (!credential) {
		throw new Error(
			`admit receipt refused: no leaf credential after admit (${runId})`,
		);
	}
	const receipt = AdmitReceiptSchema.parse({
		runId,
		epoch: token.epoch,
		keyId: credential.keyId,
		containerName: containerNameOf(runId),
		seedDigest,
		policyDigest: leaf.policyDigest(),
		requestId,
		startedAt: Date.now(),
		deadline: Date.now() + (wallClockMin ?? 30) * 60_000,
	});
	// the leaf rides out with the receipt: the arm keeps THIS process alive
	// through supervise/extract/judge — the durable job lives in it
	return { receipt, leaf: leaf as DesktopLeafHandle };
}

async function loadLeafDeps(
	seedRoot: string,
	model: string,
	wallClockMin: number | null,
) {
	// compose from the machine-local env (bench.local.json + the mint
	// credential file) the FULL DesktopLeafDeps — identityUrl/modelBaseUrl,
	// stateDir, image all come from bench.local.json; the caller passes
	// only the per-attempt inputs.
	const { loadBenchEnv } = await import("./bench-env.ts");
	return loadBenchEnv({ seedRoot, model, wallClockMin });
}

/** Freeze the admit receipt for the supervise phase (0600). */
export function persistAdmitReceipt(
	receiptsDir: string,
	problemId: string,
	attempt: number,
	receipt: AdmitReceipt,
): string {
	mkdirSync(receiptsDir, { recursive: true });
	const path = join(receiptsDir, `${problemId}-a${attempt}-ADMIT.json`);
	writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
	return path;
}
