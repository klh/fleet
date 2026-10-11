// bin/m365/agent-endpoint.ts — the M365 custom-engine agent surface for belt
// (W261). Bot Framework Activity in (POST /api/m365/agent) → grounded reply
// Activity out. Grounding rides the Graph Retrieval API with delegated Entra
// tokens (entra-auth.ts + retrieval.ts); completion rides belt's Anthropic
// seam (:4000 shim) or any M365_COMPLETIONS_URL. Incoming caller validation
// is Entra JWKS signature verification, off by default until the tenant app
// exists (M365_AGENT_VALIDATE=1 to enforce).
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { EntraConfig } from "./entra-auth.ts";
import { loadEntraConfig } from "./entra-auth.ts";
import { ground, type Grounding } from "./retrieval.ts";

export interface AgentActivity {
	type?: string;
	text?: string;
	from?: { aadObjectId?: string; id?: string };
	conversation?: { id?: string };
}

export interface AgentDeps {
	validate: boolean; // verify incoming Bearer via Entra JWKS
	cfg?: EntraConfig; // required when validate
	audience?: string; // expected aud (default: cfg.clientId)
	ground: (query: string, user?: string) => Promise<Grounding>;
	complete: (system: string, user: string) => Promise<string>;
	maxGroundChars: number;
}

// --- activity parsing ---

export function parseActivity(raw: unknown): AgentActivity | null {
	if (!raw || typeof raw !== "object") return null;
	const a = raw as AgentActivity;
	if (typeof a.type !== "string") return null;
	return a;
}

export function activityText(a: AgentActivity): string {
	if (typeof a.text === "string" && a.text.trim()) return a.text.trim();
	return "";
}

// --- incoming token verification (Entra JWKS, RS256) ---

interface Jwk {
	kid?: string;
	n?: string;
	e?: string;
	kty?: string;
	[key: string]: unknown;
}

const KID_TTL_MS = 10 * 60 * 1000;
const EXP_LEEWAY_S = 60;
const keyCache = new Map<
	string,
	{ key: CryptoKey | null; ts: number; jwk: Jwk }
>();

export function clearKeyCache(): void {
	keyCache.clear();
}

function b64urlToBuf(s: string): Buffer {
	return Buffer.from(s, "base64url");
}

async function jwkVerifyKey(jwk: Jwk): Promise<CryptoKey | null> {
	if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return null;
	try {
		return createPublicKey({ key: jwk as never, format: "jwk" });
	} catch {
		return null;
	}
}

async function fetchJwks(
	cfg: EntraConfig,
	fetchImpl: typeof fetch,
): Promise<Jwk[]> {
	const res = await fetchImpl(
		`${cfg.authority}/${cfg.tenantId}/discovery/v2.0/keys`,
	);
	if (!res.ok) throw new Error(`jwks endpoint HTTP ${res.status}`);
	const j = (await res.json()) as { keys?: Jwk[] };
	return Array.isArray(j.keys) ? j.keys : [];
}

async function verifyAgentJwt(
	token: string,
	cfg: EntraConfig,
	opts: { audience?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true } | { ok: false; why: string }> {
	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, why: "not a JWT" };
	let header: { kid?: string; alg?: string };
	let claims: { exp?: number; aud?: string | string[]; iss?: string };
	try {
		header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8"));
		claims = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
	} catch {
		return { ok: false, why: "unparsable JWT header/claims" };
	}
	if (header.alg !== "RS256")
		return { ok: false, why: `alg ${header.alg} rejected` };
	if (!header.kid) return { ok: false, why: "JWT header missing kid" };

	// exp / aud / iss before burning a JWKS fetch
	if (
		typeof claims.exp === "number" &&
		claims.exp + EXP_LEEWAY_S < Date.now() / 1000
	)
		return { ok: false, why: "token expired" };
	const aud = opts.audience ?? cfg.clientId;
	const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!auds.includes(aud))
		return { ok: false, why: `aud mismatch (want ${aud})` };
	if (claims.iss && claims.iss !== `${cfg.authority}/${cfg.tenantId}/v2.0`)
		return { ok: false, why: "iss mismatch" };

	const cached = keyCache.get(header.kid);
	if (cached && Date.now() - cached.ts > KID_TTL_MS)
		keyCache.delete(header.kid);
	let jwk = keyCache.get(header.kid)?.jwk;
	if (!jwk) {
		const keys = await fetchJwks(cfg, opts.fetchImpl ?? fetch);
		const match = keys.find((k) => k.kid === header.kid);
		if (!match)
			return { ok: false, why: `kid ${header.kid} not in tenant JWKS` };
		keyCache.set(header.kid, { jwk: match, key: null, ts: Date.now() });
		jwk = match;
	}
	const key = await jwkVerifyKey(jwk);
	if (!key) return { ok: false, why: "JWKS entry not a usable RSA key" };
	const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
	const sig = b64urlToBuf(parts[2]);
	const valid = cryptoVerify("RSA-SHA256", signed, key, sig);
	if (!valid) return { ok: false, why: "signature invalid" };
	return { ok: true };
}

// --- activity handling (pure, HTTP-free) ---

const CONTEXT_HEADER =
	"You are a Microsoft 365 custom engine agent hosted by the klh fleet belt gateway. " +
	"Answer the user directly. When GROUNDED M365 CONTENT is present, prefer it over " +
	"guessing and cite item titles; never invent sources.";

function groundBlock(
	hits: Grounding extends { ok: true; hits: infer H } ? H : never,
	cap: number,
): string {
	const lines: string[] = [
		"GROUNDED M365 CONTENT (Graph Retrieval API, user-delegated):",
	];
	let used = lines[0].length;
	for (const h of hits) {
		const line = `\n- ${h.title || h.url || "untitled"}${h.resourceType ? ` (${h.resourceType})` : ""}: ${h.snippet.trim()}${h.url ? `\n  ${h.url}` : ""}`;
		if (used + line.length > cap) break;
		lines.push(line);
		used += line.length;
	}
	return lines.length > 1 ? lines.join("") : "";
}

function groundedSystem(
	systemBase: string,
	hits: GroundingHit[],
	cap: number,
): string {
	const block = groundBlock(hits, cap);
	return block ? `${systemBase}\n\n${block}` : systemBase;
}

type GroundingHit = Extract<Grounding, { ok: true }>["hits"][number];

/** One agent turn: ground → complete → reply Activity. Never throws —
 * failures become honest reply text so the Copilot surface degrades loudly. */
export async function handleAgentActivity(
	deps: AgentDeps,
	activity: AgentActivity,
): Promise<{ type: string; text: string }> {
	if (activity.type !== "message") return { type: "message", text: "" };
	const text = activityText(activity);
	if (!text)
		return {
			type: "message",
			text: "Send a question and I will answer with M365 grounding.",
		};
	const user = activity.from?.aadObjectId ?? activity.from?.id;
	const g = await deps.ground(text, user);
	if (g.ok) {
		try {
			const reply = await deps.complete(
				groundedSystem(CONTEXT_HEADER, g.hits, deps.maxGroundChars),
				text,
			);
			return { type: "message", text: reply };
		} catch (err) {
			return {
				type: "message",
				text: `completion failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}
	if (g.reason === "login-needed" || g.reason === "not-configured")
		return {
			type: "message",
			text: `M365 grounding unavailable (${g.reason}). ${g.hint ?? ""}`.trim(),
		};
	return {
		type: "message",
		text: `M365 grounding failed (HTTP ${g.status ?? "?"}). ${g.detail ?? ""}`.trim(),
	};
}

// --- HTTP skin ---

/** fetch-style handler for Bun.serve / any Request-in-Response-out router. */
export function m365AgentFetch(
	deps: AgentDeps,
): (req: Request) => Promise<Response> {
	return async (req: Request) => {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname.endsWith("/health"))
			return Response.json({ ok: true, validate: deps.validate });
		if (req.method !== "POST")
			return new Response("method not allowed", { status: 405 });
		if (deps.validate) {
			const cfg = deps.cfg;
			if (!cfg)
				return new Response("validate=1 but no entra config", { status: 500 });
			const bearer =
				req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
			const verdict = bearer
				? await verifyAgentJwt(bearer, cfg, { audience: deps.audience })
				: { ok: false as const, why: "missing bearer token" };
			if (!verdict.ok)
				return new Response(`unauthorized: ${verdict.why}`, { status: 401 });
		}
		let activity: AgentActivity | null = null;
		try {
			activity = parseActivity(await req.json());
		} catch {
			activity = null;
		}
		if (!activity)
			return new Response("not a Bot Framework Activity", { status: 400 });
		const reply = await handleAgentActivity(deps, activity);
		return Response.json(reply);
	};
}

// --- default wiring (env-driven) ---

/** Completion via belt's Anthropic seam (:4000 shim) or any M365_COMPLETIONS_URL. */
export async function shimCompletion(
	system: string,
	user: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	const url =
		env.M365_COMPLETIONS_URL?.trim() || "http://127.0.0.1:4000/v1/messages";
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": env.M365_COMPLETIONS_KEY?.trim() ?? "",
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: env.M365_AGENT_MODEL?.trim() || "auto",
			max_tokens: Number(env.M365_AGENT_MAX_TOKENS) || 1024,
			system,
			messages: [{ role: "user", content: user }],
		}),
	});
	if (!res.ok) throw new Error(`completions upstream HTTP ${res.status}`);
	const j = (await res.json()) as {
		content?: Array<{ type?: string; text?: string }>;
	};
	const text = (j.content ?? [])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
	if (!text) throw new Error("completions upstream returned no text");
	return text;
}

export function defaultDeps(
	env: Record<string, string | undefined> = process.env,
): AgentDeps {
	return {
		validate: env.M365_AGENT_VALIDATE === "1",
		cfg: loadEntraConfig(env) ?? undefined,
		ground: (query, _user) => ground(query, { env, auth: { env } }),
		complete: (system, user) => shimCompletion(system, user, env),
		maxGroundChars: Number(env.M365_AGENT_MAX_GROUND_CHARS) || 6000,
	};
}
