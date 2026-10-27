// prompt-bench-client.ts — W368 bench HTTP legs, gated (W1119.2): every
// model completion rides the buckle gate (one inference boundary — no
// direct :890x wire, no :4000 router lane). Mirrors the production
// transform client (hooks/board/prompt-transform.ts): max_tokens 400, the
// verbatim ENHANCE_SYS, <think> strip, honest per-leg failure records
// (no retries — a failed leg is data, not something to hide).
import { ENHANCE_SYS } from "../../hooks/board/prompt-transform.ts";
import { buckleChat } from "../../hooks/lib/hub/inference-buckle.ts";

export const BENCH_TIMEOUT_MS = 90_000;

export interface LegResult {
	ok: boolean;
	text: string;
	wallMs: number;
	note: string;
	/** the model identity the gate reported serving, when known */
	servedModel: string | null;
}

export const stripThink = (t: string): string =>
	t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

const nonceTag = (nonce: string): string => `\n\n[bench nonce ${nonce}]`;

/** The one gated bench leg: model-as-data through the buckle gate — the
 *  placement is the gate's own routing decision. */
export async function callGate(
	opts: {
		model: string;
		system: string;
		user: string;
		nonce: string;
		maxTokens?: number;
		timeoutMs?: number;
		fetcher?: typeof fetch;
	},
	env: NodeJS.ProcessEnv = process.env,
): Promise<LegResult> {
	const t0 = Date.now();
	const done = (
		ok: boolean,
		text: string,
		note: string,
		servedModel: string | null = null,
	): LegResult => ({
		ok,
		text,
		wallMs: Date.now() - t0,
		note,
		servedModel,
	});
	try {
		const res = await buckleChat(
			{
				model: opts.model,
				system: opts.system,
				user: opts.user + nonceTag(opts.nonce),
				maxTokens: opts.maxTokens ?? 400,
				timeoutMs: opts.timeoutMs ?? BENCH_TIMEOUT_MS,
				fetcher: opts.fetcher,
			},
			env,
		);
		const text = stripThink(res.text);
		if (!text) return done(false, "", "empty", res.model);
		return done(true, text, "ok", res.model);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return done(false, "", `gate failed (${msg.slice(0, 120)})`);
	}
}

export const COMPRESS_SYS =
	"Compress the user's prompt for a coding-agent fleet. Keep every file path, command, flag, identifier, number and constraint exactly. Remove politeness and filler. Output ONLY the compressed prompt.";

export { ENHANCE_SYS as PROD_ENHANCE_SYS };
