// Claim incarnation transfer retains the dispatch baseline and token provenance.
import { randomUUID } from "node:crypto";
import {
	lstatSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { GovernorStore } from "./govdb.ts";
import { projectIdentity, projectRootOf } from "./govdb-project.ts";
import { verifyOperatorContextEvidence } from "./reclaim-context-evidence.ts";
import { claimTokenHash } from "./work-fence.ts";
import { registryWorktrees, resolveItemWorktree } from "./worktree-lookup.ts";

type Binding = {
	sid: string;
	tokenHash: string;
	baseline: string;
	launchedAt: number;
};
type Context = Record<string, unknown> & {
	sid: string;
	item: string;
	baseline: string;
	launchedAt: number;
	claimToken: string;
};
export type ContextTransfer = {
	receipt: Binding;
	operatorReceipt?: Record<string, unknown>;
	replace(): void;
	rollback(): void;
};

/** A canonical retake may continue its own dirty tree without resuming a
 * transcript. The immutable claim receipt, current token and registered tree
 * must agree; merely finding a lane-context file is never authority. */
export function verifiedContextContinuation(
	store: GovernorStore,
	args: {
		project: string;
		item: string;
		sid: string;
		token: string;
		revision: number;
		tree: string;
	},
): boolean {
	try {
		const { project, item, sid, token, revision, tree } = args;
		const registered = resolveItemWorktree(projectRootOf(project), item);
		if (!registered || realpathSync(registered) !== realpathSync(tree))
			return false;
		const path = join(tree, ".fleet", "lane-context.json");
		if (
			!lstatSync(path).isFile() ||
			lstatSync(path).isSymbolicLink() ||
			lstatSync(dirname(path)).isSymbolicLink()
		)
			return false;
		const context = JSON.parse(readFileSync(path, "utf8")) as Context;
		if (
			context.sid !== sid ||
			context.item !== item ||
			context.claimToken !== token
		)
			return false;
		const hash = claimTokenHash(token);
		const claim = store
			.query(
				"SELECT owner_sid,claim_token_hash,updated_at,state FROM work_items WHERE project=? AND id=?",
			)
			.get(project, item) as {
			owner_sid: string;
			claim_token_hash: string;
			updated_at: number;
			state: string;
		} | null;
		if (
			!claim ||
			claim.owner_sid !== sid ||
			claim.claim_token_hash !== hash ||
			claim.updated_at !== revision ||
			!["CLAIMED", "RUNNING"].includes(claim.state)
		)
			return false;
		const row = store
			.query(
				"SELECT payload FROM events WHERE kind='work.claimed' AND project=? AND work=? ORDER BY id DESC LIMIT 1",
			)
			.get(project, item) as { payload: string } | null;
		if (!row) return false;
		const receipt = JSON.parse(row.payload) as {
			by?: string;
			claim_token_hash?: string;
			context_origin?: Binding;
		};
		if (
			receipt.by !== sid ||
			receipt.claim_token_hash !== hash ||
			receipt.context_origin?.baseline !== context.baseline ||
			receipt.context_origin.launchedAt !== context.launchedAt
		)
			return false;
		return (
			Bun.spawnSync(
				[
					"git",
					"-C",
					tree,
					"merge-base",
					"--is-ancestor",
					context.baseline,
					"HEAD",
				],
				{ stdout: "ignore", stderr: "ignore" },
			).exitCode === 0
		);
	} catch {
		return false;
	}
}

/** Validate before rotating the row. Neither a conventional directory nor a
 * caller-provided SID is ownership proof: Git registration, claim hash and
 * immutable commit ancestry must all agree. */
export function prepareContextTransfer(
	store: GovernorStore,
	project: string,
	item: string,
	oldHash: string | null,
	sid: string,
	token: string,
	reconcile = false,
	operator?: { evidence: string; revision: number },
): ContextTransfer | null {
	const root = projectRootOf(project);
	const tree = resolveItemWorktree(root, item);
	if (!tree) return null;
	const path = join(tree, ".fleet", "lane-context.json");
	let contextStat: Stats;
	try {
		contextStat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (
		!contextStat.isFile() ||
		contextStat.isSymbolicLink() ||
		lstatSync(dirname(path)).isSymbolicLink()
	)
		throw new Error(
			"Claim context must be a regular file in its registered tree",
		);
	if (
		!registryWorktrees(root).some(
			(entry) =>
				entry.branch === `suspenders/${item}` &&
				realpathSync(entry.path) === realpathSync(tree),
		) ||
		projectIdentity(tree) !== project
	)
		throw new Error(
			"Claim context tree is not registered to this project and item",
		);
	const original = readFileSync(path, "utf8");
	let context: Context;
	try {
		context = JSON.parse(original) as Context;
	} catch {
		throw new Error("Invalid claim context; retake refused");
	}
	if (
		context.item !== item ||
		typeof context.sid !== "string" ||
		!context.sid ||
		typeof context.claimToken !== "string" ||
		!/^[a-f0-9]{48}$/.test(context.claimToken) ||
		typeof context.baseline !== "string" ||
		!/^[a-f0-9]{40}$/.test(context.baseline) ||
		typeof context.launchedAt !== "number" ||
		!Number.isFinite(context.launchedAt)
	)
		throw new Error(
			"Claim context lacks immutable item, baseline or token provenance",
		);
	const baseline = Bun.spawnSync(
		[
			"git",
			"-C",
			tree,
			"merge-base",
			"--is-ancestor",
			context.baseline,
			"HEAD",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (baseline.exitCode !== 0)
		throw new Error("Claim context baseline is not an ancestor of this tree");
	const receipt: Binding = {
		sid: context.sid,
		tokenHash: claimTokenHash(context.claimToken),
		baseline: context.baseline,
		launchedAt: context.launchedAt,
	};
	let operatorReceipt: Record<string, unknown> | undefined;
	if (reconcile && !(context.sid === sid && receipt.tokenHash === oldHash)) {
		// A past rotation can only be repaired from a durable hash receipt,
		// never by trusting the stale context's claim about its own origin.
		const receipts = store
			.query(
				"SELECT payload FROM events WHERE kind='work.claimed' AND project=? AND work=? ORDER BY id DESC",
			)
			.all(project, item) as { payload: string }[];
		const proven = receipts.some((row) => {
			try {
				const event = JSON.parse(row.payload) as { context_origin?: Binding };
				const origin = event.context_origin;
				return (
					origin?.sid === receipt.sid &&
					origin.tokenHash === receipt.tokenHash &&
					origin.baseline === receipt.baseline &&
					origin.launchedAt === receipt.launchedAt
				);
			} catch {
				return false;
			}
		});
		if (!proven) {
			if (!operator)
				throw new Error(
					"Cannot reconcile claim context without its durable original token receipt",
				);
			operatorReceipt = verifyOperatorContextEvidence(store, {
				path: operator.evidence,
				project,
				item,
				tree,
				owner: sid,
				revision: operator.revision,
				contextBytes: original,
				originalSid: context.sid,
				baseline: context.baseline,
				launchedAt: context.launchedAt,
			});
		}
	} else if (!oldHash || receipt.tokenHash !== oldHash) {
		throw new Error("Claim context token does not match the released claim");
	}
	if (!reconcile) {
		const claimed = store
			.query(
				"SELECT payload FROM events WHERE kind='work.claimed' AND project=? AND work=? ORDER BY id DESC LIMIT 1",
			)
			.get(project, item) as { payload: string } | null;
		const event = claimed
			? (JSON.parse(claimed.payload) as {
					by?: string;
					claim_token_hash?: string;
				})
			: null;
		if (
			!event ||
			event.by !== context.sid ||
			(event.claim_token_hash && event.claim_token_hash !== oldHash)
		)
			throw new Error(
				"Claim context owner does not match the original claim receipt",
			);
	}
	const replacement = JSON.stringify({
		...context,
		sid,
		claimToken: token,
		origin: context.origin ?? receipt,
	});
	const atomicWrite = (bytes: string) => {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	};
	let written = false;
	return {
		receipt,
		operatorReceipt,
		replace() {
			if (readFileSync(path, "utf8") !== original)
				throw new Error("Claim context changed during retake");
			atomicWrite(replacement);
			written = true;
		},
		rollback() {
			if (written && readFileSync(path, "utf8") === replacement)
				atomicWrite(original);
		},
	};
}
