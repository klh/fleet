// bench/durable/arm-admit.ts — W2971.3 leaf-admission handoff: one fresh,
// mechanically repeatable admission per attempt. Composes the IN-TREE
// production leaf (createDesktopRunnerLeaf) exactly as the host service
// does: mint authority check → scoped key mint (canonical scopes) →
// admitAndStart with the staged clean archive as seedRoot → submit the
// verbatim issue text → persist the run identity (0600) for the supervise
// phase. Fail-closed at every step; on any throw the leaf revokes the
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
	containerName: z.string().min(1),
	fullCid: z.string().min(8),
	leaseToken: z.string().min(4),
	keyId: z.string().min(4),
	policyDigest: z.string().length(64),
	startedAt: z.number(),
	deadline: z.number(),
});
export type AdmitReceipt = z.infer<typeof AdmitReceiptSchema>;

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
	const { runId, issueText, seedRoot, mintCredentialFile, model, wallClockMin } = parsed.data;
	if (!existsSync(seedRoot)) throw new Error(`seedRoot missing: ${seedRoot}`);
	if (!existsSync(mintCredentialFile)) throw new Error(`mint credential missing: ${mintCredentialFile}`);

	// production leaf, in-tree — package-name import (import law W1249;
	// runtime file ⇒ declared dependency @klh/suspenders, hooks/* wildcard export)
	const { createDesktopRunnerLeaf } = await import("@klh/suspenders/hooks/lib/runners/desktop/wiring.ts");
	const deps = await loadLeafDeps(seedRoot, model, wallClockMin);
	const leaf = createDesktopRunnerLeaf(deps);
	const spec = buildSpec(runId, issueText, model, wallClockMin, leaf.policyDigest());
	const { token } = await leaf.admitAndStart({
		spec,
		actor: { sid: `bench-${runId.slice(0, 8)}`, scopes: ["runner:WRITE_"] },
		seedRoot,
	});
	const receipt = AdmitReceiptSchema.parse({
		runId,
		containerName: `fleet-runner-${runId.replaceAll("-", "").slice(0, 16)}`,
		fullCid: token.containerCid ?? token.cid ?? "unknown",
		leaseToken: token.value ?? token.token ?? String(token),
		keyId: token.keyId ?? "leaf-minted",
		policyDigest: leaf.policyDigest(),
		startedAt: Date.now(),
		deadline: Date.now() + (wallClockMin ?? 30) * 60_000,
	});
	return receipt;
}

async function loadLeafDeps(seedRoot: string, model: string, wallClockMin: number | null) {
	// compose from the machine-local env the same way the W2990 arm wrapper
	// did — mintCredentialFile supplies the hub root; identityUrl comes from
	// bench.local.json via env injection by the caller (arm-runner main).
	const { loadBenchEnv } = await import("./bench-env.ts");
	return loadBenchEnv({ seedRoot, model, wallClockMin });
}

function buildSpec(
	runId: string,
	issueText: string,
	model: string,
	wallClockMin: number | null,
	policyDigest: string,
): Record<string, unknown> {
	return {
		runId,
		model,
		task: { kind: "issue", text: issueText },
		policyDigest, // spec builders MUST stamp this or start refuses
		deadlineMs: (wallClockMin ?? 30) * 60_000,
		caps: { maxOutputTokens: 16384 },
	};
}

/** Freeze the admit receipt for the supervise phase (0600). */
export function persistAdmitReceipt(receiptsDir: string, problemId: string, attempt: number, receipt: AdmitReceipt): string {
	mkdirSync(receiptsDir, { recursive: true });
	const path = join(receiptsDir, `${problemId}-a${attempt}-ADMIT.json`);
	writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
	return path;
}
