// credentials.ts — W2869.3: per-generation bksk_ credentials with
// fail-closed numeric expiry. Root #117874: buckle admin issueKey returns
// expires_at as an EPOCH-MILLISECONDS number|null (ApiKeyRow wire) — never
// an ISO string. A null/malformed/past expiry fails the mint CLOSED with an
// immediate revoke of the just-minted key; the ISO normalization happens
// ONLY in the onCredential binding, after the numeric mint validated.
import { readFile } from "node:fs/promises";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { z } from "zod";

export class CredentialError extends Error {}

/** Buckle admin 201 mint row — numeric epoch-ms expiry or refuse. */
export const MintResponseSchema = z.object({
	key_id: z.string().min(1),
	key: z.string().min(1),
	name: z.string(),
	scopes: z.array(z.string()),
	expires_at: z.number().finite().int().positive(),
});

/** Buckle admin revoke response. */
export const RevokedResponseSchema = z.object({
	revoked: z.string().min(1),
});

export interface CredentialReceipt {
	runId: string;
	epoch: number;
	keyId: string;
	name: string;
	scope: string;
	mintedAt: number;
	revokedAt: number | null;
}

export interface CredentialBinding {
	runId: string;
	epoch: number;
	keyId: string;
	name: string;
	/** ISO string — normalized ONLY after the numeric mint validated. */
	expiresAt: string;
}

export interface CredentialManager {
	mint(
		runId: string,
		epoch: number,
	): Promise<{ key: string; receipt: CredentialReceipt }>;
	revoke(runId: string, epoch: number): Promise<void>;
	list(): CredentialReceipt[];
	/** The raw key material for the run's live credential — process-memory
	 *  only. After a process loss the raw key is gone (receipts persist
	 *  keyId by design, never bearer material): resolve returns undefined
	 *  and `ensure` re-mints for the persisted epoch. Root #118378/#118409. */
	resolve(
		runId: string,
	): { key: string; keyId: string; epoch: number } | undefined;
	/** Idempotent live-key acquisition for a run+epoch: returns the held
	 *  raw key, or re-mints for the epoch (best-effort revoking the stale
	 *  keyId first). Recover's re-arm path — a restarted leaf cannot serve
	 *  model transport without it. */
	ensure(
		runId: string,
		epoch: number,
	): Promise<{ key: string; keyId: string; epoch: number }>;
}

export interface CredentialManagerDeps {
	/** Buckle admin base, e.g. the desktop hub :4111 front. */
	baseUrl: string;
	adminKey: string;
	fetch?: typeof fetch;
	now?: () => number;
	/** Per-request admin HTTP bound (default 10s; redirect:error always). */
	timeoutMs?: number;
	/** 0600 receipt journal — the ONLY way a restart can revoke an
	 *  old-generation key (root #117912.5: in-memory receipts die with
	 *  the process; the journal survives it). Corrupt journal refuses
	 *  the whole manager (fail closed). */
	receiptsPath?: string;
	/** Awaited before mint resolves; throwing fails the admit loud and
	 *  the just-minted key is revoked BEFORE the error escapes. */
	onCredential?: (binding: CredentialBinding) => Promise<void>;
}

/** The 0600 receipt journal file — rows are CredentialReceipts; the key
 * is (runId, epoch) carried INSIDE the row so restart revocation can walk
 * it without trusting the map key. */
const JournalFileSchema = z.array(
	z.object({
		runId: z.string().min(1),
		epoch: z.number().int().positive(),
		keyId: z.string().min(1),
		name: z.string(),
		scope: z.string().min(1),
		mintedAt: z.number(),
		revokedAt: z.number().nullable(),
	}),
);
const MINT_SCOPE = "buckle:proxy:WRITE_";

const httpJson = async (
	ctx: CredCtx,
	url: string,
	init: RequestInit,
): Promise<{ status: number; body: string }> => {
	const res = await ctx.fetchImpl(url, {
		...init,
		// Root #117912.4: bounded + non-following admin HTTP — a redirect
		// must never replay the Bearer admin key cross-origin, and a hung
		// admin must not strand the mint ladder.
		redirect: "error",
		signal: AbortSignal.timeout(ctx.timeoutMs),
	});
	const body = await res.text();
	return { status: res.status, body };
};

const msgOf = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/** Issue summary without raw received values — root #117911: admin/provider
 * error text banked in public feeds leaked key material; error surfaces
 * carry fixed labels + field paths only. */
const zodIssueSummary = (error: z.ZodError): string =>
	error.issues
		.slice(0, 8)
		.map((i) => `${i.path.join(".") || "<root>"}: ${i.code}`)
		.join("; ")
		.slice(0, 200);

const parseMint = (body: string): z.infer<typeof MintResponseSchema> => {
	const parsed = MintResponseSchema.safeParse(JSON.parse(body));
	if (!parsed.success) {
		throw new CredentialError(
			`credential mint: response shape refused — ${zodIssueSummary(parsed.error)}`,
		);
	}
	return parsed.data;
};

const assertFutureExpiry = (expiresAt: number, now: number): void => {
	if (!Number.isFinite(expiresAt) || expiresAt <= now) {
		throw new CredentialError(
			`credential mint: expires_at ${expiresAt} is not a finite future epoch-ms timestamp — refusing (fail closed)`,
		);
	}
};

interface CredCtx {
	deps: CredentialManagerDeps;
	fetchImpl: typeof fetch;
	now: () => number;
	timeoutMs: number;
	journal: Promise<void> | null;
	receipts: Map<string, CredentialReceipt>;
	/** Process-memory raw keys keyed keyOf(runId, epoch) — receipts
	 *  persist keyId by design, NEVER bearer material. Dies with the
	 *  process; ensure() re-arms after a loss. */
	rawKeys: Map<string, { key: string; receipt: CredentialReceipt }>;
	urlOf(path: string): string;
}

const keyOf = (runId: string, epoch: number): string => `${runId}:${epoch}`;

const mkCredCtx = (deps: CredentialManagerDeps): CredCtx => ({
	deps,
	fetchImpl: deps.fetch ?? fetch,
	now: deps.now ?? Date.now,
	timeoutMs: deps.timeoutMs ?? 10_000,
	journal: null,
	receipts: new Map<string, CredentialReceipt>(),
	rawKeys: new Map<string, { key: string; receipt: CredentialReceipt }>(),
	urlOf: (path: string) => `${deps.baseUrl}${path}`,
});

const revokeById = async (ctx: CredCtx, keyId: string): Promise<void> => {
	const res = await httpJson(
		ctx,
		ctx.urlOf(`/v1/admin/keys/${encodeURIComponent(keyId)}/revoke`),
		{
			method: "POST",
			headers: { authorization: `Bearer ${ctx.deps.adminKey}` },
		},
	);
	if (res.status !== 200) {
		throw new CredentialError(
			`credential revoke: admin refused (${res.status}) — body redacted (${res.body.length} bytes)`,
		);
	}
	const parsed = RevokedResponseSchema.safeParse(JSON.parse(res.body));
	if (!parsed.success) {
		throw new CredentialError(
			`credential revoke: response shape refused — ${zodIssueSummary(parsed.error)}`,
		);
	}
};

const mintOnce = async (
	ctx: CredCtx,
	runId: string,
	epoch: number,
): Promise<{
	key: string;
	keyId: string;
	name: string;
	expiresAtMs: number;
	receipt: CredentialReceipt;
}> => {
	const name = `runner:${runId}:${epoch}`;
	const res = await httpJson(ctx, ctx.urlOf("/v1/admin/keys"), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${ctx.deps.adminKey}`,
		},
		// Root #117912.3: ask for a bounded key explicitly — the real
		// admin defaults expires_at:null (parse-refused) otherwise.
		body: JSON.stringify({ name, scopes: [MINT_SCOPE], expires_in_s: 3600 }),
	});
	if (res.status !== 201) {
		throw new CredentialError(
			`credential mint: admin refused (${res.status}) — body redacted (${res.body.length} bytes)`,
		);
	}
	return finishMint(ctx, res.body, runId, epoch);
};

/** Best-effort key_id capture from the RAW mint row — BEFORE the strict
 * parse. A malformed row still names the key so the fail-closed ladder
 * can revoke it (root #117912.3). */
const candidateKeyOf = (body: string): string | null => {
	try {
		const raw: unknown = JSON.parse(body);
		if (raw !== null && typeof raw === "object") {
			const id = (raw as { key_id?: unknown }).key_id;
			if (typeof id === "string" && id.length > 0) return id;
		}
	} catch {
		return null;
	}
	return null;
};

/** Bounded 0600 receipt journal load — the ONLY way a restart can revoke
 * an old-generation key (root #117912.5). Corrupt journal fails the
 * whole manager CLOSED at first use, never a silent empty start. */
const loadJournal = async (ctx: CredCtx): Promise<void> => {
	const path = ctx.deps.receiptsPath;
	if (!path) return;
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return;
	}
	const parsed = JournalFileSchema.safeParse(JSON.parse(raw));
	if (!parsed.success) {
		throw new CredentialError(
			`credential journal corrupt — refusing to start (recover ${path} manually): ${zodIssueSummary(parsed.error)}`,
		);
	}
	for (const row of parsed.data) {
		ctx.receipts.set(keyOf(row.runId, row.epoch), row);
	}
};

const ensureLoaded = (ctx: CredCtx): Promise<void> => {
	ctx.journal ??= loadJournal(ctx);
	return ctx.journal;
};

const persistReceipts = (ctx: CredCtx): void => {
	if (!ctx.deps.receiptsPath) return;
	atomicWrite0600(
		ctx.deps.receiptsPath,
		`${JSON.stringify([...ctx.receipts.values()])}\n`,
	);
};

const finishMint = async (
	ctx: CredCtx,
	body: string,
	runId: string,
	epoch: number,
): Promise<{
	key: string;
	keyId: string;
	name: string;
	expiresAtMs: number;
	receipt: CredentialReceipt;
}> => {
	// Root #117912.3: capture key_id from the RAW mint row BEFORE the
	// strict parse — a shape/expiry refusal revokes the just-minted key
	// instead of leaving it live.
	const candidate = candidateKeyOf(body);
	try {
		const minted = parseMint(body);
		assertFutureExpiry(minted.expires_at, ctx.now());
		const receipt: CredentialReceipt = {
			runId,
			epoch,
			keyId: minted.key_id,
			name: minted.name,
			scope: MINT_SCOPE,
			mintedAt: ctx.now(),
			revokedAt: null,
		};
		ctx.receipts.set(keyOf(runId, epoch), receipt);
		persistReceipts(ctx);
		return {
			key: minted.key,
			keyId: minted.key_id,
			name: minted.name,
			expiresAtMs: minted.expires_at,
			receipt,
		};
	} catch (err) {
		if (candidate) {
			try {
				await revokeById(ctx, candidate);
			} catch (cleanupErr) {
				throw new CredentialError(
					`credential mint refused — ${msgOf(err)}; CLEANUP ALSO FAILED — ${msgOf(cleanupErr)}`,
				);
			}
			throw new CredentialError(
				`credential mint refused (key revoked) — ${msgOf(err)}`,
			);
		}
		throw err;
	}
};

const bindCredential = async (
	ctx: CredCtx,
	runId: string,
	epoch: number,
	minted: { keyId: string; name: string; expiresAtMs: number },
): Promise<void> => {
	if (!ctx.deps.onCredential) return;
	try {
		await ctx.deps.onCredential({
			runId,
			epoch,
			keyId: minted.keyId,
			name: minted.name,
			expiresAt: new Date(minted.expiresAtMs).toISOString(),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		try {
			await revokeById(ctx, minted.keyId);
		} catch (cleanupErr) {
			const cleanup = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
			throw new CredentialError(
				`credential mint: binding failed — ${message}; CLEANUP ALSO FAILED — ${cleanup}`,
			);
		}
		const receipt = ctx.receipts.get(keyOf(runId, epoch));
		if (receipt) {
			receipt.revokedAt = ctx.now();
			persistReceipts(ctx);
		}
		throw new CredentialError(`credential mint: binding failed (key revoked) — ${message}`);
	}
};

const revokeKey = async (
	ctx: CredCtx,
	runId: string,
	epoch: number,
): Promise<void> => {
	await ensureLoaded(ctx);
	const receipt = ctx.receipts.get(keyOf(runId, epoch));
	if (!receipt) {
		throw new CredentialError(
			`credential revoke: no minted key for ${runId}:${epoch} — mint first`,
		);
	}
	await revokeById(ctx, receipt.keyId);
	receipt.revokedAt = ctx.now();
	ctx.rawKeys.delete(keyOf(runId, epoch));
	persistReceipts(ctx);
};

/** The one credential manager: buckle-admin mint with fail-closed numeric
 *  epoch-ms expiry, binding-first admit (a throwing binding revokes the
 *  key BEFORE the error escapes), fence-scope revoke by (runId, epoch). */
export const createCredentialManager = (
	deps: CredentialManagerDeps,
): CredentialManager => {
	const ctx = mkCredCtx(deps);
	/** One mint+bind; the raw key is then held in process memory ONLY. */
	const mintFor = async (runId: string, epoch: number) => {
		await ensureLoaded(ctx);
		const minted = await mintOnce(ctx, runId, epoch);
		await bindCredential(ctx, runId, epoch, minted);
		ctx.rawKeys.set(keyOf(runId, epoch), {
			key: minted.key,
			receipt: minted.receipt,
		});
		return minted;
	};
	return {
		mint: async (runId, epoch) => {
			const minted = await mintFor(runId, epoch);
			return { key: minted.key, receipt: minted.receipt };
		},
		resolve: (runId) => {
			let best: { key: string; keyId: string; epoch: number } | undefined;
			for (const receipt of ctx.receipts.values()) {
				if (receipt.runId !== runId || receipt.revokedAt !== null) continue;
				const raw = ctx.rawKeys.get(keyOf(runId, receipt.epoch));
				if (!raw) continue;
				if (!best || receipt.epoch > best.epoch) {
					best = { key: raw.key, keyId: receipt.keyId, epoch: receipt.epoch };
				}
			}
			return best;
		},
		ensure: async (runId, epoch) => {
			await ensureLoaded(ctx);
			const held = ctx.rawKeys.get(keyOf(runId, epoch));
			if (held) return { key: held.key, keyId: held.receipt.keyId, epoch };
			// Post-loss re-arm: the receipt survives the process, the raw
			// key does not. Root #118603: NEVER mint a replacement while a
			// stale key's death is unconfirmed — a live-but-unrecorded key
			// would leave TWO usable proxy credentials for one run/epoch.
			// A failed/timed-out revoke throws and mints nothing.
			const receipt = ctx.receipts.get(keyOf(runId, epoch));
			if (receipt && receipt.revokedAt === null) {
				await revokeById(ctx, receipt.keyId);
				receipt.revokedAt = ctx.now();
				ctx.rawKeys.delete(keyOf(runId, epoch));
				persistReceipts(ctx);
			}
			const minted = await mintFor(runId, epoch);
			return { key: minted.key, keyId: minted.keyId, epoch };
		},
		revoke: (runId, epoch) => revokeKey(ctx, runId, epoch),
		list: () => [...ctx.receipts.values()],
	};
};
