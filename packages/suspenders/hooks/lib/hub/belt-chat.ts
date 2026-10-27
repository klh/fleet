// hooks/lib/hub/belt-chat.ts — W552.6.1: the ONE governed-gateway chat leg for
// control-plane advise/re-evaluate. POST /api/route {execute:true} lets belt
// pick the best healthy target from its own metrics; the reply is VALIDATED —
// a belt placeholder ("(empty response)") or empty text is never mistaken for
// an answer. The caller gets null and degrades to its own fallbacks; provider
// errors stay visible in belt's honest 503 body via the routing log.
import { resolveBelt } from "./belt-locate.ts";

export interface BeltChatRequest {
	// belt routing role ("reasoning" — an advise/re-evaluate fork is a
	// reasoning task; "advise" matches no registry role)
	role?: string;
	system?: string;
	user: string;
	maxTokens?: number;
	temperature?: number;
	timeoutMs?: number;
}

export interface BeltChatResult {
	text: string;
	model: string;
	host: string;
	ms: number;
}

/** One belt-routed chat call, or null (belt unreachable, non-200, or the
 *  reply failing final-text validation). Never throws. */
export async function beltChat(
	req: BeltChatRequest,
): Promise<BeltChatResult | null> {
	const loc = await resolveBelt();
	if (!loc) return null;
	try {
		const r = await fetch(`${loc.url}/api/route`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(loc.token ? { authorization: `Bearer ${loc.token}` } : {}),
			},
			body: JSON.stringify({
				role: req.role ?? "reasoning",
				execute: true,
				max_tokens: req.maxTokens ?? 500,
				temperature: req.temperature ?? 0.2,
				// system + user together — belt executes the full messages array
				messages: [
					...(req.system ? [{ role: "system", content: req.system }] : []),
					{ role: "user", content: req.user },
				],
			}),
			signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
		});
		if (!r.ok) return null;
		const j = (await r.json()) as {
			reply?: string;
			target?: { model?: string; machine?: string };
			ms?: number;
		};
		// final-text validation: empty or the belt "(empty response)"
		// placeholder is NOT an answer — degrade instead of storing it
		const text = typeof j.reply === "string" ? j.reply.trim() : "";
		if (!text || text === "(empty response)") return null;
		return {
			text,
			model: j.target?.model ?? "belt",
			host: `belt(${j.target?.machine ?? "?"})`,
			ms: j.ms ?? 0,
		};
	} catch {
		return null;
	}
}
