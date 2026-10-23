import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { processBirth, type ProcessBirth } from "./launch-fencing.ts";
import { compareProcessBirth } from "./process-birth.ts";

/** Serialize reviewed gateway approval against competing supported writers.
 * The fence is the single lease authority for BOTH the receipt/unit publish
 * and the bootout/bootstrap lifecycle action: a supported writer presents a
 * live unexpired fence at every boundary, so two competing approvals cannot
 * commit from one prior snapshot and a stale owner cannot bootout. Owner
 * identity is PID + process birth (the W576.3 launch-fencing authority —
 * birth identity is independent of prompt text and PID reuse). Uncertainty is
 * never death: an unreadable owner is a typed refusal, never a takeover.
 * Proven-dead and expired owners are stale-broken by renaming the record
 * aside (auditable, never deleted), so a crashed holder's lease cannot wedge
 * the approval lane forever; recovery re-prepares from the published receipt
 * — truthful intent, never blind rollback. */
export interface ApprovalFence {
	schema: "fleet.approval-fence.v1";
	label: string;
	/** The gatewayReviewToken this owner is committing (audit trail). */
	token: string;
	pid: number;
	birth: string;
	state: "PREPARING" | "PUBLISHED";
	acquiredAt: number;
	expiresAt: number;
}

export interface FenceOwner {
	pid: number;
	birth: string;
}

export type FenceInspect = (pid: number) => ProcessBirth | false | null;

export const APPROVAL_FENCE_MS = 120_000;
const FENCE_SCHEMA = "fleet.approval-fence.v1";

export const approvalFencePath = (staging: string, label: string): string =>
	join(staging, `${label}.approve-fence.json`);

const readFence = (path: string): ApprovalFence => {
	const bytes = readFileSync(path, "utf8"); // ENOENT propagates to callers
	let fence: ApprovalFence;
	try {
		fence = JSON.parse(bytes) as ApprovalFence;
	} catch {
		throw new Error("approval fence record is invalid; owner review required");
	}
	if (
		fence.schema !== FENCE_SCHEMA ||
		!/^com\.suspenders\.[a-z0-9-]+$/.test(fence.label) ||
		!/^[a-f0-9]{64}$/.test(fence.token) ||
		!Number.isSafeInteger(fence.pid) ||
		fence.pid < 1 ||
		typeof fence.birth !== "string" ||
		fence.birth === "" ||
		(fence.state !== "PREPARING" && fence.state !== "PUBLISHED") ||
		!Number.isSafeInteger(fence.acquiredAt) ||
		!Number.isSafeInteger(fence.expiresAt) ||
		fence.expiresAt < fence.acquiredAt
	)
		throw new Error("approval fence record is invalid; owner review required");
	return fence;
};

/** O_EXCL create is the serialization point: exactly one writer's record lands. */
const createFence = (path: string, fence: ApprovalFence): void => {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const descriptor = openSync(path, "wx", 0o600);
	try {
		writeSync(descriptor, JSON.stringify(fence));
	} finally {
		closeSync(descriptor);
	}
};

const staleBreak = (path: string): void => {
	renameSync(path, `${path}.stale-${crypto.randomUUID()}`);
};

const ownFence = (
	label: string,
	token: string,
	inspect: FenceInspect,
	now: () => number,
	leaseMs: number,
): ApprovalFence => {
	const identity = inspect(process.pid);
	if (identity === false || !identity)
		throw new Error("approval fence owner birth unavailable; refused");
	return {
		schema: FENCE_SCHEMA,
		label,
		token,
		pid: process.pid,
		birth: identity.birth,
		state: "PREPARING",
		acquiredAt: now(),
		expiresAt: now() + leaseMs,
	};
};

/** Acquire the label's approval fence. Refuses (typed) while a live unexpired
 * owner holds it — the competing supported upgrade cannot commit. Stale-breaks
 * proven-dead, recycled-PID and expired owners after renaming the old record
 * aside; refuses unknown owners and corrupt records untouched. */
function assessHeld(
	path: string,
	held: ApprovalFence,
	current: ProcessBirth | false | null,
	now: () => number,
): void {
	const comparison = current
		? compareProcessBirth(held.birth, current.birth)
		: "unknown";
	if (current === false || comparison === "different") {
		staleBreak(path);
		return;
	}
	if (!current || comparison === "unknown")
		throw new Error(
			"approval fence owner identity unknown; observation required",
		);
	if (now() > held.expiresAt) {
		staleBreak(path);
		return;
	}
	throw new Error(
		"another approved writer holds the gateway approval fence; observe and retry",
	);
}

export function acquireApprovalFence(
	staging: string,
	label: string,
	token: string,
	options: {
		leaseMs?: number;
		now?: () => number;
		inspect?: FenceInspect;
		attempts?: number;
	} = {},
): ApprovalFence {
	const now = options.now ?? Date.now;
	const inspect = options.inspect ?? processBirth;
	const path = approvalFencePath(staging, label);
	mkdirSync(staging, { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < (options.attempts ?? 3); attempt++) {
		const mine = ownFence(
			label,
			token,
			inspect,
			now,
			options.leaseMs ?? APPROVAL_FENCE_MS,
		);
		try {
			createFence(path, mine);
			return mine;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const held = readFence(path);
		assessHeld(path, held, inspect(held.pid), now);
	}
	throw new Error(
		"gateway approval fence contention did not clear; owner review required",
	);
}

/** Predicated state flip PREPARING→PUBLISHED before the lifecycle action.
 * Refuses when the fence no longer names this owner and token — the lease
 * was stolen or expired mid-publish; this writer must not bootout. */
export function markApprovalPublished(
	staging: string,
	label: string,
	owner: FenceOwner,
	token: string,
): void {
	const path = approvalFencePath(staging, label);
	const held = readFence(path);
	if (
		held.pid !== owner.pid ||
		held.birth !== owner.birth ||
		held.token !== token
	)
		throw new Error("gateway approval fence was replaced mid-publish");
	const descriptor = openSync(path, "w", 0o600);
	try {
		writeSync(descriptor, JSON.stringify({ ...held, state: "PUBLISHED" }));
	} finally {
		closeSync(descriptor);
	}
}

/** Predicated release: only unlinks when the record still names this owner
 * and token. A replaced or expired record is left for stale-break; a crashed
 * holder's lease is bounded by expiry either way. */
export function releaseApprovalFence(
	staging: string,
	label: string,
	owner: FenceOwner,
	token: string,
): void {
	const path = approvalFencePath(staging, label);
	let held: ApprovalFence;
	try {
		held = readFence(path);
	} catch {
		return; // absent record: nothing to release
	}
	if (
		held.pid !== owner.pid ||
		held.birth !== owner.birth ||
		held.token !== token
	)
		return; // replaced record: stale-break or expiry owns it now
	unlinkSync(path);
}

/** The lifecycle-boundary check the fenced loader presents: the label's fence
 * must exist, parse, name a live unexpired owner — otherwise bootout/bootstrap
 * of the governed gateway is refused and the running service stays untouched. */
export function assertFenceForLifecycle(
	staging: string,
	label: string,
	options: { now?: () => number; inspect?: FenceInspect } = {},
): ApprovalFence {
	const path = approvalFencePath(staging, label);
	let held: ApprovalFence;
	try {
		held = readFence(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(
				"gateway lifecycle action requires the approval fence; bootout refused",
			);
		throw error;
	}
	const inspect = options.inspect ?? processBirth;
	const now = options.now ?? Date.now;
	const current = inspect(held.pid);
	const comparison = current
		? compareProcessBirth(held.birth, current.birth)
		: "unknown";
	if (current === false || comparison === "different")
		throw new Error("gateway approval fence owner is dead; bootout refused");
	if (!current || comparison === "unknown")
		throw new Error(
			"gateway approval fence owner identity unknown; bootout refused",
		);
	if (now() > held.expiresAt)
		throw new Error("gateway approval fence expired; bootout refused");
	return held;
}
