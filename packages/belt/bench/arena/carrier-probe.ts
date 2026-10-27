// carrier-probe.ts — W1244: review-leg carrier A/B. The fleet's work.review
// legs (review-lane.ts requestLlm, W1236) fail on glm-5.3-flash with HTTP 200
// + empty content — the reasoning burn eats the completion budget. This probe
// fires the EXACT failing shape (oracle REVIEW_FRAME + a real landed diff) at
// the candidate carriers and measures what the row in benchmarks.md needs:
// verdict-line extraction, the W1236 empty-content negative, latency, tokens
// and price. Credentials come ONLY from machine config (env first, then the
// 0600 files) — never hardcoded; a leg without credentials prints a skip line
// so the harness stays runnable everywhere.
//
// usage: bun carrier-probe.ts [--legs glm,kimi,highspeed] [--max-tokens N]
//        [--diff-commit SHA] [--repo DIR] [--stress] [--json]
// env:   OPENROUTER_API_KEY | ~/.claude/local-llm/openrouter.key
//        MOONSHOT_API_KEY (kimi-k3.1-pro-highspeed direct leg)
//        BUCKLE_ADMIN_KEY | belt.env (glm legs ride the buckle front, as the
//        review legs do)

import {
	adminKey,
	BUCKLE_FRONT,
	mintLaneKey,
	revokeLaneKey,
} from "@klh/suspenders/hooks/lib/lanes/lane-auth.ts";
import { REVIEW_FRAME } from "@klh/suspenders/hooks/lib/oracle-frame.ts";
import { parseVerdictLine } from "./review-parse.ts";

export interface LegResult {
	leg: string;
	model: string;
	route: string;
	maxTokens: number;
	/** "ok" | "empty-content" | "http" | "skip" | "error" */
	status: string;
	wallMs: number;
	finishReason: string | null;
	contentChars: number;
	promptTokens: number | null;
	completionTokens: number | null;
	reasoningTokens: number | null;
	costUsd: number | null;
	verdict: string | null;
	verdictReason: string | null;
	error: string | null;
}

/** The exact failing shape: oracle fixed contract + DIFF (review-lane assembles
 *  the same frame; the diff rides whole — no cap — per requestLlm). */
export const buildReviewPrompt = (diff: string): string =>
	`${REVIEW_FRAME}\n\nDIFF:\n${diff}`;

/** W1236 negative: HTTP 200 with empty content is a leg FAILURE, never a
 *  verdict — finish_reason + completion tokens go into the diagnostic. */
export const emptyContentFailure = (o: {
	content: string | null | undefined;
	finishReason?: string | null;
	completionTokens?: number | null;
}): string | null => {
	if ((o.content ?? "").trim() !== "") return null;
	const fr = o.finishReason ?? "unknown";
	const ct =
		o.completionTokens === undefined
			? ""
			: `, completion_tokens=${o.completionTokens}`;
	return `review leg returned empty content (finish_reason=${fr}${ct})`;
};

/** Cost from an OpenAI-wire usage blob + $/M pricing. OpenRouter reports
 *  usage.cost directly — prefer it; the math is the fallback for routes that
 *  do not (prices are data, re-verified live by --price-check). */
export const tokenCostUsd = (o: {
	usageCost?: number | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
	promptUsdPerM: number;
	completionUsdPerM: number;
}): number | null => {
	if (typeof o.usageCost === "number") return o.usageCost;
	if (o.promptTokens === null || o.completionTokens === null) return null;
	return (
		(o.promptTokens / 1_000_000) * o.promptUsdPerM +
		(o.completionTokens / 1_000_000) * o.completionUsdPerM
	);
};

/** One OpenAI-wire chat/completions call shaped exactly like requestLlm
 *  (plus the optional reasoning knob — the W770 lever that fixed glm on the
 *  :4100 zai rows; "none" excludes reasoning entirely). */
const chatCompletion = async (o: {
	url: string;
	key: string;
	model: string;
	prompt: string;
	maxTokens: number;
	reasoning?: "low" | "none";
	timeoutMs?: number;
}): Promise<{
	resp: Response;
	body: {
		choices?: {
			finish_reason?: string | null;
			message?: { content?: string | null };
		}[];
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			cost?: number;
			completion_tokens_details?: { reasoning_tokens?: number };
		};
		error?: { message?: string };
	};
}> => {
	const payload: Record<string, unknown> = {
		model: o.model,
		messages: [{ role: "user", content: o.prompt }],
		max_tokens: o.maxTokens,
		temperature: 0.2,
	};
	if (o.reasoning === "low") payload.reasoning = { effort: "low" };
	if (o.reasoning === "none") payload.include_reasoning = false;
	const resp = await fetch(o.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${o.key}`,
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(o.timeoutMs ?? 15 * 60_000),
	});
	const body = (await resp.json().catch(() => ({}))) as object;
	return { resp, body: body as never };
};

const openRouterKey = async (): Promise<string | null> => {
	if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
	const path = `${process.env.HOME}/.claude/local-llm/openrouter.key`;
	return (
		(
			await Bun.file(path)
				.text()
				.catch(() => null)
		)?.trim() ?? null
	);
};

const skip = (
	leg: string,
	model: string,
	route: string,
	why: string,
): LegResult => ({
	leg,
	model,
	route,
	maxTokens: 0,
	status: "skip",
	wallMs: 0,
	finishReason: null,
	contentChars: 0,
	promptTokens: null,
	completionTokens: null,
	reasoningTokens: null,
	costUsd: null,
	verdict: null,
	verdictReason: why,
	error: null,
});

const legGlm = async (o: {
	prompt: string;
	maxTokens: number;
}): Promise<LegResult> => {
	const admin = adminKey();
	if (!admin)
		return skip("glm", "glm-5.3-flash", "buckle", "no BUCKLE_ADMIN_KEY");
	const sid = `carrier-probe-${crypto.randomUUID().slice(0, 8)}`;
	const minted = await mintLaneKey(sid, admin);
	if (!minted)
		return skip("glm", "glm-5.3-flash", "buckle", "key mint refused");
	const t0 = performance.now();
	let result: LegResult;
	try {
		const { resp, body } = await chatCompletion({
			url: `${BUCKLE_FRONT}/w/${sid}/v1/chat/completions`,
			key: minted.key,
			model: "glm-5.3-flash",
			prompt: o.prompt,
			maxTokens: o.maxTokens,
		});
		result = readLeg({
			leg: `glm-${o.maxTokens}`,
			model: "glm-5.3-flash",
			route: `buckle ${BUCKLE_FRONT}`,
			maxTokens: o.maxTokens,
			resp,
			body,
			wallMs: performance.now() - t0,
			promptTokens: body.usage?.prompt_tokens ?? null,
		});
	} finally {
		if (!(await revokeLaneKey(minted.keyId, admin)))
			console.error(
				`WARN: probe key ${minted.keyId} revoke failed (TTL bounds it)`,
			);
	}
	return result;
};

const legOpenRouter = async (o: {
	prompt: string;
	maxTokens: number;
	model: string;
	leg: string;
	reasoning?: "low" | "none";
}): Promise<LegResult> => {
	const key = await openRouterKey();
	if (!key) return skip(o.leg, o.model, "openrouter", "no OPENROUTER key");
	const t0 = performance.now();
	const { resp, body } = await chatCompletion({
		url: "https://openrouter.ai/api/v1/chat/completions",
		key,
		model: o.model,
		prompt: o.prompt,
		maxTokens: o.maxTokens,
		reasoning: o.reasoning,
	});
	return readLeg({
		leg: o.leg,
		model: o.model,
		route: "openrouter",
		maxTokens: o.maxTokens,
		resp,
		body,
		wallMs: performance.now() - t0,
		promptTokens: body.usage?.prompt_tokens ?? null,
	});
};

/** One OpenAI-wire leg → the measured row (W1236 rule applied). */
export const readLeg = (o: {
	leg: string;
	model: string;
	route: string;
	maxTokens: number;
	resp: Response;
	body: never;
	wallMs: number;
	promptTokens: number | null;
}): LegResult => {
	const b = o.body as {
		choices?: {
			finish_reason?: string | null;
			message?: { content?: string | null };
		}[];
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			cost?: number;
			completion_tokens_details?: { reasoning_tokens?: number };
		};
		error?: { message?: string };
	};
	const base: LegResult = {
		leg: o.leg,
		model: o.model,
		route: o.route,
		maxTokens: o.maxTokens,
		status: "ok",
		wallMs: Math.round(o.wallMs),
		finishReason: b.choices?.[0]?.finish_reason ?? null,
		contentChars: b.choices?.[0]?.message?.content?.length ?? 0,
		promptTokens: o.promptTokens,
		completionTokens: b.usage?.completion_tokens ?? null,
		reasoningTokens:
			b.usage?.completion_tokens_details?.reasoning_tokens ?? null,
		costUsd: b.usage?.cost ?? null,
		verdict: null,
		verdictReason: null,
		error: null,
	};
	if (!o.resp.ok) {
		base.status = "http";
		base.error = `HTTP ${o.resp.status}: ${(b.error?.message ?? "").slice(0, 200)}`;
		return base;
	}
	const content = b.choices?.[0]?.message?.content ?? "";
	const empty = emptyContentFailure({
		content,
		finishReason: base.finishReason,
		completionTokens: base.completionTokens,
	});
	if (empty) {
		base.status = "empty-content";
		base.error = empty;
		return base;
	}
	const v = parseVerdictLine(content);
	base.verdict = v.verdict;
	base.verdictReason = v.reason;
	return base;
};

const row = (r: LegResult): string =>
	[
		r.leg.padEnd(14),
		r.status.padEnd(14),
		`${r.wallMs}ms`.padStart(9),
		`in=${r.promptTokens ?? "?"}`.padStart(12),
		`out=${r.completionTokens ?? "?"}`.padStart(10),
		`think=${r.reasoningTokens ?? "?"}`.padStart(12),
		`$${r.costUsd?.toFixed(4) ?? "?"}`.padStart(9),
		`verdict=${r.verdict ?? "-"}`.padEnd(14),
		r.error ?? r.verdictReason ?? "",
	].join(" ");

// full patch vs FIRST PARENT — `git show <merge>` emits the (usually empty)
// combined patch, which silently hands the models a frame-only prompt;
// the review legs carry the item branch diff, which is first-parent
const gitDiff = (sha: string, dir: string): string => {
	const p = Bun.spawnSync(["/usr/bin/git", "diff", `${sha}^1`, sha], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`git diff ${sha} failed`);
	return p.stdout.toString();
};

/** The 1M-context stress prompt: deterministic filler to ~target tokens plus
 *  the review frame + a small diff — measures context handling, not quality. */
export const stressPrompt = (diff: string, targetTokens: number): string => {
	const line =
		"filler line for context padding, deterministic and repeating 12345\n";
	const need = Math.max(0, targetTokens - Math.ceil(diff.length / 4) - 200);
	const pad = line.repeat(Math.ceil(need / 9)).slice(0, need * 4);
	return `${REVIEW_FRAME}\n\nPADDING (ignore its content):\n${pad}\n\nDIFF:\n${diff}`;
};

// ---- CLI ---------------------------------------------------------------------
export const main = async (): Promise<void> => {
	const argv = Bun.argv.slice(2);
	const flag = (name: string): string | null => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? null) : null;
	};
	const legsArg = (flag("--legs") ?? "glm,kimi").split(",");
	const defaultMax = Number(flag("--max-tokens") ?? 0);
	const repo = flag("--repo") ?? process.cwd();
	// W276 supervisor-plane landing: a realistic LARGE review diff (916 insertions,
	// 7 files) — the shape the failing review legs actually carried
	const diffCommit = flag("--diff-commit") ?? "4a58625a";
	const stress = argv.includes("--stress");
	const jsonOut = argv.includes("--json");
	const priceCheck = argv.includes("--price-check");

	const diff = gitDiff(diffCommit, repo);
	const prompt = buildReviewPrompt(diff);
	console.error(
		`carrier-probe: diff ${diffCommit} = ${diff.length} chars; legs=${legsArg.join(",")}${stress ? " +stress" : ""}`,
	);

	if (priceCheck) {
		const r = await fetch("https://openrouter.ai/api/v1/models");
		const j = (await r.json()) as {
			data?: {
				id: string;
				context_length?: number;
				pricing?: Record<string, string>;
			}[];
		};
		const m = j.data?.find((x) => x.id === "moonshotai/kimi-k3.1-pro");
		console.error(
			`price-check: moonshotai/kimi-k3.1-pro prompt=$${m?.pricing?.prompt}/tok completion=$${m?.pricing?.completion}/tok cache_read=$${m?.pricing?.input_cache_read}/tok ctx=${m?.context_length ?? "?"}`,
		);
	}

	const results: LegResult[] = [];
	for (const leg of legsArg) {
		if (leg === "glm") {
			for (const mt of defaultMax ? [defaultMax] : [1500, 8000]) {
				const r = await legGlm({ prompt, maxTokens: mt }).catch((e: unknown) =>
					skip(
						`glm-${mt}`,
						"glm-5.3-flash",
						"buckle",
						`error: ${String(e).slice(0, 120)}`,
					),
				);
				results.push(r);
				console.error(row(r));
			}
		} else if (leg === "kimi") {
			const reasoning = (flag("--reasoning") ?? "") as "" | "low" | "none";
			const suffix = reasoning ? `-${reasoning}` : "";
			for (const mt of defaultMax ? [defaultMax] : [1500, 8000]) {
				const r = await legOpenRouter({
					prompt,
					maxTokens: mt,
					model: "moonshotai/kimi-k3.1-pro",
					leg: `kimi${suffix}-${mt}`,
					reasoning: reasoning || undefined,
				}).catch((e: unknown) =>
					skip(
						`kimi${suffix}-${mt}`,
						"moonshotai/kimi-k3.1-pro",
						"openrouter",
						`error: ${String(e).slice(0, 120)}`,
					),
				);
				results.push(r);
				console.error(row(r));
			}
		} else if (leg === "highspeed") {
			const key = process.env.MOONSHOT_API_KEY ?? null;
			if (!key) {
				const r = skip(
					"highspeed",
					"kimi-k3.1-pro-highspeed",
					"moonshot-direct",
					"no MOONSHOT_API_KEY (Moonshot direct leg unprobed)",
				);
				results.push(r);
				console.error(row(r));
			} else {
				const t0 = performance.now();
				const { resp, body } = await chatCompletion({
					url: "https://api.moonshot.ai/v1/chat/completions",
					key,
					model: "kimi-k3.1-pro-highspeed",
					prompt,
					maxTokens: defaultMax || 8000,
				});
				const r = readLeg({
					leg: "highspeed",
					model: "kimi-k3.1-pro-highspeed",
					route: "moonshot-direct",
					maxTokens: defaultMax || 8000,
					resp,
					body,
					wallMs: performance.now() - t0,
					promptTokens: body.usage?.prompt_tokens ?? null,
				});
				results.push(r);
				console.error(row(r));
			}
		} else {
			console.error(`unknown leg: ${leg}`);
		}
	}

	if (stress) {
		const p = stressPrompt(diff, 780_000);
		console.error(
			`stress: padded prompt = ${p.length} chars (~${Math.ceil(p.length / 4)} tokens)`,
		);
		const r = await legOpenRouter({
			prompt: p,
			maxTokens: 2000,
			model: "moonshotai/kimi-k3.1-pro",
			leg: "kimi-stress",
		}).catch((e: unknown) =>
			skip(
				"kimi-stress",
				"moonshotai/kimi-k3.1-pro",
				"openrouter",
				`error: ${String(e).slice(0, 120)}`,
			),
		);
		results.push(r);
		console.error(row(r));
	}

	if (jsonOut) console.log(JSON.stringify(results, null, 1));
	const ran = results.filter((r) => r.status !== "skip");
	const ok = ran.filter((r) => r.status === "ok" && r.verdict !== null);
	console.error(
		`carrier-probe: ${ok.length}/${ran.length} ran legs returned a verdict`,
	);
	process.exit(ran.length === 0 && results.length > 0 ? 2 : 0);
};

if (import.meta.main) {
	main().catch((e: unknown) => {
		console.error(e);
		process.exit(1);
	});
}
