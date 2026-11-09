/**
 * pi-durable-workers — approvals document + gate.
 *
 * beforeTool gate: a call to a tool in `requireFor` without an approved
 * request is blocked with its request id, and a pending ApprovalRequest is
 * appended to the ApprovalsDoc — a durable fact that survives restarts.
 * The host surfaces pending approvals as plane events so the cockpit fiddle
 * renders them and the owner approves from there (W2888 pattern table).
 */

import { randomUUID } from "node:crypto";
import type { Context, HookApi } from "@earendil-works/pi-durable";
import {
	type ApprovalRequest,
	ApprovalsDoc,
	type ApprovalsState,
} from "./docs.ts";

/** Block payload from `beforeTool`; the first block wins. */
export type ApprovalBlock = { block: string };

function matches(tool: string, requireFor: readonly string[]): boolean {
	return requireFor.includes("*") || requireFor.includes(tool);
}

export async function approvalsBeforeTool(
	call: { name: string; arguments: unknown },
	api: HookApi,
	context: Context,
	onPending?: (req: ApprovalRequest) => void,
): Promise<ApprovalBlock | undefined> {
	const approvals =
		((await api.snapshot(ApprovalsDoc, api.conversationId, context)) as
			| ApprovalsState
			| undefined) ?? ({ requests: [], requireFor: [] } as ApprovalsState);
	if (!matches(call.name, approvals.requireFor)) return undefined;
	const approved = approvals.requests.find(
		(r) =>
			r.tool === call.name &&
			r.status === "approved" &&
			r.argsPreview === preview(call.arguments),
	);
	if (approved) return undefined;
	const existing = approvals.requests.find(
		(r) =>
			r.tool === call.name &&
			r.status === "pending" &&
			r.argsPreview === preview(call.arguments),
	);
	if (existing) {
		return {
			block: `[approvals] ${call.name} awaits approval (request ${existing.id}). Ask the operator or change arguments.`,
		};
	}
	const req: ApprovalRequest = {
		id: `apr-${randomUUID().slice(0, 8)}`,
		tool: call.name,
		argsPreview: preview(call.arguments),
		at: Date.now(),
		status: "pending",
	};
	// Hooks cannot commit (HookApi is read-side); the pending record is raised
	// through the host callback, which commits on the Session line.
	onPending?.(req);
	return {
		block: `[approvals] ${call.name} requires approval — request ${req.id} raised. Retry once approved.`,
	};
}

function preview(args: unknown): string {
	const s = JSON.stringify(args) ?? "{}";
	return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

// ---------- host-side decision API (committed on the Session line) ----------

export type ApprovalsWriter = {
	/** Configure which tools require approval. */
	readonly requireFor: (
		tools: readonly string[],
		context: Context,
	) => Promise<void>;
	/** Record a decision; returns false when the id is unknown. */
	readonly decide: (
		id: string,
		decision: "approved" | "denied",
		context: Context,
	) => Promise<boolean>;
	/** Pending requests, oldest first. */
	readonly pending: (context: Context) => Promise<ApprovalRequest[]>;
	/** Raise a pending request from a hook (commit wrapper supplied by the runtime). */
	readonly raise: (req: ApprovalRequest, context: Context) => Promise<void>;
};

export function createApprovalsWriter(
	commit: (
		change: (doc: {
			requests: ApprovalRequest[];
			requireFor: string[];
		}) => Promise<void> | void,
		context: Context,
	) => Promise<void>,
	read: (
		context: Context,
	) => Promise<{
		requests: readonly ApprovalRequest[];
		requireFor: readonly string[];
	}>,
): ApprovalsWriter {
	return {
		requireFor: async (tools, context) => {
			await commit(async (doc) => {
				doc.requireFor = [...tools];
			}, context);
		},
		decide: async (id, decision, context) => {
			const state = await read(context);
			if (!state.requests.some((r) => r.id === id)) return false;
			await commit(async (doc) => {
				const requests = [...doc.requests];
				const i = requests.findIndex((r) => r.id === id);
				if (i >= 0)
					requests[i] = {
						...requests[i],
						status: decision,
						decidedAt: Date.now(),
					};
				doc.requests = requests;
			}, context);
			return true;
		},
		pending: async (context) => {
			const state = await read(context);
			return state.requests
				.filter((r) => r.status === "pending")
				.sort((a, b) => a.at - b.at);
		},
		raise: async (req, context) => {
			await commit(async (doc) => {
				doc.requests = [...doc.requests, req];
			}, context);
		},
	};
}
