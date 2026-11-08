import type { EvidenceSink } from "../gates/claim-evidence.ts";
import type { EvidenceCall } from "./codex-evidence-call.ts";
import {
	MAX_EVIDENCE_OUTPUT,
	type DecodedOutput,
} from "./codex-evidence-output.ts";

/** Only a proven own test can create a PTY lineage. Reads can finish it, never adopt another. */
export function evidenceSessions() {
	const pending = new Map<number, string>();
	return {
		begin(call: EvidenceCall | null) {
			if (!call) pending.clear();
			if (call?.kind === "poll" && !call.readOnly) pending.delete(call.session);
		},
		consume(
			call: EvidenceCall | null,
			decoded: DecodedOutput | null,
			ts: number,
			sink: EvidenceSink,
		) {
			if (!decoded || decoded.kind === "legacy") {
				if (decoded?.kind === "legacy" && call?.kind === "exec" && call.test)
					sink.output(ts, decoded.text);
				if (call?.kind === "poll") pending.delete(call.session);
				return;
			}
			const result = decoded.result;
			let previous = "",
				session = result.session_id;
			if (call?.kind === "poll") {
				if (!call.readOnly) {
					pending.delete(call.session);
					return;
				}
				const known = pending.get(call.session);
				if (known === undefined) return;
				if (session !== undefined && session !== call.session) {
					pending.delete(call.session);
					return;
				}
				previous = known;
				session = call.session;
			} else {
				if (session !== undefined) pending.delete(session);
				if (call?.kind !== "exec" || !call.test) return;
			}
			const combined = previous + result.output;
			if (combined.length > MAX_EVIDENCE_OUTPUT) {
				if (session !== undefined) pending.delete(session);
				return;
			}
			if (typeof result.exit_code === "number") {
				if (session !== undefined) pending.delete(session);
				sink.output(
					ts,
					result.exit_code === 0 ? combined : `0 pass\n1 fail\n${combined}`,
				);
			} else if (result.session_id !== undefined && session !== undefined) {
				pending.set(session, combined);
				if (pending.size > 128) {
					const oldest = pending.keys().next().value;
					if (oldest !== undefined) pending.delete(oldest);
				}
			} else if (session !== undefined) pending.delete(session);
		},
	};
}
