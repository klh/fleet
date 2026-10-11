// hooks/board/routes-hub-admin.ts — W231 hub admin plane: the /console/hub
// page + the /api/hub/* JSON feeds behind it (tokens, provider keys,
// federation status). The store is an injected parameter (no context.ts
// import — module-load REG binding would pin the live governor.db in
// tests); fleet-board.ts passes the live store, tests pass a fixture.
import type { ConsoleMe } from "../bin/console-html.ts";
import { hubPage } from "../bin/hub-admin-html.ts";
import { federationStatus } from "../lib/hub-federation-status.ts";
import {
	providerConfigHome,
	providerKeyInventory,
	presentEnvFiles,
} from "../lib/hub-provider-keys.ts";
import type { GovernorStore } from "../lib/govdb.ts";
import {
	issueHubToken,
	listTokens,
	revokeHubToken,
	type IssueHubTokenSpec,
} from "../lib/hub-tokens.ts";
import { consoleMe } from "./console-view.ts";
import { json, readJson, writeGuard } from "./helpers.ts";
import { scrub } from "../lib/servicemon.ts";

export async function handleHubAdmin(
	req: Request,
	url: URL,
	store: GovernorStore,
): Promise<Response | null> {
	const path = url.pathname;
	if (path === "/console/hub") {
		const me: ConsoleMe = consoleMe();
		return new Response(hubPage(me), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		});
	}
	if (!path.startsWith("/api/hub/")) return null;
	// every /api/hub/* mutation rides the shared perimeter guard (host
	// allowlist + Origin==Host + per-install write token) — reads are open
	// to the same perimeter the rest of the console feeds ride
	if (req.method !== "GET") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
	}
	if (path === "/api/hub/tokens" && req.method === "GET")
		return json({ ok: true, tokens: listTokens(store) });
	if (path === "/api/hub/tokens" && req.method === "POST") {
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		return issueRoute(store, parsed.body);
	}
	if (path === "/api/hub/tokens/revoke" && req.method === "POST")
		return revokeRoute(store, req);
	if (path === "/api/hub/provider-keys" && req.method === "GET")
		return json(providerKeysPayload());
	if (path === "/api/hub/federation" && req.method === "GET")
		return json({ ok: true, ...federationStatus() });
	return null;
}

const str = (v: unknown): string | null =>
	typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

function issueRoute(
	store: GovernorStore,
	body: Record<string, unknown>,
): Response {
	const actor = str(body.actor);
	if (actor === null)
		return json({ ok: false, error: "actor is required" }, 400);
	const cls = str(body.token_class) ?? "app-role";
	if (cls !== "app-role" && cls !== "delegated")
		return json(
			{ ok: false, error: "token_class must be app-role or delegated" },
			400,
		);
	const scopes = Array.isArray(body.scopes)
		? body.scopes.filter(
				(s): s is string => typeof s === "string" && s.length > 0,
			)
		: typeof body.scopes === "string"
			? body.scopes
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: ["buckle:admin"];
	if (scopes.length === 0)
		return json({ ok: false, error: "at least one scope required" }, 400);
	const ttlDays = (v: unknown): number | null => {
		const n = typeof v === "number" ? v : Number(v);
		if (!Number.isFinite(n) || n <= 0) return null;
		return Math.floor(n) * 86_400_000;
	};
	const spec: IssueHubTokenSpec = {
		actor,
		team: str(body.team),
		token_class: cls,
		scopes,
		label: str(body.label),
		accessTtlMs: ttlDays(body.access_ttl_days),
		refreshTtlMs: ttlDays(body.refresh_ttl_days),
	};
	const pair = issueHubToken(store, spec, boardActor());
	return json(
		{
			ok: true,
			token: {
				jti: pair.jti,
				// raw material exists exactly once — this response
				access: pair.access,
				refresh: pair.refresh,
				expires_at: pair.expires_at,
				refresh_expires_at: pair.refresh_expires_at,
			},
		},
		201,
	);
}

async function revokeRoute(
	store: GovernorStore,
	req: Request,
): Promise<Response> {
	const parsed = await readJson(req);
	if (!parsed.ok) return parsed.resp;
	const jti = str(parsed.body.jti);
	const actor = str(parsed.body.actor);
	const team = str(parsed.body.team);
	if (jti === null && actor === null && team === null)
		return json(
			{ ok: false, error: "one selector required: jti | actor | team" },
			400,
		);
	const out = revokeHubToken(
		store,
		{
			jti: jti ?? undefined,
			actor: actor ?? undefined,
			team: team ?? undefined,
		},
		boardActor(),
	);
	return json({ ok: true, changes: out.changes });
}

function providerKeysPayload(): Record<string, unknown> {
	const home = providerConfigHome();
	return {
		ok: true,
		home: scrub(home),
		files: presentEnvFiles(home),
		keys: providerKeyInventory(),
	};
}

function boardActor(): string {
	return consoleMe().actor ?? "board";
}
