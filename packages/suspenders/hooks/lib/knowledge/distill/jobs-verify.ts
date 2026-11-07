// distill/jobs-verify.ts — the job that re-checks a session-derived
// knowledge entry against its own origin transcript (decant.db): the
// entry's `origin_sid` resolves to the decant session that produced it, a
// bounded text-block excerpt is read, and ONE chat judgment decides:
//   contradicted | gone → stale mark + sink.propose (retire-or-correct)
//   supported         → the runner's normal visit stamp, no other write
// Transcript text lives only for this one call — it never lands in the
// graph or a knowledge row (decant.ts header law). IKEA-origin entries
// (topic `finding.ikea*` or origin_system `ikea`) never leave the machine:
// outcome `skip:local-only`, no chat call.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { jsonObject } from "./clients.ts";
import type { Unit } from "./context.ts";
import {
	isIkeaLocal,
	knowledgeIdOf,
	knowledgeRow,
	scrubbed,
	sha,
} from "./sink.ts";

export const VerifyVerdictSchema = z
	.object({
		verdict: z.enum(["supported", "contradicted", "gone"]),
		reason: z.string().max(400).default(""),
	})
	.loose();

const VERIFY_SYSTEM =
	'You re-check one engineering knowledge entry against an excerpt of the agent session it was derived from. Answer ONLY a JSON object {"verdict": "supported"|"contradicted"|"gone", "reason": string}. supported = the excerpt still backs the entry. contradicted = the excerpt now shows the opposite or a correction. gone = the excerpt has nothing, positive or negative, to check the entry against. Never invent anything the excerpt does not say.';

const STALE_REASON: Record<"contradicted" | "gone", string> = {
	contradicted: "verify: origin transcript contradicts this fact (distill)",
	gone: "verify: origin transcript no longer supports this fact (distill)",
};

/** top priority: unlike dedupe/contradiction (edge-weight scored), a
 *  transcript-sourced contradiction has no similarity score to decay by. */
const VERIFY_PROPOSAL_SCORE = 1;

/** Bounded, scrubbed transcript excerpt for one decant session, or null when
 *  the session or its text blocks are missing. Read-only; the text returned
 *  here is used for ONE chat call and is never persisted. */
export function originTranscript(
	dc: Database,
	originSid: string,
	maxChars: number,
): string | null {
	const session = dc
		.query(
			"SELECT id FROM session WHERE source_session_id = ? ORDER BY id DESC LIMIT 1",
		)
		.get(originSid) as { id: number } | null;
	if (!session) return null;
	const rows = dc
		.query(
			"SELECT m.role AS role, b.text AS text FROM block b JOIN message m ON m.id = b.message_id WHERE b.session_id = ? AND b.type = 'text' AND b.text IS NOT NULL AND b.text != '' ORDER BY m.seq, b.ordinal LIMIT 800",
		)
		.all(session.id) as { role: string | null; text: string }[];
	let out = "";
	for (const r of rows) {
		const line = `${r.role ?? "?"}: ${r.text}\n`;
		if (out.length + line.length > maxChars) break;
		out += line;
	}
	return out ? scrubbed(out) : null;
}

export const verifyUnit: Unit = async (ctx, node) => {
	const kid = knowledgeIdOf(node.ref);
	const row = kid === null ? null : knowledgeRow(ctx.db, kid);
	if (!row) return { outcome: "missing" };
	if (!row.origin_sid) return { outcome: "skip:no-origin" };
	if (isIkeaLocal(row)) return { outcome: "skip:local-only" };
	if (!ctx.decant) return { outcome: "skip:no-decant" };
	const transcript = originTranscript(
		ctx.decant,
		row.origin_sid,
		ctx.cfg.verify_transcript_chars,
	);
	if (!transcript) return { outcome: "skip:no-transcript" };
	const sig = sha(`${node.hash ?? ""}\0${sha(transcript)}`);
	const prior = ctx.db
		.query(
			"SELECT sig, verdict FROM distill_pairs WHERE a = ? AND b = ? AND job = 'verify'",
		)
		.get(node.id, node.id) as { sig: string; verdict: string } | null;
	if (prior?.sig === sig) return { outcome: `cached:${prior.verdict}` };
	ctx.spend.check();
	const res = await ctx.clients.chat.complete(
		VERIFY_SYSTEM,
		`[entry] ${row.topic}\n${row.fact}\n\n[origin session excerpt]\n${transcript}`,
		300,
	);
	ctx.spend.add(res.tokens);
	const parsed = VerifyVerdictSchema.safeParse(jsonObject(res.content));
	const verdict = parsed.success ? parsed.data.verdict : "unparsed";
	ctx.db
		.query(
			"INSERT INTO distill_pairs (a, b, job, sig, verdict, at) VALUES (?, ?, 'verify', ?, ?, ?) ON CONFLICT (a, b, job) DO UPDATE SET sig = excluded.sig, verdict = excluded.verdict, at = excluded.at",
		)
		.run(node.id, node.id, sig, verdict, ctx.now());
	if (!parsed.success) return { outcome: "unparsed", tokens: res.tokens };
	if (parsed.data.verdict === "supported")
		return { outcome: "supported", tokens: res.tokens };
	if (row.stale_at === null)
		ctx.db
			.query("UPDATE knowledge SET stale_at = ?, stale_reason = ? WHERE id = ?")
			.run(ctx.now(), STALE_REASON[parsed.data.verdict], row.id);
	ctx.sink.propose({
		knowledgeId: row.id,
		kind: "distill-verify",
		score: VERIFY_PROPOSAL_SCORE,
		reason: `${parsed.data.verdict}: ${parsed.data.reason}`.slice(0, 500),
		payload: { verdict: parsed.data.verdict, reason: parsed.data.reason },
	});
	return { outcome: parsed.data.verdict, tokens: res.tokens };
};
