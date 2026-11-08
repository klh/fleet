// credentials.ts — W2869.3: per-generation bksk_ credentials with
// fail-closed numeric expiry. Root #117874: buckle admin issueKey returns
// expires_at as an EPOCH-MILLISECONDS number|null (ApiKeyRow wire) — never
// an ISO string. A null/malformed/past expiry fails the mint CLOSED with an
// immediate revoke of the just-minted key; the ISO normalization happens
// ONLY in the onCredential binding, after the numeric mint validated.
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
}

export interface CredentialManagerDeps {
	/** Buckle admin base, e.g. the desktop hub :4111 front. */
	baseUrl: string;
	adminKey: string;
	fetch?: typeof fetch;
	now?: () => number;
	/** Awaited before mint resolves; throwing fails the admit loud and
	 *  the just-minted key is revoked BEFORE the error escapes. */
	onCredential?: (binding: CredentialBinding) => Promise<void>;
}

const MINT_SCOPE = "buckle:proxy:WRITE_";

const httpJson = async (
	url: string,
	init: RequestInit,
	fetchImpl: typeof fetch,
): Promise<{ status: number; body: string }> => {
	const res = await fetchImpl(url, init);
	const body = await res.text();
	return { status: res.status, body };
};

const parseMint = (body: string): z.infer<typeof MintResponseSchema> => {
	const parsed = MintResponseSchema.safeParse(JSON.parse(body));
	if (!parsed.success) {
		throw new CredentialError(
			`credential mint: response shape refused — ${parsed.error.message}`,
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
	receipts: Map<string, CredentialReceipt>;
	urlOf(path: string): string;
}

const keyOf = (runId: string, epoch: number): string => `${runId}:${epoch}`;

const mkCredCtx = (deps: CredentialManagerDeps): CredCtx => ({
	deps,
	fetchImpl: deps.fetch ?? fetch,
	now: deps.now ?? Date.now,
	receipts: new Map<string, CredentialReceipt>(),
	urlOf: (path: string) => `${deps.baseUrl}${path}`,
});

const revokeById = async (ctx: CredCtx, keyId: string): Promise<void> => {
	const res = await httpJson(
		ctx.urlOf(`/v1/admin/keys/${encodeURIComponent(keyId)}/revoke`),
		{
			method: "POST",
			headers: { authorization: `Bearer ${ctx.deps.adminKey}` },
		},
		ctx.fetchImpl,
	);
	if (res.status !== 200) {
		throw new CredentialError(
			`credential revoke: admin refused (${res.status}) — ${res.body.slice(0, 300)}`,
		);
	}
	const parsed = RevokedResponseSchema.safeParse(JSON.parse(res.body));
	if (!parsed.success) {
		throw new CredentialError(
			`credential revoke: response shape refused — ${parsed.error.message}`,
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
	const res = await httpJson(
		ctx.urlOf("/v1/admin/keys"),
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${ctx.deps.adminKey}`,
			},
			body: JSON.stringify({ name, scopes: [MINT_SCOPE] }),
		},
		ctx.fetchImpl,
	);
	if (res.status !== 201) {
		throw new CredentialError(
			`credential mint: admin refused (${res.status}) — ${res.body.slice(0, 300)}`,
		);
	}
	return finishMint(ctx, res.body, runId, epoch);
};

const finishMint = (
	ctx: CredCtx,
	body: string,
	runId: string,
	epoch: number,
): {
	key: string;
	keyId: string;
	name: string;
	expiresAtMs: number;
	receipt: CredentialReceipt;
} => {
	const minted = parseMint(body);
	assertFutureExpiry(minted.expires_at, ctx.now());
	const receipt: CredentialReceipt = {
		keyId: minted.key_id,
		name: minted.name,
		scope: MINT_SCOPE,
		mintedAt: ctx.now(),
		revokedAt: null,
	};
	ctx.receipts.set(keyOf(runId, epoch), receipt);
	return {
		key: minted.key,
		keyId: minted.key_id,
		name: minted.name,
		expiresAtMs: minted.expires_at,
		receipt,
	};
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
		const receipt = ctx.receipts.get(keyOf(runId, epoch));
		if (receipt) receipt.revokedAt = ctx.now();
		throw await revokeAfterBindFailure(ctx, minted.keyId, message);
	}
};

/** Bind failure tail: revoke the just-minted key, then fail — the error
 *  names BOTH failures when cleanup itself also failed (combined message). */
const revokeAfterBindFailure = async (
	ctx: CredCtx,
	keyId: string,
	message: string,
): Promise<CredentialError> => {
	try {
		await revokeById(ctx, keyId);
	} catch (cleanupErr) {
		const cleanup =
			cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
		return new CredentialError(
			`credential mint: binding failed — ${message}; CLEANUP ALSO FAILED — ${cleanup}`,
		);
	}
	return new CredentialError(
		`credential mint: binding failed (key revoked) — ${message}`,
	);
};

const revokeKey = async (
	ctx: CredCtx,
	runId: string,
	epoch: number,
): Promise<void> => {
	const receipt = ctx.receipts.get(keyOf(runId, epoch));
	if (!receipt) {
		throw new CredentialError(
			`credential revoke: no minted key for ${runId}:${epoch} — mint first`,
		);
	}
	await revokeById(ctx, receipt.keyId);
	receipt.revokedAt = ctx.now();
};

/** The one credential manager: buckle-admin mint with fail-closed numeric
 *  epoch-ms expiry, binding-first admit (a throwing binding revokes the
 *  key BEFORE the error escapes), fence-scope revoke by (runId, epoch). */
export const createCredentialManager = (
	deps: CredentialManagerDeps,
): CredentialManager => {
	const ctx = mkCredCtx(deps);
	return {
		mint: async (runId, epoch) => {
			const minted = await mintOnce(ctx, runId, epoch);
			await bindCredential(ctx, runId, epoch, minted);
			return { key: minted.key, receipt: minted.receipt };
		},
		revoke: (runId, epoch) => revokeKey(ctx, runId, epoch),
		list: () => [...ctx.receipts.values()],
	};
};
