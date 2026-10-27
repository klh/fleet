// hooks/lib/knowledge-inference.ts — W1229: the ONE inference transport for
// the knowledge/memory lifecycle. Lifecycle LLM calls (distill today;
// consolidate + recall rank when their faces land) enter the Buckle front on
// the knowledge worker's scoped bksk_ key with EXPLICIT budgets and a W3C
// traceparent so every call lands a joinable route_audit row (trace_id).
// Lifecycle embeddings go to the :8907 specialist directly (the gate exposes
// no /v1/embeddings route) — batched, never one POST per text. Writes drain
// behind a bounded async queue with a flush barrier recall consumers await
// before searching (wait-before-recall: recall never races a pending save).
//
// Traffic cap doctrine: added model traffic is capped per PROCESS here (rpm
// ring + in-flight concurrency) and fleet-wide by the key's Buckle budget
// books (gov/middleware.ts 429s). 40 lanes each amplifying memory analysis
// is the known failure mode — a caller needing more capacity raises
// SUSPENDERS_MEMORY_RPM deliberately, it never queues unbounded.
//
// env knobs (config-over-code; defaults sane for the Mac knowledge worker):
//   SUSPENDERS_MEMORY_RPM           lifecycle requests per rolling 60s (20)
//   SUSPENDERS_MEMORY_CONCURRENCY   max in-flight lifecycle calls (2)
//   SUSPENDERS_MEMORY_MAX_TOKENS    per-call completion cap (1600)
//   SUSPENDERS_MEMORY_WAIT_MS       bounded wait for a budget slot (30000)
//   SUSPENDERS_MEMORY_EMBED_URL     embeddings endpoint
//                                   (http://127.0.0.1:8907/v1/embeddings)
//   SUSPENDERS_MEMORY_EMBED_MODEL   embeddings body model (local-embed)
//   SUSPENDERS_MEMORY_EMBED_BATCH   texts per embeddings POST (32, ≤128)
//   SUSPENDERS_MEMORY_EMBED_TOKEN   optional bearer for hub embed routes
import { knowledgeBuckleRoute } from "./knowledge-buckle.ts";

// ─── knobs ────────────────────────────────────────────────────────────────
const clampNum = (
	v: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number => {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
};

export interface MemoryLimits {
	rpm: number;
	concurrency: number;
	maxTokens: number;
	waitMs: number;
	embedUrl: string;
	embedModel: string;
	embedBatch: number;
	embedToken: string | null;
}

// parse + clamp the knobs; empty/absent falls back ("" must never Number()
// to 0 and silently disable a cap)
export function memoryLimits(
	env: NodeJS.ProcessEnv = process.env,
): MemoryLimits {
	return {
		rpm: clampNum(env.SUSPENDERS_MEMORY_RPM, 20, 1, 600),
		concurrency: clampNum(env.SUSPENDERS_MEMORY_CONCURRENCY, 2, 1, 8),
		maxTokens: clampNum(env.SUSPENDERS_MEMORY_MAX_TOKENS, 1600, 128, 8192),
		waitMs: clampNum(env.SUSPENDERS_MEMORY_WAIT_MS, 30_000, 0, 120_000),
		embedUrl:
			env.SUSPENDERS_MEMORY_EMBED_URL ?? "http://127.0.0.1:8907/v1/embeddings",
		embedModel: env.SUSPENDERS_MEMORY_EMBED_MODEL ?? "local-embed",
		embedBatch: clampNum(env.SUSPENDERS_MEMORY_EMBED_BATCH, 32, 1, 128),
		embedToken: env.SUSPENDERS_MEMORY_EMBED_TOKEN ?? null,
	};
}

// ─── per-process budget: rpm ring + in-flight concurrency ────────────────
// Same ring shape as Buckle's budgets.ts, client-side and request-based
// (token accounting stays server-side — the gate owns the books).
export class MemoryBudget {
	private reqSlots = new Int32Array(60);
	private head = 0;
	private reqSum = 0;
	private lastSec = 0;
	private inflight = 0;

	constructor(
		private readonly rpm: number,
		private readonly concurrency: number,
		private readonly now: () => number = Date.now,
	) {
		this.lastSec = Math.floor(this.now() / 1000);
	}

	private advance(sec: number): void {
		const gap = sec - this.lastSec;
		if (gap <= 0) return;
		if (gap >= 60) {
			this.reqSlots.fill(0);
			this.reqSum = 0;
		} else {
			// step into the next second, then expire what that slot held 60s ago
			for (let i = 0; i < gap; i++) {
				const h = (this.head + 1) % 60;
				this.reqSum -= this.reqSlots[h] ?? 0;
				this.reqSlots[h] = 0;
				this.head = h;
			}
		}
		this.lastSec = sec;
	}

	/** A slot is free? Consume it (release() when the call settles). */
	tryAdmit(): boolean {
		this.advance(Math.floor(this.now() / 1000));
		if (this.inflight >= this.concurrency) return false;
		if (this.reqSum >= this.rpm) return false;
		this.reqSum += 1;
		const h = this.head;
		this.reqSlots[h] = (this.reqSlots[h] ?? 0) + 1;
		this.inflight += 1;
		return true;
	}

	release(): void {
		this.inflight = Math.max(0, this.inflight - 1);
	}
}

// ─── W3C trace context (same 00-traceid(32)-span(16)-01 form as board/orch-trace.ts) ──
export const lifecycleTraceparent = (): string =>
	`00-${crypto.randomUUID().replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`;

export interface LifecycleChat {
	/** lifecycle kind — names the default x-belt-hint */
	kind: string;
	/** x-belt-hint override (distill pins the W96 phrase) */
	hint?: string;
	system: string;
	user: string;
	maxTokens?: number;
	timeoutMs?: number;
}

export interface LifecycleChatResult {
	content: string;
	inTok: number;
	outTok: number;
	traceId: string;
}

export type LifecycleFetch = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

// ─── the lifecycle client ─────────────────────────────────────────────────
export class LifecycleInference {
	private readonly budget: MemoryBudget;
	private readonly limits: MemoryLimits;
	private readonly doFetch: LifecycleFetch;

	constructor(
		opts: {
			limits?: MemoryLimits;
			budget?: MemoryBudget;
			fetch?: LifecycleFetch;
		} = {},
	) {
		this.limits = opts.limits ?? memoryLimits();
		this.budget =
			opts.budget ?? new MemoryBudget(this.limits.rpm, this.limits.concurrency);
		this.doFetch = opts.fetch ?? fetch;
	}

	/** Bounded wait for a budget slot; throws when the window expires. */
	private async admit(): Promise<void> {
		const deadline = Date.now() + this.limits.waitMs;
		for (;;) {
			if (this.budget.tryAdmit()) return;
			if (Date.now() >= deadline)
				throw new Error(
					`memory lifecycle budget exhausted: rpm ${String(this.limits.rpm)} / concurrency ${String(this.limits.concurrency)} — refused, not queued`,
				);
			await Bun.sleep(100);
		}
	}

	/** One lifecycle chat call: scoped bksk_ key, budget, traceparent, hint. */
	async chat(req: LifecycleChat): Promise<LifecycleChatResult> {
		const { front, token } = knowledgeBuckleRoute();
		await this.admit();
		const traceId = lifecycleTraceparent().split("-")[1] ?? "";
		try {
			const maxTokens = Math.min(
				req.maxTokens ?? this.limits.maxTokens,
				this.limits.maxTokens,
			);
			const r = await this.wire(front, token, traceId, req, maxTokens);
			if (!r.ok) {
				const body = await r.text().catch(() => "");
				throw new Error(
					`Buckle lifecycle route ${String(r.status)} (trace ${traceId}): ${body.slice(0, 200)}`,
				);
			}
			return await this.parsed(r, traceId);
		} finally {
			this.budget.release();
		}
	}

	/** POST one chat request; the budget slot is HELD by the caller. */
	private wire(
		front: URL,
		token: string,
		traceId: string,
		req: LifecycleChat,
		maxTokens: number,
	): Promise<Response> {
		return this.doFetch(new URL("/v1/chat/completions", front), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				traceparent: `00-${traceId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`,
				"x-belt-hint": req.hint ?? `knowledge lifecycle: ${req.kind}`,
			},
			body: JSON.stringify({
				model: "local-swarm",
				max_tokens: maxTokens,
				temperature: 0.2,
				messages: [
					{ role: "system", content: req.system },
					{ role: "user", content: req.user },
				],
			}),
			signal: AbortSignal.timeout(req.timeoutMs ?? 300_000),
		});
	}

	private async parsed(
		r: Response,
		traceId: string,
	): Promise<LifecycleChatResult> {
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		return {
			content: j.choices?.[0]?.message?.content ?? "",
			inTok: j.usage?.prompt_tokens ?? 0,
			outTok: j.usage?.completion_tokens ?? 0,
			traceId,
		};
	}

	/**
	 * Batched embeddings against the embed specialist — one POST per
	 * SUSPENDERS_MEMORY_EMBED_BATCH texts, never one POST per text; vectors
	 * return in input order; each batch consumes one budget slot.
	 */
	async embed(texts: string[]): Promise<number[][]> {
		const input = texts.filter((t) => t.trim().length > 0);
		if (!input.length) return [];
		const out: number[][] = [];
		for (let i = 0; i < input.length; i += this.limits.embedBatch)
			out.push(
				...(await this.embedBatch(input.slice(i, i + this.limits.embedBatch))),
			);
		return out;
	}

	private async embedBatch(texts: string[]): Promise<number[][]> {
		await this.admit();
		try {
			const headers: Record<string, string> = {
				"content-type": "application/json",
			};
			if (this.limits.embedToken)
				headers.authorization = `Bearer ${this.limits.embedToken}`;
			const r = await this.doFetch(this.limits.embedUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: this.limits.embedModel,
					input: texts,
				}),
				signal: AbortSignal.timeout(60_000),
			});
			if (!r.ok) {
				const body = await r.text().catch(() => "");
				throw new Error(
					`embed route ${String(r.status)}: ${body.slice(0, 200)}`,
				);
			}
			const j = (await r.json()) as {
				data?: { index?: number; embedding: number[] }[];
			};
			const rows = [...(j.data ?? [])].sort(
				(a, b) => (a.index ?? 0) - (b.index ?? 0),
			);
			if (rows.length !== texts.length)
				throw new Error(
					`embed batch short: ${String(rows.length)} of ${String(texts.length)} vectors`,
				);
			return rows.map((row) => row.embedding);
		} finally {
			this.budget.release();
		}
	}
}

// ─── write-behind: async writes + the wait-before-recall barrier ─────────
// CrewAI memory discipline: a save never blocks the caller; a recall never
// races one. Ops run at concurrency 1 (SQLite single-writer); flush() is the
// barrier recall consumers await before searching.
export class MemoryWrites {
	private queue: (() => Promise<void>)[] = [];
	private running = 0;
	private errors: Error[] = [];

	constructor(private readonly maxPending = 256) {}

	/** Fire-and-forget: backpressures only when the queue is full. */
	async push(op: () => Promise<void>): Promise<void> {
		while (this.pendingCount >= this.maxPending) await Bun.sleep(25);
		this.queue.push(op);
		queueMicrotask(() => void this.drain());
	}

	private get pendingCount(): number {
		return this.queue.length + this.running;
	}

	private async drain(): Promise<void> {
		if (this.running >= 1) return;
		this.running = 1;
		try {
			while (this.queue.length) {
				const op = this.queue.shift();
				if (!op) continue;
				try {
					await op();
				} catch (e) {
					this.errors.push(e instanceof Error ? e : new Error(String(e)));
				}
			}
		} finally {
			this.running = 0;
		}
	}

	/** Ops still queued or executing. */
	pending(): number {
		return this.pendingCount;
	}

	/**
	 * The wait-before-recall barrier: resolves when every pushed op has
	 * settled, surfacing collected errors to the recall consumer.
	 */
	async flush(): Promise<Error[]> {
		while (this.pendingCount > 0) await Bun.sleep(10);
		const errs = this.errors;
		this.errors = [];
		return errs;
	}
}
