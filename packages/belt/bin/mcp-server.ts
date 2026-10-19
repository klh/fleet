#!/usr/bin/env bun
// mcp-server.ts — W260: belt's MCP server surface. Model Context Protocol over
// Streamable HTTP (JSON-RPC 2.0 on POST /mcp), auth-gated by Entra ID bearer
// tokens (mcp-auth.ts), exposing the fleet knowledge store and belt-routed
// inference (mcp-tools.ts). Registerable as a Copilot Studio action via the
// MCP Toolkit — docs/mcp.md carries the config + registration runbook.
//
//   bun bin/mcp-server.ts                # :7793 (BELT_MCP_PORT), loopback bind
//   curl -s 127.0.0.1:7793/health        # process liveness
//
// Auth posture (enterprise law: auth on product surfaces): without
// BELT_MCP_TENANT + BELT_MCP_AUDIENCE the server refuses to serve /mcp unless
// BELT_MCP_DEV=1 — dev mode pins the loopback and logs the downgrade. No
// tokens are ever read from the repo (config-over-code).
import {
	bearerOf,
	loadMcpAuthConfig,
	verifyEntraToken,
	type McpAuthConfig,
} from "./mcp-auth.ts";
import { SERVER_INFO, TOOLS, callTool } from "./mcp-tools.ts";
import {
	citizenshipGate,
	methodNotAllowed,
	problem,
} from "./http-citizenship.ts";
import { livenessResponse } from "./health.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Machine-level config (config-over-code): BELT_MCP_* / BELT_ROUTER_URL live
// in ~/.claude/local-llm/belt-mcp.env (0600, operator-owned, never the repo).
// Loaded into process.env at boot so launchd needs no env plumbing. Existing
// process env always wins — the file only fills gaps.
const loadEnvFile = (): void => {
	try {
		const raw = readFileSync(
			join(process.env.HOME ?? ".", ".claude/local-llm/belt-mcp.env"),
			"utf8",
		);
		for (const line of raw.split("\n")) {
			const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
			if (!m) continue;
			const key = m[1] ?? "";
			if (!(key in process.env)) process.env[key] = m[2] ?? "";
		}
	} catch {} // no config file → env-only, honest
};
loadEnvFile();

// MCP wire versions this server speaks. Streamable HTTP arrived in
// 2025-03-26; 2025-06-18 is the current one. Negotiation echoes the client's
// when we support it, else the newest we speak.
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26"];
const LATEST_VERSION = SUPPORTED_VERSIONS[0] ?? "2025-06-18";
const ROUTES = {
	"/mcp": ["POST", "GET", "DELETE"],
	"/health": ["GET", "HEAD"],
};
const SESSION_TTL_MS = 86_400_000;

const PORT = Number(process.env.BELT_MCP_PORT ?? 7793);
const BIND = process.env.BELT_MCP_BIND ?? "127.0.0.1";
const DEV = process.env.BELT_MCP_DEV === "1";
const AUTH: McpAuthConfig | null = loadMcpAuthConfig();
const EXTRA_HOSTS = (process.env.BELT_MCP_HOSTS ?? "")
	.split(",")
	.map((h) => h.trim())
	.filter(Boolean);

if (!AUTH && !DEV) {
	console.error(
		"belt-mcp: no Entra config (BELT_MCP_TENANT / BELT_MCP_AUDIENCE) — status only; MCP tools unavailable.",
	);
}
if (!AUTH && BIND !== "127.0.0.1" && BIND !== "localhost") {
	console.error("belt-mcp: without Entra auth, bind must be loopback");
	process.exit(1);
}
if (DEV) console.error("belt-mcp: DEV MODE — auth disabled, loopback only");

// Host guard (MCP spec security guidance + the fleet perimeter law): only
// loopback spellings and operator-declared hosts (BELT_MCP_HOSTS, e.g. the
// Caddy .local front) pass — DNS-rebinding names get 403.
const hostAllowed = (host: string | null): boolean => {
	if (!host) return false;
	const bare = host.toLowerCase().split(":")[0] ?? "";
	if (bare === "127.0.0.1" || bare === "localhost" || bare === "::1")
		return true;
	return EXTRA_HOSTS.some((h) => h === bare || h === host.toLowerCase());
};

const sessions = new Map<string, number>();
const sessionGc = () => {
	const now = Date.now();
	for (const [sid, at] of sessions)
		if (now - at > SESSION_TTL_MS) sessions.delete(sid);
};

interface RpcMsg {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
}

const rpcResult = (id: RpcMsg["id"], result: unknown) =>
	({ jsonrpc: "2.0", id, result }) as const;
const rpcError = (id: RpcMsg["id"], code: number, message: string) =>
	({ jsonrpc: "2.0", id, error: { code, message } }) as const;

async function dispatch(msg: RpcMsg): Promise<unknown> {
	switch (msg.method) {
		case "initialize": {
			const asked = msg.params?.protocolVersion;
			const version =
				typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked)
					? asked
					: LATEST_VERSION;
			return {
				protocolVersion: version,
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
				instructions:
					"klh fleet MCP surface: search the fleet knowledge store, run belt-routed LLM inference.",
			};
		}
		case "ping":
			return {};
		case "tools/list":
			return { tools: TOOLS };
		case "tools/call": {
			const name = msg.params?.name;
			if (typeof name !== "string")
				return rpcError(msg.id, -32602, "tools/call requires a tool name");
			const rawArgs = msg.params?.arguments;
			const args =
				rawArgs && typeof rawArgs === "object"
					? (rawArgs as Record<string, unknown>)
					: {};
			if (name !== "knowledge_search" && name !== "belt_infer")
				return rpcError(msg.id, -32602, `unknown tool: ${name}`);
			const { text, isError } = await callTool(name, args);
			return { content: [{ type: "text", text }], isError };
		}
		default:
			return rpcError(
				msg.id,
				-32601,
				`method not found: ${String(msg.method)}`,
			);
	}
}

const sseWrap = (payload: unknown, headers: Record<string, string>): Response =>
	new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
		headers: { ...headers, "cache-control": "no-store" },
	});

const authGate = async (
	req: Request,
	pathname: string,
): Promise<Response | null> => {
	if (!AUTH || pathname !== "/mcp") return null;
	const token = bearerOf(req.headers.get("authorization"));
	if (!token)
		return problem(
			401,
			"Unauthorized",
			"belt.mcp.unauthorized",
			"Entra ID bearer token required (Authorization: Bearer <jwt>)",
			pathname,
			undefined,
			{ "www-authenticate": "Bearer" },
		);
	const verdict = await verifyEntraToken(token, AUTH);
	if (!verdict.ok)
		return problem(
			401,
			"Unauthorized",
			"belt.mcp.unauthorized",
			`token rejected: ${verdict.reason ?? "invalid"}`,
			pathname,
			undefined,
			{ "www-authenticate": "Bearer" },
		);
	return null;
};

async function handleMcpPost(req: Request): Promise<Response> {
	let msg: RpcMsg;
	try {
		msg = (await req.json()) as RpcMsg;
	} catch {
		return new Response(JSON.stringify(rpcError(null, -32700, "parse error")), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
	if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
		return new Response(
			JSON.stringify(rpcError(msg.id ?? null, -32600, "invalid request")),
			{ status: 400, headers: { "content-type": "application/json" } },
		);

	// session: initialize mints one; unknown echoed ids are 404 per the spec;
	// headerless requests ride stateless (connectors vary).
	const reqSid = req.headers.get("mcp-session-id");
	if (reqSid && !sessions.has(reqSid))
		return problem(
			404,
			"Not Found",
			"belt.mcp.session_unknown",
			"unknown or expired MCP session",
			"/mcp",
		);
	let mintedSid: string | null = null;
	if (msg.method === "initialize") {
		sessionGc();
		mintedSid = crypto.randomUUID();
		sessions.set(mintedSid, Date.now());
	}

	const isNotification = msg.id === undefined || msg.id === null;
	const out = await dispatch(msg);
	if (isNotification) return new Response(null, { status: 202 });
	const body =
		out !== null && typeof out === "object" && "error" in (out as object)
			? (out as Record<string, unknown>)
			: rpcResult(msg.id, out);

	// Streamable HTTP: clients Accept both families; an event-stream-only
	// client gets the single response wrapped as one SSE message.
	const accept = req.headers.get("accept") ?? "";
	const sseOnly =
		accept.includes("text/event-stream") &&
		!accept.includes("application/json");
	const headers: Record<string, string> = {
		"content-type": sseOnly ? "text/event-stream" : "application/json",
	};
	const activeSid = reqSid ?? mintedSid;
	if (activeSid) headers["mcp-session-id"] = activeSid;
	return sseOnly
		? sseWrap(body, headers)
		: new Response(JSON.stringify(body), { status: 200, headers });
}

const server = Bun.serve({
	port: PORT,
	hostname: BIND,
	idleTimeout: 180, // belt_infer can legitimately run long on the swarm
	async fetch(req): Promise<Response> {
		const pathname = new URL(req.url).pathname;
		if (!AUTH && !DEV) {
			if (pathname === "/" && req.method === "GET")
				return new Response(
					`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Belt MCP · setup needed</title><style>body{margin:0;background:#171717;color:#e8e6e2;font:14px system-ui,sans-serif}main{max-width:620px;margin:12vh auto;padding:0 24px}small{color:#a6a29b;letter-spacing:.12em;text-transform:uppercase}h1{font-size:26px;font-weight:550;margin:22px 0 12px}p{line-height:1.6;color:#bbb7af}code{font:12px ui-monospace,monospace;color:#d99a25}a{color:#d99a25}hr{border:0;border-top:1px solid #393735;margin:28px 0}</style><main><small>klh·fleet / belt</small><h1>MCP setup needed</h1><p>The Belt MCP service is running, but its Entra tenant and audience are not configured. Tools remain unavailable until authentication is configured.</p><hr><p>Configure <code>BELT_MCP_TENANT</code> and <code>BELT_MCP_AUDIENCE</code> in the machine-level <code>belt-mcp.env</code>, then restart the service. See <a href="https://github.com/klh/fleet/blob/main/packages/belt/docs/mcp.md">setup instructions</a>.</p></main></html>`,
					{
						status: 503,
						headers: { "content-type": "text/html; charset=utf-8" },
					},
				);
			return new Response(
				JSON.stringify({
					ok: false,
					service: "belt-mcp",
					status: "unconfigured",
					tools: "unavailable",
				}),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}
		const live = livenessResponse(req, "belt-mcp", {
			transport: "streamable-http",
			auth: AUTH ? "entra-oauth" : DEV ? "dev-open" : "closed",
		});
		if (live) return live;
		if (pathname !== "/mcp")
			return problem(
				404,
				"Not Found",
				"belt.mcp.no_route",
				`no route: ${pathname}`,
				pathname,
			);
		const gate = citizenshipGate(req, ROUTES);
		if (gate) return gate;
		if (!hostAllowed(req.headers.get("host")))
			return problem(
				403,
				"Forbidden",
				"belt.mcp.host_forbidden",
				"host not allowed (loopback or BELT_MCP_HOSTS only)",
				pathname,
			);
		const authFail = await authGate(req, pathname);
		if (authFail) return authFail;
		if (req.method === "POST") return handleMcpPost(req);
		if (req.method === "GET")
			return methodNotAllowed("/mcp", ROUTES["/mcp"] ?? ["POST"]);
		// DELETE — session termination; we accept and drop nothing stateful
		// beyond the echoed id (sessions expire on their own).
		return new Response(null, { status: 204 });
	},
});

console.error(
	`belt-mcp: ${SERVER_INFO.name}@${SERVER_INFO.version} on ${BIND}:${PORT} (${AUTH ? "entra-oauth" : DEV ? "dev-open" : "status-only"})`,
);

export { server as mcpServer };
