// bin/m365/entra-auth.ts — delegated Entra ID auth for the belt M365 agent
// (W261). Device-code flow (user-delegated tokens, offline_access) with a
// 0600 on-disk cache. Config-over-code: tenant/client ids live ONLY in
// machine env (M365_TENANT_ID / M365_CLIENT_ID) — repos carry no real ids.
// Token endpoints are standard OAuth2; the Graph Retrieval delegated scopes
// are tenant-verification-pending (docs/m365-agent.md).
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface EntraConfig {
	tenantId: string;
	clientId: string;
	authority: string; // e.g. https://login.microsoftonline.com
	graphScopes: string[]; // delegated scopes incl. offline_access
}

export interface DeviceLogin {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	interval: number; // seconds between polls
	expiresAt: number; // epoch ms
}

export interface TokenSet {
	accessToken: string;
	expiresAt: number; // epoch ms
	refreshToken?: string;
	username?: string;
}

export type DelegatedToken =
	| { ok: true; token: string; expiresAt: number }
	| { ok: false; reason: "not-configured" | "login-needed"; hint: string };

const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const DEVICE_POLL_MAX_S = 30;

export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
export const DEFAULT_GRAPH_SCOPES = [
	"https://graph.microsoft.com/User.Read",
	"offline_access",
];

export function loadEntraConfig(
	env: Record<string, string | undefined> = process.env,
): EntraConfig | null {
	const tenantId = env.M365_TENANT_ID?.trim();
	const clientId = env.M365_CLIENT_ID?.trim();
	if (!tenantId || !clientId) return null;
	const scopes = env.M365_GRAPH_SCOPES?.trim();
	return {
		tenantId,
		clientId,
		authority: (env.M365_AUTHORITY?.trim() || DEFAULT_AUTHORITY).replace(
			/\/+$/,
			"",
		),
		graphScopes: scopes ? scopes.split(/\s+/) : DEFAULT_GRAPH_SCOPES,
	};
}

export function tokenCachePath(
	env: Record<string, string | undefined> = process.env,
): string {
	return (
		env.M365_TOKEN_CACHE?.trim() ||
		`${env.HOME ?? ""}/.claude/local-llm/m365-tokens.json`
	);
}

const DEVICE_TOKEN_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function tokenForm(
	cfg: EntraConfig,
	extra: Record<string, string>,
): URLSearchParams {
	return new URLSearchParams({ client_id: cfg.clientId, ...extra });
}

/** Kick off the device-code flow: the user opens verificationUri and enters
 * userCode on a device with a browser. */
export async function beginDeviceLogin(
	cfg: EntraConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<DeviceLogin> {
	const res = await fetchImpl(
		`${cfg.authority}/${cfg.tenantId}/oauth2/v2.0/devicecode`,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: tokenForm(cfg, { scope: cfg.graphScopes.join(" ") }),
		},
	);
	if (!res.ok) throw new Error(`entra: devicecode endpoint HTTP ${res.status}`);
	const j = (await res.json()) as Record<string, string | number | undefined>;
	if (!j.device_code || !j.user_code || !j.verification_uri)
		throw new Error("entra: devicecode response missing required fields");
	return {
		deviceCode: String(j.device_code),
		userCode: String(j.user_code),
		verificationUri: String(j.verification_uri),
		interval: Math.max(1, Number(j.interval) || 5),
		expiresAt: Date.now() + Math.max(60, Number(j.expires_in) || 900) * 1000,
	};
}

export type DevicePoll =
	| { status: "pending" }
	| { status: "slow-down"; interval: number }
	| { status: "done"; tokens: TokenSet }
	| { status: "failed"; error: string };

function toTokenSet(
	j: Record<string, string | number | undefined>,
): TokenSet | null {
	if (!j.access_token) return null;
	const expiresIn = Number(j.expires_in) || 3600;
	return {
		accessToken: String(j.access_token),
		expiresAt: Date.now() + expiresIn * 1000,
		refreshToken: j.refresh_token ? String(j.refresh_token) : undefined,
		username: j.username ? String(j.username) : undefined,
	};
}

/** One poll round against the token endpoint. Pending/slow-down are normal
 * flow states, not errors. */
export async function pollDeviceOnce(
	cfg: EntraConfig,
	deviceCode: string,
	fetchImpl: typeof fetch = fetch,
): Promise<DevicePoll> {
	const res = await fetchImpl(
		`${cfg.authority}/${cfg.tenantId}/oauth2/v2.0/token`,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: tokenForm(cfg, {
				grant_type: DEVICE_TOKEN_GRANT,
				device_code: deviceCode,
			}),
		},
	);
	const j = (await res.json()) as Record<string, string | number | undefined>;
	if (j.error === "authorization_pending") return { status: "pending" };
	if (j.error === "slow_down")
		return {
			status: "slow-down",
			interval: Math.max(1, Number(j.interval) || 5),
		};
	if (j.error) return { status: "failed", error: String(j.error) };
	const tokens = toTokenSet(j);
	if (!tokens)
		return { status: "failed", error: "token response missing access_token" };
	return { status: "done", tokens };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until approved, expired, or failed. onPrompt fires once, first. */
export async function awaitDeviceApproval(
	cfg: EntraConfig,
	begun: DeviceLogin,
	opts: {
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
		onPrompt?: () => void;
	} = {},
): Promise<TokenSet> {
	opts.onPrompt?.();
	let interval = begun.interval;
	while (Date.now() < begun.expiresAt) {
		if (opts.signal?.aborted) throw new Error("entra: device login aborted");
		const poll = await pollDeviceOnce(
			cfg,
			begun.deviceCode,
			opts.fetchImpl ?? fetch,
		);
		if (poll.status === "done") return poll.tokens;
		if (poll.status === "failed")
			throw new Error(`entra: device login failed: ${poll.error}`);
		if (poll.status === "slow-down")
			interval = Math.min(DEVICE_POLL_MAX_S, poll.interval);
		await sleep(interval * 1000);
	}
	throw new Error("entra: device login expired before approval");
}

// --- token cache (single seat: owner login on this machine) ---

interface CacheDoc extends TokenSet {
	updatedAt: number;
}

export function readTokenCache(path: string): TokenSet | null {
	try {
		const doc = JSON.parse(readFileSync(path, "utf8")) as CacheDoc;
		if (!doc.accessToken || typeof doc.expiresAt !== "number") return null;
		return {
			accessToken: doc.accessToken,
			expiresAt: doc.expiresAt,
			refreshToken: doc.refreshToken,
			username: doc.username,
		};
	} catch {
		return null;
	}
}

export function writeTokenCache(path: string, tokens: TokenSet): void {
	const doc: CacheDoc = { ...tokens, updatedAt: Date.now() };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(doc, null, "\t"));
	chmodSync(path, 0o600);
}

export function logout(path: string = tokenCachePath()): boolean {
	try {
		rmSync(path);
		return true;
	} catch {
		return false;
	}
}

function cacheValid(tokens: TokenSet): boolean {
	return tokens.expiresAt - EXPIRY_SKEW_MS > Date.now();
}

async function refreshGrant(
	cfg: EntraConfig,
	refreshToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
	const res = await fetchImpl(
		`${cfg.authority}/${cfg.tenantId}/oauth2/v2.0/token`,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: tokenForm(cfg, {
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}),
		},
	);
	const j = (await res.json()) as Record<string, string | number | undefined>;
	if (j.error) throw new Error(String(j.error));
	const tokens = toTokenSet(j);
	if (!tokens) throw new Error("refresh response missing access_token");
	return tokens;
}

/** The one entry callers use: cached token → refresh → login-needed.
 * Never blocks on interactive login; surface the hint instead. */
export async function getDelegatedToken(
	opts: {
		env?: Record<string, string | undefined>;
		cfg?: EntraConfig;
		fetchImpl?: typeof fetch;
		cachePath?: string;
	} = {},
): Promise<DelegatedToken> {
	const cfg = opts.cfg ?? loadEntraConfig(opts.env ?? process.env);
	if (!cfg)
		return {
			ok: false,
			reason: "not-configured",
			hint: "set M365_TENANT_ID + M365_CLIENT_ID in the belt env (0600 machine config)",
		};
	const path = opts.cachePath ?? tokenCachePath(opts.env ?? process.env);
	const cached = readTokenCache(path);
	if (cached && cacheValid(cached))
		return { ok: true, token: cached.accessToken, expiresAt: cached.expiresAt };
	if (cached?.refreshToken) {
		try {
			const fresh = await refreshGrant(
				cfg,
				cached.refreshToken,
				opts.fetchImpl ?? fetch,
			);
			writeTokenCache(path, fresh);
			return { ok: true, token: fresh.accessToken, expiresAt: fresh.expiresAt };
		} catch {
			// invalid/expired refresh grant → full device login required
		}
	}
	return {
		ok: false,
		reason: "login-needed",
		hint: "run: bun packages/belt/bin/m365/login.ts (device-code login, owner present)",
	};
}
