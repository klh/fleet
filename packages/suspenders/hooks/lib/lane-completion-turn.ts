// hooks/lib/lane-completion-turn.ts — W1124.13: the logical assistant turn
// behind a Stop invocation. Native re-ask loops replay the SAME last
// assistant message (verified on W1124.8.2.2: one UUID preceded Re-asks 2/3
// and again 4/5/6, one user Stop wire, no project/lane duplicates), so the
// turn key is the latest assistant identity from a bounded transcript tail —
// never the hook invocation count. The activation scope (sid/item/launchedAt)
// is hashed in so a relaunched lane never inherits a prior episode's turn.
// No prompt or reasoning content is persisted — identities and verdicts only.
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import type { HookInput } from "./hookio.ts";
import { resolveTranscriptPath, transcriptTail } from "./transcript.ts";

type Activation = { sid: string; item: string; launchedAt?: number };

export type CompletionTurn = {
	id: string;
	usable: boolean;
	reason: string | null;
};

const TAIL_BYTES = 512 * 1024;

/** The latest native assistant row's identity, read from the bounded tail.
 * The NEWEST assistant wins even when it is an API-error/synthetic or empty
 * frame — those are operational missing-output evidence, never a fallback to
 * an older productive turn. Partial tail lines (a single row can exceed the
 * bound) fail JSON.parse and scan past. */
export function completionTurn(
	hook: HookInput,
	activation: Activation,
): CompletionTurn {
	const scope = JSON.stringify([
		activation.sid,
		activation.item,
		activation.launchedAt ?? null,
	]);
	const finish = (native: string, usable: boolean, reason: string | null) => ({
		id: createHash("sha256")
			.update(scope)
			.update("\0")
			.update(native)
			.digest("hex"),
		usable,
		reason,
	});
	const path = resolveTranscriptPath(hook);
	if (!path) return finish("missing", false, "transcript_unresolved");
	const lines = transcriptTail(path, TAIL_BYTES).split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		let row: Record<string, unknown>;
		try {
			row = JSON.parse(lines[i] ?? "") as Record<string, unknown>;
		} catch {
			continue;
		}
		if (row.type !== "assistant") continue;
		const message =
			row.message && typeof row.message === "object"
				? (row.message as Record<string, unknown>)
				: {};
		const identity =
			typeof message.id === "string"
				? message.id
				: typeof row.uuid === "string"
					? row.uuid
					: "";
		if (!identity || identity.length > 256)
			return finish("missing", false, "assistant_identity_unreadable");
		const ts =
			typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
		if (
			Number.isFinite(ts) &&
			activation.launchedAt &&
			ts < activation.launchedAt
		)
			return finish("missing", false, "assistant_predates_activation");
		if (row.isApiErrorMessage === true || row.isSynthetic === true)
			return finish(identity, false, "assistant_api_error");
		const blocks = Array.isArray(message.content) ? message.content : [];
		const usable = blocks.some((value) => {
			if (!value || typeof value !== "object") return false;
			const block = value as Record<string, unknown>;
			return (
				(block.type === "text" &&
					typeof block.text === "string" &&
					block.text.trim().length > 0) ||
				(block.type === "tool_use" &&
					typeof block.name === "string" &&
					block.name.length > 0)
			);
		});
		return finish(identity, usable, usable ? null : "assistant_missing_output");
	}
	return finish("missing", false, "assistant_not_observed");
}

/** The attempt counter, turn identity and exact continuation reply commit as
 * ONE atomic record — no crash window can spend an attempt without caching
 * its decision. reply === undefined omits the key so duplicate turns keep
 * retrying a failed operational publication instead of caching silence. */
export function writeCompletionTurn(
	marker: string,
	state: Record<string, unknown>,
	turn: CompletionTurn,
	reply?: string | null,
): void {
	const tmp = `${marker}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ ...state, turnId: turn.id, reply }), {
		mode: 0o600,
	});
	renameSync(tmp, marker);
}
