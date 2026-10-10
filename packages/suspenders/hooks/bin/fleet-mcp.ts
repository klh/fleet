// fleet-mcp.ts — W607: the fleet MCP server for chat GUIs (Claude desktop,
// ChatGPT desktop developer mode, any MCP client). Six READ surfaces off the
// live governor.db: work ready/list/show, coord fleet (lanes), coord fact
// get/list, coord metrics. GUI fleet access rides the buckle plane like
// lanes do: the key is a minted bksk_ key (scope buckle:proxy:READ_),
// verified per call against GET /v1/fleet/whoami on the buckle front
// (revocation takes effect within the 30s cache), never typed in any repo.
//
// Auth (all machine-level runtime config, mode 600 where a file):
//   FLEET_MCP_KEY            the bksk_ key (desktop mcpServers env)
//   FLEET_MCP_KEY_FILE       alt: path to a 0600 file holding the key
//   SUSPENDERS_BUCKLE_FRONT  buckle front (default http://127.0.0.1:4101)
//   FLEET_MCP_PROJECT        work-graph project path (default: cwd identity —
//                            desktop GUIs spawn at /, SET THIS in the config)
//   FLEET_MCP_AUDIT          audit JSONL (default ~/.claude-insights/
//                            fleet-mcp-audit.jsonl, 0600)
//
// Mint the GUI key once, from the belt.env admin (same plane as lanes):
//   curl -s http://127.0.0.1:4101/v1/admin/keys \
//     -H "authorization: Bearer $BUCKLE_ADMIN_KEY" \
//     -d '{"name":"claude-desktop","scopes":["buckle:proxy:READ_"]}'
// Revoke = POST /v1/admin/keys/<key_id>/revoke — the server refuses within
// one cache window. Mint/verify/revoke all land in buckle's auth ledger.
//
// wire into ~/.claude.json mcpServers (or any MCP client config):
//   "fleet": {
//     "command": "bun",
//     "args": ["~/.claude/hooks/suspenders/bin/fleet-mcp.ts"],
//     "env": { "FLEET_MCP_KEY": "bksk_…", "FLEET_MCP_PROJECT": "/path/to/repo" }
//   }
// ChatGPT desktop (developer mode) needs a reachable URL — run the stateless
// HTTP face with `fleet-mcp.ts --http <port>` (POST /mcp, Bearer key) and
// front it with a real host (belt.local/Caddy); localhost is fetched
// server-side by ChatGPT and will not resolve.
import { createInterface } from "node:readline";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	openGovernorDb,
	projectIdentity,
	tokenUsage,
	workTiming,
	type ItemTiming,
} from "../lib/govdb.ts";
import { unmergedDeps } from "../lib/dep-merge-gate.ts";

const VERSION = "0.1.0";

// MCP protocol version supported by this server
const PROTOCOL = "2024-11-05";

const FRONT = (
	process.env.SUSPENDERS_BUCKLE_FRONT ?? "http://127.0.0.1:4101"
).replace(/\/$/, "");
const SCOPE_NEEDED = "buckle:proxy:READ_";
// resolve through projectIdentity: a worktree path canonicalizes to the
// repo's git-common-dir — the same identity the work graph stores
const PROJECT = projectIdentity(process.env.FLEET_MCP_PROJECT ?? process.cwd());
const AUDIT_PATH =
	process.env.FLEET_MCP_AUDIT ??
	`${process.env.HOME}/.claude-insights/fleet-mcp-audit.jsonl`;

// ─── auth: whoami probe on the buckle front, 30s shared cache ───

type AuthVerdict = { ok: true; keyId: string } | { ok: false; why: string };

let keyCache: string | null | undefined;
function theKey(): string | null {
	if (keyCache !== undefined) return keyCache;
	const file = process.env.FLEET_MCP_KEY_FILE;
	keyCache =
		process.env.FLEET_MCP_KEY ??
		(file && existsSync(file) ? readFileSync(file, "utf8").trim() : null);
	return keyCache;
}

let authCache: { at: number; v: AuthVerdict } | null = null;
const AUTH_TTL_MS = 30_000;

function setAuth(v: AuthVerdict): AuthVerdict {
	authCache = { at: Date.now(), v };
	return v;
}

/** Live-key check: 401 → unknown/revoked; 403 → valid key, wrong scope;
 *  network miss → deny (fail-closed, like dispatch). */
async function ensureAuth(force = false): Promise<AuthVerdict> {
	if (!force && authCache && Date.now() - authCache.at < AUTH_TTL_MS)
		return authCache.v;
	const k = theKey();
	if (k === null)
		return setAuth({
			ok: false,
			why: "no FLEET_MCP_KEY (or FLEET_MCP_KEY_FILE) — mint one via the buckle admin API",
		});
	try {
		const r = await fetch(`${FRONT}/v1/fleet/whoami`, {
			headers: { authorization: `Bearer ${k}` },
			signal: AbortSignal.timeout(2500),
		});
		if (r.status === 401)
			return setAuth({
				ok: false,
				why: `buckle rejected the key (401) — unknown, expired or revoked; mint a fresh one at ${FRONT}`,
			});
		const b = (await r.json().catch(() => null)) as {
			authenticated?: boolean;
			key_id?: string;
			scopes?: string[];
		} | null;
		if (r.status === 403)
			return setAuth({
				ok: false,
				why: `key ${b?.key_id ?? "?"} lacks ${SCOPE_NEEDED} — re-mint with the fleet-read scope`,
			});
		if (!r.ok || b === null || b.authenticated !== true)
			return setAuth({
				ok: false,
				why: `buckle whoami answered ${r.status} — front unhealthy at ${FRONT}`,
			});
		if (!b.scopes?.includes(SCOPE_NEEDED))
			return setAuth({
				ok: false,
				why: `key ${b.key_id ?? "?"} scopes ${JSON.stringify(b.scopes)} lack ${SCOPE_NEEDED}`,
			});
		return setAuth({ ok: true, keyId: b.key_id ?? "unknown" });
	} catch (e) {
		return setAuth({
			ok: false,
			why: `buckle front unreachable at ${FRONT}: ${e instanceof Error ? e.message : String(e)}`,
		});
	}
}

// ─── audit: every tool call lands in the 0600 JSONL trail ───

let auditReady = false;
function audit(row: {
	tool: string;
	keyId: string | null;
	ok: boolean;
	ms: number;
	detail?: string;
}): void {
	try {
		if (!auditReady) {
			mkdirSync(dirname(AUDIT_PATH), { recursive: true });
			// append creates the file synchronously; chmod 600 lands before
			// the first real row is visible through it
			appendFileSync(AUDIT_PATH, "");
			chmodSync(AUDIT_PATH, 0o600);
			auditReady = true;
		}
		appendFileSync(
			AUDIT_PATH,
			`${JSON.stringify({ ts: Date.now(), ...row })}\n`,
		);
	} catch {
		// audit best-effort — never break the tool answer on an audit miss
	}
}

// ─── the read surfaces (governor.db, live) ───

interface Item {
	id: string;
	title: string;
	description: string | null;
	state: string;
	priority: number;
	owner_sid: string | null;
	result_sha: string | null;
	created_at: number;
	updated_at: number;
}

const db = () => openGovernorDb();

function depsFor(
	id: string,
	project: string,
): { depends_on: string; state: string | null; result_sha: string | null }[] {
	return db()
		.query(
			"SELECT d.depends_on, w.state, w.result_sha FROM work_deps d LEFT JOIN work_items w ON w.id = d.depends_on AND w.project = d.project WHERE d.project = ? AND d.work_id = ?",
		)
		.all(project, id) as {
		depends_on: string;
		state: string | null;
		result_sha: string | null;
	}[];
}

// exact `work ready` parity: state READY, all deps DONE, none unmerged
function depsMet(id: string, project: string): boolean {
	const rows = depsFor(id, project);
	return (
		rows.every((d) => d.state === "DONE") &&
		unmergedDeps(rows, project).length === 0
	);
}

const trunc = (s: string, n: number): string =>
	s.length > n ? `${s.slice(0, n - 1)}…` : s;

function itemLine(r: Item): string {
	const pr = r.priority > 0 ? ` ⭑${r.priority}` : "";
	const own = r.owner_sid ? ` · ${r.owner_sid.slice(0, 8)}` : "";
	return `${r.id}${pr} — ${trunc(r.title, 90)}${own}`;
}

function workReady(project: string): string {
	const all = db()
		.query(
			"SELECT * FROM work_items WHERE project = ? AND state = 'READY' ORDER BY priority DESC, id",
		)
		.all(project) as Item[];
	const rows = all.filter((r) => depsMet(r.id, project));
	if (rows.length === 0) return `READY (none) [${project}]`;
	const gated = all.length - rows.length;
	return `READY (${rows.length}) [${project}]\n${rows.map(itemLine).join("\n")}${gated > 0 ? `\n(${gated} more READY with unmet/unmerged deps)` : ""}`;
}

function workList(mode: string, project: string): string {
	const rows =
		mode === "all"
			? (db()
					.query("SELECT * FROM work_items WHERE project = ? ORDER BY id")
					.all(project) as Item[])
			: (db()
					.query(
						"SELECT * FROM work_items WHERE project = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED') ORDER BY id",
					)
					.all(project) as Item[]);
	if (rows.length === 0) return `(no ${mode} items) [${project}]`;
	const lines = rows.map((r) => `${r.id} ${r.state} — ${trunc(r.title, 80)}`);
	return `WORK ${mode} (${rows.length}) [${project}]\n${lines.join("\n")}`;
}

function workShow(id: string, project: string): string {
	const r = db()
		.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
		.get(project, id) as Item | null;
	if (r === null) return `no such item: ${id} [${project}]`;
	const deps = depsFor(id, project).map(
		(d) => `${d.depends_on}:${d.state ?? "MISSING"}`,
	);
	return [
		`${r.id} [${r.state}]${r.priority > 0 ? ` ⭑${r.priority}` : ""} — ${r.title}`,
		`owner: ${r.owner_sid ?? "(none)"} · created ${new Date(r.created_at).toISOString()} · updated ${new Date(r.updated_at).toISOString()}`,
		r.description ? `desc: ${trunc(r.description, 600)}` : null,
		deps.length ? `deps: ${deps.join(", ")}` : null,
		r.result_sha ? `result: ${r.result_sha.slice(0, 12)}` : null,
	]
		.filter((l) => l !== null)
		.join("\n");
}

// the `coord fleet` projection (lane states + claim intents, live)
function coordFleet(): string {
	const crows = db()
		.query("SELECT sid, intent FROM claims ORDER BY sid")
		.all() as { sid: string; intent: string | null }[];
	const lanes = [...new Set(crows.map((c) => c.sid))].sort();
	const states = db()
		.query("SELECT key, value FROM facts WHERE key LIKE 'lane.%.state'")
		.all() as { key: string; value: string }[];
	const byKey = new Map(states.map((s) => [s.key, s.value]));
	const lines = lanes.map((l) => {
		const st = byKey.get(`lane.${l}.state`) ?? "RUNNING";
		const intent = crows.find((c) => c.sid === l)?.intent ?? null;
		return `${st} ${l.slice(0, 8)}${intent ? ` — ${trunc(intent, 60)}` : ""}`;
	});
	return `FLEET (${lanes.length} lanes)\n${lines.join("\n") || "(no claimed lanes)"}`;
}

function factGet(key: string): string {
	const r = db()
		.query("SELECT value, version, ts, source FROM facts WHERE key = ?")
		.get(key) as {
		value: string;
		version: number;
		ts: number;
		source: string | null;
	} | null;
	if (r === null) return `no fact: ${key}`;
	return `${key} = ${r.value} (v${r.version}${r.source ? `, ${r.source}` : ""}, ${new Date(r.ts).toISOString()})`;
}

function factList(prefix: string | null, limit: number): string {
	const where = prefix ? "WHERE key LIKE ?" : "";
	const args: (string | number)[] = prefix ? [`${prefix}%`, limit] : [limit];
	const rows = db()
		.query(
			`SELECT key, value, version FROM facts ${where} ORDER BY key LIMIT ?`,
		)
		.all(...args) as { key: string; value: string; version: number }[];
	if (rows.length === 0) return `(no facts${prefix ? ` under ${prefix}` : ""})`;
	const more = rows.length >= limit ? "+" : "";
	const lines = rows.map(
		(r) => `${r.key} = ${trunc(r.value, 100)} (v${r.version})`,
	);
	return `FACTS (${rows.length}${more})\n${lines.join("\n")}`;
}

// the `coord metrics` projection: runs, throughput, medians, tokens
function metrics(days: number, project: string): string {
	const now = Date.now();
	const cut = now - days * 86_400_000;
	const runs = db()
		.query(
			"SELECT role, COUNT(*) AS n FROM sessions WHERE project = ? AND started_at >= ? GROUP BY role ORDER BY n DESC",
		)
		.all(project, cut) as { role: string; n: number }[];
	const timing: ItemTiming[] = workTiming(db(), project, now).filter(
		(t) => t.lastEvent >= cut || (!t.done && !t.failed),
	);
	const doneItems = timing.filter((t) => t.done && t.firstClaim > 0);
	const openN = timing.filter((t) => !t.done && !t.failed).length;
	const med = (xs: number[]): number =>
		xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
	const fmt = (ms: number): string => {
		if (ms === 0) return "—";
		const m = Math.round(ms / 60_000);
		return m >= 60
			? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
			: `${m}m`;
	};
	const tokens = tokenUsage(db(), project, now);
	let sumIn = 0;
	let sumOut = 0;
	for (const t of tokens.values()) {
		if (t === null) continue;
		sumIn += t.in;
		sumOut += t.out;
	}
	const fmtN = (n: number): string =>
		n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${Math.round(n / 1e3)}k`
				: `${n}`;
	const tok =
		sumIn > 0 || sumOut > 0
			? ` — tokens in ${fmtN(sumIn)}, out ${fmtN(sumOut)}`
			: "";
	const name = project.split("/").pop() ?? project;
	const runN = runs.reduce((a, r) => a + r.n, 0);
	const runDetail = runs.length
		? ` (${runs.map((r) => `${r.n} ${r.role}`).join(", ")})`
		: "";
	return `METRICS ${name} (last ${days}d): runs ${runN}${runDetail}; items ${doneItems.length} done, ${openN} open — median done: wall ${fmt(med(doneItems.map((t) => t.wallMs)))}, agent ${fmt(med(doneItems.map((t) => t.agentMs)))}${tok}`;
}

// ─── MCP tools ───

const TOOLS = [
	{
		name: "fleet_work_ready",
		description:
			"Claimable fleet work: READY items whose dependencies are all DONE and merged (exact `work ready` parity) from the live work graph. The answer to 'what is READY?'.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: `repo path; default ${PROJECT}`,
				},
			},
		},
	},
	{
		name: "fleet_work_list",
		description:
			"Fleet work items, open (default) or all states, from the live work graph.",
		inputSchema: {
			type: "object",
			properties: {
				mode: {
					type: "string",
					enum: ["open", "all"],
					description: "open (default) skips DONE/CANCELLED/SUPERSEDED",
				},
				project: { type: "string", description: `default ${PROJECT}` },
			},
		},
	},
	{
		name: "fleet_work_show",
		description: "One work item in full: state, owner, description, deps.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "item id, e.g. W607" },
				project: { type: "string", description: `default ${PROJECT}` },
			},
			required: ["id"],
		},
	},
	{
		name: "fleet_coord_fleet",
		description:
			"Who is working: claimed lanes with their live state (RUNNING/PAUSED/BLOCKED…) and claim intents — the `coord fleet` projection.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "fleet_coord_fact",
		description:
			"Fleet knowledge facts (governor.db): get one by exact key, or list by key prefix (e.g. lesson.*, finding.*).",
		inputSchema: {
			type: "object",
			properties: {
				key: { type: "string", description: "exact key for a get" },
				prefix: { type: "string", description: "key prefix for a list" },
				limit: { type: "number", description: "list cap (default 40)" },
			},
		},
	},
	{
		name: "fleet_coord_metrics",
		description:
			"Control-plane metrics: runs by role, items done/open, median wall/agent time, token usage — the `coord metrics` projection.",
		inputSchema: {
			type: "object",
			properties: {
				days: { type: "number", description: "window (default 7)" },
				project: { type: "string", description: `default ${PROJECT}` },
			},
		},
	},
];

interface RpcMsg {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
}

const writeMsg = (msg: unknown): void => {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const respond = (id: RpcMsg["id"], result: unknown): void =>
	writeMsg({ jsonrpc: "2.0", id, result });
const respondErr = (id: RpcMsg["id"], code: number, message: string): void =>
	writeMsg({ jsonrpc: "2.0", id, error: { code, message } });
const sOf = (v: unknown): string | null =>
	typeof v === "string" && v.trim() ? v.trim() : null;

const text = (body: string): unknown => ({
	content: [{ type: "text", text: body }],
});

// one tool call, auth-gated + audited. Auth/health misses come back as
// isError results (chat GUIs read the text and can tell the owner);
// protocol errors (unknown tool, bad args) stay JSON-RPC errors.
async function handleCall(params: Record<string, unknown>): Promise<unknown> {
	const t0 = Date.now();
	const a = (params.arguments ?? {}) as Record<string, unknown>;
	const name = sOf(params.name) ?? "(none)";
	const auth = await ensureAuth();
	if (!auth.ok) {
		audit({
			tool: name,
			keyId: null,
			ok: false,
			ms: Date.now() - t0,
			detail: auth.why,
		});
		return {
			content: [{ type: "text", text: `fleet MCP refused: ${auth.why}` }],
			isError: true,
		};
	}
	let body: string;
	try {
		body = await dispatch(name, a);
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		audit({
			tool: name,
			keyId: auth.keyId,
			ok: false,
			ms: Date.now() - t0,
			detail: why,
		});
		return {
			content: [{ type: "text", text: `fleet tool ${name} failed: ${why}` }],
			isError: true,
		};
	}
	audit({ tool: name, keyId: auth.keyId, ok: true, ms: Date.now() - t0 });
	return text(body);
}

async function dispatch(
	name: string,
	a: Record<string, unknown>,
): Promise<string> {
	const project = sOf(a.project) ?? PROJECT;
	switch (name) {
		case "fleet_work_ready":
			return workReady(project);
		case "fleet_work_list":
			return workList(sOf(a.mode) ?? "open", project);
		case "fleet_work_show": {
			const id = sOf(a.id);
			if (id === null) throw new Error("fleet_work_show requires an id");
			return workShow(id, project);
		}
		case "fleet_coord_fleet":
			return coordFleet();
		case "fleet_coord_fact": {
			const key = sOf(a.key);
			if (key !== null) return factGet(key);
			return factList(
				sOf(a.prefix),
				typeof a.limit === "number" ? Math.trunc(a.limit) : 40,
			);
		}
		case "fleet_coord_metrics":
			return metrics(
				typeof a.days === "number" ? Math.max(1, Math.trunc(a.days)) : 7,
				project,
			);
		default:
			throw Object.assign(new Error(`unknown tool: ${name}`), {
				code: -32602,
			});
	}
}

function onMessage(msg: RpcMsg): void {
	if (msg.id === undefined) return; // notification — no reply
	switch (msg.method) {
		case "initialize":
			respond(msg.id, {
				protocolVersion: sOf(msg.params?.protocolVersion) ?? PROTOCOL,
				capabilities: { tools: {} },
				serverInfo: { name: "fleet-mcp", version: VERSION },
			});
			return;
		case "tools/list":
			respond(msg.id, { tools: TOOLS });
			return;
		case "tools/call":
			handleCall(msg.params ?? {})
				.then((result) => respond(msg.id, result))
				.catch((e: Error & { code?: number }) =>
					respondErr(msg.id ?? null, e.code ?? -32603, e.message),
				);
			return;
		default:
			respondErr(msg.id, -32601, `method not found: ${msg.method ?? "?"}`);
	}
}

// ─── transports: stdio (Claude desktop et al.) or --http <port> ───

const httpArg = process.argv.indexOf("--http");
if (httpArg !== -1) {
	const port = Number(process.argv[httpArg + 1] ?? 0);
	if (!Number.isInteger(port) || port <= 0) {
		console.error("fleet-mcp: --http needs a port");
		process.exit(2);
	}
	Bun.serve({
		port,
		fetch: async (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/health")
				return new Response("ok", {
					headers: { "content-type": "text/plain" },
				});
			if (req.method !== "POST" || path !== "/mcp")
				return new Response("not found", { status: 404 });
			// the bearer IS the fleet key — same whoami plane as stdio
			const k = theKey();
			const header = req.headers.get("authorization") ?? "";
			const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
			if (k === null)
				return Response.json(
					{ error: "no FLEET_MCP_KEY configured" },
					{ status: 503 },
				);
			if (presented !== k)
				return Response.json({ error: "auth mismatch" }, { status: 401 });
			const auth = await ensureAuth();
			if (!auth.ok) return Response.json({ error: auth.why }, { status: 401 });
			let msg: RpcMsg;
			try {
				msg = (await req.json()) as RpcMsg;
			} catch {
				return Response.json({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "parse error" },
				});
			}
			if (msg.id === undefined || msg.id === null)
				return new Response(null, { status: 202 }); // notification
			switch (msg.method) {
				case "initialize":
					return Response.json({
						jsonrpc: "2.0",
						id: msg.id,
						result: {
							protocolVersion: sOf(msg.params?.protocolVersion) ?? PROTOCOL,
							capabilities: { tools: {} },
							serverInfo: { name: "fleet-mcp", version: VERSION },
						},
					});
				case "tools/list":
					return Response.json({
						jsonrpc: "2.0",
						id: msg.id,
						result: { tools: TOOLS },
					});
				case "tools/call":
					return Response.json({
						jsonrpc: "2.0",
						id: msg.id,
						result: await handleCall(msg.params ?? {}),
					});
				default:
					return Response.json({
						jsonrpc: "2.0",
						id: msg.id,
						error: {
							code: -32601,
							message: `method not found: ${msg.method ?? "?"}`,
						},
					});
			}
		},
	});
	console.error(`fleet-mcp: http face on :${port} (POST /mcp, Bearer key)`);
} else {
	// stdio loop: newline-delimited JSON-RPC, protocol-only stdout
	const rl = createInterface({ input: process.stdin, terminal: false });
	rl.on("line", (line) => {
		if (!line.trim()) return;
		let msg: RpcMsg;
		try {
			msg = JSON.parse(line) as RpcMsg;
		} catch {
			respondErr(null, -32700, "parse error");
			return;
		}
		try {
			onMessage(msg);
		} catch (e) {
			const err = e as Error & { code?: number };
			respondErr(msg.id ?? null, err.code ?? -32603, err.message);
		}
	});
	console.error(
		`fleet-mcp: ready (project ${PROJECT}, front ${FRONT}) — fleet surfaces on stdio`,
	);
}
