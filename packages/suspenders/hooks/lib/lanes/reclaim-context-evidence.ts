// Explicit operator repair for an already rotated claim with lost old receipts.
// Authority is the local operator CLI boundary, as with forced operator reclaim;
// an arbitrary --by SID is deliberately not accepted as authentication.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { GovernorStore } from "../govdb/govdb.ts";

export const bytesHash = (bytes: string): string =>
	createHash("sha256").update(bytes).digest("hex");
type Evidence = {
	project: string;
	item: string;
	tree: string;
	owner: string;
	revision: number;
	contextHash: string;
	productSha: string;
	originalClaimEventId: number;
	stopReceipt: string;
	stopReceiptHash: string;
	attestation: "reviewed-original-baseline-and-merged-product-without-original-token-receipt";
};
const privateFile = (path: string): string => {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o600 ||
		stat.size > 65536
	)
		throw new Error(
			"Operator reconciliation evidence must be a regular 0600 file of at most 64 KiB",
		);
	return readFileSync(path, "utf8");
};

export function verifyOperatorContextEvidence(
	store: GovernorStore,
	o: {
		path: string;
		project: string;
		item: string;
		tree: string;
		owner: string;
		revision: number;
		contextBytes: string;
		originalSid: string;
		baseline: string;
		launchedAt: number;
	},
): Record<string, unknown> {
	const bytes = privateFile(o.path);
	const evidence = JSON.parse(bytes) as Evidence;
	if (
		evidence.project !== o.project ||
		evidence.item !== o.item ||
		realpathSync(evidence.tree) !== realpathSync(o.tree) ||
		evidence.owner !== o.owner ||
		evidence.revision !== o.revision ||
		evidence.contextHash !== bytesHash(o.contextBytes) ||
		evidence.attestation !==
			"reviewed-original-baseline-and-merged-product-without-original-token-receipt"
	)
		throw new Error(
			"Operator reconciliation evidence does not match this exact claim and context",
		);
	if (
		!/^[a-f0-9]{40}$/.test(evidence.productSha) ||
		!Number.isSafeInteger(evidence.originalClaimEventId)
	)
		throw new Error(
			"Operator reconciliation requires exact product commit and original claim receipt",
		);
	const original = store
		.query(
			"SELECT ts,payload FROM events WHERE id=? AND kind='work.claimed' AND project=? AND work=?",
		)
		.get(evidence.originalClaimEventId, o.project, o.item) as {
		ts: number;
		payload: string;
	} | null;
	if (
		!original ||
		JSON.parse(original.payload).by !== o.originalSid ||
		original.ts > o.launchedAt ||
		original.ts >= o.revision
	)
		throw new Error(
			"Operator reconciliation original claim receipt does not match the dispatch context",
		);
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", o.tree, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	for (const [ancestor, descendant] of [
		[o.baseline, evidence.productSha],
		[evidence.productSha, "main"],
		[evidence.productSha, "HEAD"],
	])
		if (git("merge-base", "--is-ancestor", ancestor, descendant).exitCode !== 0)
			throw new Error(
				"Operator reconciliation product must contain the original baseline and be merged in main and this tree",
			);
	const diff = git("diff", "--name-only", o.baseline, evidence.productSha);
	if (
		diff.exitCode !== 0 ||
		!diff.stdout
			.toString()
			.split("\n")
			.some(
				(path) =>
					path && !/^(\.fleet|\.claude|\.agents|node_modules)(\/|$)/.test(path),
			)
	)
		throw new Error("Operator reconciliation has no reviewed product diff");
	const stop = privateFile(evidence.stopReceipt);
	if (bytesHash(stop) !== evidence.stopReceiptHash)
		throw new Error("Operator reconciliation stop receipt digest differs");
	return {
		actor: "operator-reconcile",
		evidenceHash: bytesHash(bytes),
		contextHash: evidence.contextHash,
		originalClaimEventId: evidence.originalClaimEventId,
		productSha: evidence.productSha,
		stopReceiptHash: evidence.stopReceiptHash,
	};
}
