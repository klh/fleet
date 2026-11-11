// child-admission.ts — W2973.1: a Pi Durable supervisor delegates a child
// runner through THIS host-side admission, never by driving the controller
// directly. The ledger (runner_child_intents, runner_child_receipts) makes
// admission idempotent across supervisor crashes: the same (parentRunId,
// childKey) pair derives the same runId, rebuilds the same immutable spec,
// and re-admits the EXISTING run — a restart in the window between admission
// and receipt never mints a duplicate guest. Bounds (fan-out, depth) and the
// route entitlement are host-supplied Fleet policy, never agent payload: an
// unentitled route is refused before any admission or executor start.
import { z } from "zod";
import { digestOf } from "./control-state.ts";
import type { RunnerSpec } from "./control-state.ts";
import type { RunnerController } from "./controller.ts";
import type { LeaseToken } from "./leases.ts";
import type { RunnerActor } from "./rights.ts";
import type { RunnerStore } from "./store.ts";

export const ChildIntentSchema = z.strictObject({
	version: z.literal(1),
	parentRunId: z.uuid(),
	supervisorSid: z.string().min(1).max(200),
	childKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
	depth: z.number().int().min(1).max(8),
	route: z.strictObject({
		provider: z.string().min(1).max(120),
		model: z.string().min(1).max(200),
	}),
	kind: z.enum(["coding", "design", "knowledge"]),
	briefDigest: z.string().regex(/^[a-f0-9]{64}$/),
	execution: z
		.strictObject({
			seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
			policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.optional(),
});

export type ChildIntent = z.infer<typeof ChildIntentSchema>;

export interface ChildRoute {
	provider: string;
	model: string;
}

export interface ChildReceipt {
	state: "done" | "failed" | "aborted";
	at: number;
}

const INTENTS_DDL = `
CREATE TABLE IF NOT EXISTS runner_child_intents (
	parent_run_id TEXT NOT NULL,
	child_key TEXT NOT NULL,
	depth INTEGER NOT NULL,
	intent_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (parent_run_id, child_key)
)`;

const RECEIPTS_DDL = `
CREATE TABLE IF NOT EXISTS runner_child_receipts (
	parent_run_id TEXT NOT NULL,
	child_key TEXT NOT NULL,
	receipt_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (parent_run_id, child_key)
)`;

/** Deterministic child runId: sha256 over the (parent, key) pair shaped as
 *  an RFC9562 v4 uuid, so the durable JobSpec's z.uuid() accepts it and the
 *  same delegation derives the same run before AND after a crash. */
export const deriveChildRunId = (
	parentRunId: string,
	childKey: string,
): string => {
	const hex = digestOf(`fleet-child-run-v1:${parentRunId}:${childKey}`);
	const variant = 8 + (Number.parseInt(hex[16] ?? "0", 16) % 4);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant.toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const admitChildRun = async (
	deps: {
		store: RunnerStore;
		controller: Pick<RunnerController, "admit">;
		/** Host-resolved actor of the CALLING supervisor (trust boundary — the
		 *  scopes ride the host credential, never the supervisor's payload). */
		actor: RunnerActor;
		/** Fleet-authoritative route entitlement for delegated children. */
		routes: readonly ChildRoute[];
		/** Digests of the host-approved executor seed and policy. */
		execution?: { seedDigest: string; policyDigest: string };
		/** Host-side reservation after validation, before recording admission. */
		reserveBudget?: () => void;
		/** Digests of the host-approved executor seed and policy. */
		execution?: NonNullable<ChildIntent["execution"]>;
		bounds?: { maxChildren?: number; maxDepth?: number };
		now?: () => number;
	},
	input: {
		parentRunId: string;
		supervisorSid: string;
		childKey: string;
		/** The supervisor's own delegation depth — 1 for a top-level Fleet
		 *  supervisor; the child itself runs at depth + 1. */
		depth?: number;
		kind: "coding" | "design" | "knowledge";
		/** Optional pin onto an entitled route; unpinned children ride the
		 *  allowlist's first entry. */
		route?: ChildRoute;
		/** The exact child brief; must replay byte-identical across crashes. */
		brief: string;
		autoPark?: boolean;
	},
): Promise<{ runId: string; token: LeaseToken; replayed: boolean }> => {
	deps.store.run(INTENTS_DDL);
	const bounds = deps.bounds ?? {};
	const maxChildren = bounds.maxChildren ?? 8;
	const maxDepth = bounds.maxDepth ?? 2;
	const childDepth = (input.depth ?? 1) + 1;
	if (childDepth > maxDepth)
		throw new Error(
			`runner: child depth ${childDepth} exceeds the delegation bound ${maxDepth} (multi-level Pi-to-Pi is a separate treatment)`,
		);
	const route = input.route ?? deps.routes.at(0);
	if (route === undefined)
		throw new Error("runner: no child routes are entitled for delegation");
	const entitled = deps.routes.some(
		(candidate) =>
			candidate.provider === route.provider && candidate.model === route.model,
	);
	if (!entitled)
		throw new Error(
			`runner: route ${route.provider}/${route.model} is outside the delegated allowlist — refused before admission`,
		);
	const intent = ChildIntentSchema.parse({
		version: 1,
		parentRunId: input.parentRunId,
		supervisorSid: input.supervisorSid,
		childKey: input.childKey,
		depth: childDepth,
		route,
		kind: input.kind,
		briefDigest: digestOf(input.brief),
		...(deps.execution ? { execution: deps.execution } : {}),
	});
	const stored = deps.store.get<{ intent_json: string }>(
		"SELECT intent_json FROM runner_child_intents WHERE parent_run_id = ? AND child_key = ?",
		input.parentRunId,
		input.childKey,
	);
	if (stored === null) {
		const siblings = deps.store.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM runner_child_intents WHERE parent_run_id = ?",
			input.parentRunId,
		);
		if ((siblings?.n ?? 0) >= maxChildren)
			throw new Error(
				`runner: parent ${input.parentRunId} is at the delegated fan-out bound of ${maxChildren} children`,
			);
	} else {
		// Replay: the ledger row IS the admission. The same (parent, key)
		// must rebuild the identical intent — any drift (route, depth, kind,
		// brief) refuses here, before the controller sees the run again.
		const prior = ChildIntentSchema.parse(JSON.parse(stored.intent_json));
		if (JSON.stringify(prior) !== JSON.stringify(intent))
			throw new Error(
				"runner: child intent drift on replay — the same parent/child key must replay identically",
			);
	}
	deps.reserveBudget?.();
	if (stored === null) {
		deps.store.run(
			"INSERT INTO runner_child_intents (parent_run_id, child_key, depth, intent_json, created_at) VALUES (?, ?, ?, ?, ?)",
			input.parentRunId,
			input.childKey,
			childDepth,
			JSON.stringify(intent),
			(deps.now ?? (() => Date.now()))(),
		);
	}
	const runId = deriveChildRunId(input.parentRunId, input.childKey);
	const spec: RunnerSpec = {
		version: 1,
		runId,
		owner: input.supervisorSid,
		generation: 1,
		kind: intent.kind,
		seedDigest: intent.execution?.seedDigest ?? intent.briefDigest,
		policyDigest:
			intent.execution?.policyDigest ?? digestOf(JSON.stringify(deps.routes)),
		provider: intent.route.provider,
		model: intent.route.model,
	};
	const { token } = await deps.controller.admit({
		spec,
		actor: deps.actor,
		autoPark: input.autoPark,
	});
	return { runId, token, replayed: stored !== null };
};

/** The receipt is the crash window's end marker: once recorded, a restarted
 *  supervisor re-recording the SAME outcome is an idempotent replay; a
 *  different outcome is a hard refusal — the child ran once, once is truth. */
export const recordChildReceipt = (
	deps: { store: RunnerStore; now?: () => number },
	input: { parentRunId: string; childKey: string; receipt: ChildReceipt },
): { replayed: boolean } => {
	deps.store.run(RECEIPTS_DDL);
	const payload = JSON.stringify(input.receipt);
	const stored = deps.store.get<{ receipt_json: string }>(
		"SELECT receipt_json FROM runner_child_receipts WHERE parent_run_id = ? AND child_key = ?",
		input.parentRunId,
		input.childKey,
	);
	if (stored !== null) {
		if (stored.receipt_json !== payload)
			throw new Error(
				"runner: child receipt already recorded with a different outcome",
			);
		return { replayed: true };
	}
	deps.store.run(
		"INSERT INTO runner_child_receipts (parent_run_id, child_key, receipt_json, created_at) VALUES (?, ?, ?, ?)",
		input.parentRunId,
		input.childKey,
		payload,
		(deps.now ?? (() => Date.now()))(),
	);
	return { replayed: false };
};
