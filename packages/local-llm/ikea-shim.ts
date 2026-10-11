#!/usr/bin/env bun
// ikea-shim.ts — anthropic→copilot gateway (W226).
// Anthropic /v1/messages in → GitHub Copilot chat-completions out, so the
// interactive claude CLI (ANTHROPIC_BASE_URL → this shim) goes to the seat's
// models. Loopback-only bind (W204 law). Secrets: the long-lived gho_ token
// is minted ON-device via `login` (0600 file, never printed); copilot session
// tokens live in memory only. Model routing = map in ikea.env (machine cfg).
//
//   bun ikea-shim.ts            serve on :4102 (launchd entrypoint)
//   bun ikea-shim.ts login      device-flow mint (human enters the code)
//   bun ikea-shim.ts status     outside-process probe + credential check
//   bun ikea-shim.ts selftest   3-leg live verify (plain / stream / tools)

import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";

const HOME = process.env.HOME;
const LLM_HOME = `${HOME}/.claude/local-llm`;
const TOK_FILE = `${LLM_HOME}/ikea-github.token`;
const ENV_FILE = `${LLM_HOME}/ikea.env`;
const LOG_FILE = `${HOME}/.claude-insights/ikea-shim.log`;
const PORT = Number(process.env.IKEA_PORT ?? 4102);
const BASE = `http://127.0.0.1:${PORT}`;

// The VS Code Copilot OAuth app — allowlisted for the copilot_internal
// token exchange (gh CLI's own app 403s; verified 2026-10-05).
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_URL = "https://github.com/login/device/code";
const OAUTH_URL = "https://github.com/login/oauth/access_token";
const INTERNAL_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

type ModelMap = {
	default: string;
	haiku?: string;
	sonnet?: string;
	opus?: string;
};

// ─── machine config (config-over-code: values only ever in LLM_HOME) ───
function envFile(): Record<string, string> {
	const cache: Record<string, string> = {};
	try {
		const lines = readFileSync(ENV_FILE, "utf8").split("\n");
		for (const raw of lines) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const eq = line.indexOf("=");
			if (eq < 1) continue;
			let val = line.slice(eq + 1).trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			)
				val = val.slice(1, -1);
			cache[line.slice(0, eq).trim()] = val;
		}
	} catch {}
	return cache;
}

function cfg(key: string): string | undefined {
	return process.env[key] ?? envFile()[key];
}

function modelMap(): ModelMap {
	const dflt: ModelMap = {
		default: "gpt-5",
		haiku: "gpt-4.1-mini",
		sonnet: "gpt-5",
		opus: "gpt-5",
	};
	const raw = cfg("IKEA_MODEL_MAP");
	if (!raw) return dflt;
	try {
		return { ...dflt, ...(JSON.parse(raw) as Partial<ModelMap>) };
	} catch {
		return dflt;
	}
}

function mapModel(incoming: string | undefined): string {
	const m = modelMap();
	const inc = (incoming ?? "").toLowerCase();
	if (inc === "haiku" || inc.includes("haiku")) return m.haiku ?? m.default;
	if (inc === "opus" || inc.includes("opus")) return m.opus ?? m.default;
	if (inc.includes("sonnet") || inc.includes("fable"))
		return m.sonnet ?? m.default;
	if (inc && inc in m) return m[inc as keyof ModelMap];
	return m.default;
}

// ─── credential chain: gho_ (0600 file / env) → copilot session token ───
function ghToken(): string | null {
	const fromEnv = cfg("IKEA_GITHUB_TOKEN");
	if (fromEnv) return fromEnv;
	try {
		const t = readFileSync(TOK_FILE, "utf8").trim();
		return t || null;
	} catch {
		return null;
	}
}

let session: { token: string; api: string; exp: number } | null = null;

type ShimError = { anthropic: true; type: string; message: string };

function shimError(type: string, message: string): ShimError {
	return { anthropic: true, type, message };
}

function errmsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// copilot session token (short-lived) — exchange, cache, refresh.
// IKEA_TOKEN_URL_OVERRIDE / IKEA_API_OVERRIDE exist for the mock-upstream
// selftest lane; production never sets them.
async function copilotToken(force = false): Promise<{
	token: string;
	api: string;
}> {
	if (!force && session && Date.now() < session.exp - 120_000) return session;
	const gh = ghToken();
	if (!gh)
		throw shimError(
			"authentication_error",
			"no gho_ token — mint one: bun ~/.claude/local-llm/ikea-shim.ts login",
		);
	const r = await fetch(
		process.env.IKEA_TOKEN_URL_OVERRIDE ?? INTERNAL_TOKEN_URL,
		{
			headers: {
				authorization: `token ${gh}`,
				"user-agent": "ikea-shim/0.1 (fleet)",
				accept: "application/json",
			},
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (!r.ok) {
		session = null;
		throw shimError(
			"authentication_error",
			`copilot seat check failed (${r.status}) — token lacks a Copilot seat`,
		);
	}
	const j = (await r.json()) as {
		token: string;
		expires_at?: number;
		endpoints?: { api?: string };
	};
	session = {
		token: j.token,
		api:
			process.env.IKEA_API_OVERRIDE ??
			j.endpoints?.api ??
			"https://api.githubcopilot.com",
		exp: j.expires_at ? j.expires_at * 1000 : Date.now() + 25 * 60_000,
	};
	return session;
}

function errorResponse(
	type: string,
	message: string,
	status: number,
): Response {
	return Response.json(
		{ type: "error", error: { type, message } },
		{ status, headers: { "x-ikea-shim": "error" } },
	);
}

function throwStatus(status: number, body: string): never {
	let type = "api_error";
	if (status === 401) type = "authentication_error";
	else if (status === 429) type = "rate_limit_error";
	else if (status === 400) type = "invalid_request_error";
	throw shimError(type, `copilot ${status}: ${body.slice(0, 300)}`);
}

function chatHeaders(token: string): Record<string, string> {
	return {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"copilot-integration-id": "vscode-chat",
		"openai-intent": "conversation-panel",
		"editor-version": "vscode/1.99.0",
		"editor-plugin-version": "copilot-chat/0.25.0",
		"user-agent": "GitHubCopilotChat/0.25.0",
		accepts: "application/json",
	};
}

// one upstream POST with a single 401 → refresh-token retry
async function callCopilot(
	url: string,
	payload: unknown,
	reqSignal: AbortSignal | null | undefined,
): Promise<Response> {
	const attempt = (tok: string) =>
		fetch(url, {
			method: "POST",
			headers: chatHeaders(tok),
			body: JSON.stringify(payload),
			signal: reqSignal ?? undefined,
		});
	let r = await attempt((await copilotToken()).token);
	if (r.status === 401) r = await attempt((await copilotToken(true)).token);
	if (!r.ok) throwStatus(r.status, await r.text());
	return r;
}

// ─── anthropic → openai translation ───
type Block = {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	source?: { media_type?: string; data?: string };
};

type AnthBody = {
	model?: string;
	max_tokens?: number;
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	system?: unknown;
	messages?: Array<{ role: string; content: unknown }>;
	tools?: Array<{
		name?: string;
		description?: string;
		input_schema?: unknown;
	}>;
	tool_choice?: { type?: string; name?: string };
};

type OaMessage = {
	role: string;
	content?: string | Array<unknown> | null;
	tool_calls?: Array<{
		id: string;
		function: { name: string; arguments: string };
	}>;
};

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => (typeof b === "object" && b ? ((b as Block).text ?? "") : ""))
		.join("");
}

function oaAssistantMsg(m: { role: string; content: unknown }): OaMessage {
	let text = "";
	const calls: NonNullable<OaMessage["tool_calls"]> = [];
	const blocks: Block[] = Array.isArray(m.content)
		? (m.content as Block[])
		: [{ type: "text", text: String(m.content ?? "") }];
	for (const b of blocks) {
		if (b.type === "text") text += b.text ?? "";
		else if (b.type === "tool_use")
			calls.push({
				id: b.id ?? `call_${Date.now()}`,
				function: {
					name: b.name ?? "unknown",
					arguments: JSON.stringify(b.input ?? {}),
				},
			});
	}
	const msg: OaMessage = { role: "assistant", content: text || null };
	if (calls.length) msg.tool_calls = calls;
	return msg;
}

function oaUserMsgs(m: { role: string; content: unknown }): OaMessage[] {
	const toolResults: OaMessage[] = [];
	const parts: unknown[] = [];
	const blocks: Block[] = Array.isArray(m.content)
		? (m.content as Block[])
		: [{ type: "text", text: String(m.content ?? "") }];
	for (const b of blocks) {
		if (b.type === "tool_result")
			toolResults.push({
				role: "tool",
				tool_call_id: b.tool_use_id ?? "",
				content: blockText(b.content) || "(empty result)",
			});
		else if (b.type === "image") {
			const src = b.source ?? {};
			if (src.data && src.media_type)
				parts.push({
					type: "image_url",
					image_url: { url: `data:${src.media_type};base64,${src.data}` },
				});
		} else if (b.type === "text" || typeof b.text === "string")
			parts.push({ type: "text", text: b.text ?? "" });
	}
	const out: OaMessage[] = [];
	if (toolResults.length) out.push(...toolResults);
	if (parts.length)
		out.push(
			parts.length === 1 && (parts[0] as { type: string }).type === "text"
				? { role: "user", content: (parts[0] as { text: string }).text }
				: { role: "user", content: parts },
		);
	return out;
}

function toOaMessages(body: AnthBody): OaMessage[] {
	const out: OaMessage[] = [];
	const sys = blockText(body.system);
	if (sys) out.push({ role: "system", content: sys });
	for (const m of body.messages ?? []) {
		if (m.role === "assistant") out.push(oaAssistantMsg(m));
		else out.push(...oaUserMsgs(m));
	}
	return out;
}

function toOaTools(body: AnthBody): unknown[] | undefined {
	if (!body.tools?.length) return undefined;
	return body.tools.map((t) => ({
		type: "function",
		function: {
			name: t.name ?? "",
			description: t.description ?? "",
			parameters: t.input_schema ?? { type: "object", properties: {} },
		},
	}));
}

function toOaToolChoice(
	tc: AnthBody["tool_choice"],
): string | object | undefined {
	if (!tc) return undefined;
	if (tc.type === "auto") return "auto";
	if (tc.type === "any") return "required";
	if (tc.type === "tool")
		return { type: "function", function: { name: tc.name } };
	return undefined;
}

function stopMap(fr: string | null | undefined): string {
	switch (fr) {
		case "tool_calls":
			return "tool_use";
		case "length":
			return "max_tokens";
		case "content_filter":
			return "refusal";
		default:
			return "end_turn";
	}
}

function safeArgs(args: string | undefined): unknown {
	try {
		return args ? (JSON.parse(args) as unknown) : {};
	} catch {
		return { _raw: args ?? "" };
	}
}

function toAnthropicResponse(
	modelIn: string,
	oa: {
		message?: {
			content?: string | null;
			tool_calls?: Array<{
				id: string;
				function: { name: string; arguments: string };
			}>;
		};
		finish_reason?: string;
	},
	usage: { prompt_tokens?: number; completion_tokens?: number },
): Record<string, unknown> {
	const blocks: Record<string, unknown>[] = [];
	if (oa.message?.content)
		blocks.push({ type: "text", text: oa.message.content });
	for (const c of oa.message?.tool_calls ?? [])
		blocks.push({
			type: "tool_use",
			id: c.id,
			name: c.function.name,
			input: safeArgs(c.function.arguments),
		});
	if (!blocks.length) blocks.push({ type: "text", text: "" });
	return {
		id: `msg_ikea_${Date.now()}`,
		type: "message",
		role: "assistant",
		model: modelIn,
		content: blocks,
		stop_reason: stopMap(oa.finish_reason),
		stop_sequence: null,
		usage: {
			input_tokens: usage.prompt_tokens ?? 0,
			output_tokens: usage.completion_tokens ?? 0,
		},
	};
}

// ─── openai SSE → anthropic SSE (state machine over one request) ───
type SseState = {
	modelIn: string;
	estIn: number;
	started: boolean;
	nextIdx: number;
	textOpen: boolean;
	textIdx: number;
	tools: Map<number, { aIdx: number; id: string; name: string }>;
	usage: { input_tokens: number; output_tokens: number };
	stop: string | null;
	out: string[];
};

function sseEmit(s: SseState, type: string, data: unknown): void {
	s.out.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseEnsureStart(s: SseState): void {
	if (s.started) return;
	s.started = true;
	sseEmit(s, "message_start", {
		type: "message_start",
		message: {
			id: `msg_ikea_${Date.now()}`,
			type: "message",
			role: "assistant",
			model: s.modelIn,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: s.estIn, output_tokens: 0 },
		},
	});
}

function sseOpenText(s: SseState): void {
	if (s.textOpen) return;
	s.textIdx = s.nextIdx++;
	s.textOpen = true;
	sseEmit(s, "content_block_start", {
		type: "content_block_start",
		index: s.textIdx,
		content_block: { type: "text", text: "" },
	});
}

function sseCloseText(s: SseState): void {
	if (!s.textOpen) return;
	s.textOpen = false;
	sseEmit(s, "content_block_stop", {
		type: "content_block_stop",
		index: s.textIdx,
	});
}

function sseTextDelta(s: SseState, text: string): void {
	sseEnsureStart(s);
	sseOpenText(s);
	sseEmit(s, "content_block_delta", {
		type: "content_block_delta",
		index: s.textIdx,
		delta: { type: "text_delta", text },
	});
}

type OaChunk = {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function sseToolFrag(
	s: SseState,
	t: {
		index: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	},
): void {
	let slot = s.tools.get(t.index);
	if (!slot) {
		if (!t.function?.name) return; // fragment before the name chunk — drop
		sseEnsureStart(s);
		sseCloseText(s);
		const aIdx = s.nextIdx++;
		slot = {
			aIdx,
			id: t.id ?? `call_${Date.now()}_${t.index}`,
			name: t.function.name,
		};
		s.tools.set(t.index, slot);
		sseEmit(s, "content_block_start", {
			type: "content_block_start",
			index: aIdx,
			content_block: {
				type: "tool_use",
				id: slot.id,
				name: slot.name,
				input: {},
			},
		});
	}
	const frag = t.function?.arguments;
	if (frag)
		sseEmit(s, "content_block_delta", {
			type: "content_block_delta",
			index: slot.aIdx,
			delta: { type: "input_json_delta", partial_json: frag },
		});
}

function sseChunk(s: SseState, j: OaChunk): void {
	if (j.usage)
		s.usage = {
			input_tokens: j.usage.prompt_tokens ?? s.usage.input_tokens,
			output_tokens: j.usage.completion_tokens ?? s.usage.output_tokens,
		};
	for (const c of j.choices ?? []) {
		if (c.finish_reason) s.stop = stopMap(c.finish_reason);
		const d = c.delta;
		if (!d) continue;
		if (d.content) sseTextDelta(s, d.content);
		for (const t of d.tool_calls ?? []) sseToolFrag(s, t);
	}
}

function sseDrain(s: SseState): string {
	const joined = s.out.join("");
	s.out.length = 0;
	return joined;
}

function sseFinish(s: SseState): string {
	sseEnsureStart(s); // degenerate empty stream still yields a valid message
	sseCloseText(s);
	sseEmit(s, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: s.stop ?? "end_turn", stop_sequence: null },
		usage: { output_tokens: s.usage.output_tokens },
	});
	sseEmit(s, "message_stop", { type: "message_stop" });
	return sseDrain(s);
}

function newSse(modelIn: string, estIn: number): SseState {
	return {
		modelIn,
		estIn,
		started: false,
		nextIdx: 0,
		textOpen: false,
		textIdx: -1,
		tools: new Map(),
		usage: { input_tokens: estIn, output_tokens: 0 },
		stop: null,
		out: [],
	};
}

// ─── request assembly ───
function toOaBody(
	body: AnthBody,
	model: string,
	stream: boolean,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		model,
		messages: toOaMessages(body),
		stream,
	};
	payload.max_tokens = Math.min(body.max_tokens ?? 4096, 64_000);
	if (body.temperature !== undefined) payload.temperature = body.temperature;
	if (body.top_p !== undefined) payload.top_p = body.top_p;
	if (body.stop_sequences?.length) payload.stop = body.stop_sequences;
	const tools = toOaTools(body);
	if (tools) payload.tools = tools;
	const tc = toOaToolChoice(body.tool_choice);
	if (tc !== undefined) payload.tool_choice = tc;
	return payload;
}

function estTokens(body: AnthBody): number {
	return Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
}

function logLine(fields: Record<string, unknown>): void {
	try {
		appendFileSync(
			LOG_FILE,
			`${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`,
		);
	} catch {}
}

function errStatusFor(type: string): number {
	if (type === "rate_limit_error") return 429;
	if (type === "authentication_error") return 401;
	if (type === "invalid_request_error") return 400;
	return 502;
}

async function plainResponse(
	req: Request,
	body: AnthBody,
	oaBody: Record<string, unknown>,
	used: string,
): Promise<Response> {
	const t0 = Date.now();
	try {
		const api = (await copilotToken()).api;
		const r = await callCopilot(`${api}/chat/completions`, oaBody, req.signal);
		const j = (await r.json()) as {
			choices?: Parameters<typeof toAnthropicResponse>[1];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		const u = j.usage ?? {};
		const out = toAnthropicResponse(
			body.model ?? used,
			j.choices?.[0] ?? {},
			u,
		);
		logLine({
			kind: "plain",
			model: `${body.model}→${used}`,
			ms: Date.now() - t0,
			in_tok: u.prompt_tokens ?? 0,
			out_tok: u.completion_tokens ?? 0,
			stop: String(out.stop_reason),
		});
		return Response.json(out, {
			headers: { "x-ikea-shim": `copilot/${used}` },
		});
	} catch (e) {
		if (isShimError(e))
			return errorResponse(e.type, e.message, errStatusFor(e.type));
		return errorResponse("api_error", errmsg(e), 502);
	}
}

// SSE parse + pump: upstream openai chunks → translator → client bytes.
async function pumpSse(
	upstream: Response,
	tr: SseState,
	enqueue: (bytes: Uint8Array) => void,
): Promise<void> {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	let buf = "";
	const reader = upstream.body?.getReader();
	if (!reader) return;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		for (;;) {
			const cut = buf.indexOf("\n\n");
			if (cut < 0) break;
			const ev = buf.slice(0, cut);
			buf = buf.slice(cut + 2);
			for (const line of ev.split("\n")) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data || data === "[DONE]") continue;
				try {
					sseChunk(tr, JSON.parse(data) as OaChunk);
				} catch {}
			}
			const bytes = sseDrain(tr);
			if (bytes) enqueue(enc.encode(bytes));
		}
	}
}

async function streamResponse(
	req: Request,
	body: AnthBody,
	oaBody: Record<string, unknown>,
	used: string,
): Promise<Response> {
	const t0 = Date.now();
	const est = estTokens(body);
	const tr = newSse(body.model ?? used, est);
	const api = (await copilotToken()).api;
	let upstream: Response;
	try {
		upstream = await callCopilot(`${api}/chat/completions`, oaBody, req.signal);
	} catch (e) {
		if (isShimError(e))
			return errorResponse(e.type, e.message, errStatusFor(e.type));
		return errorResponse("api_error", errmsg(e), 502);
	}
	const stream = new ReadableStream({
		start(controller) {
			pumpSse(upstream, tr, (b) => controller.enqueue(b))
				.then(() => {
					const tail = sseFinish(tr);
					if (tail) controller.enqueue(new TextEncoder().encode(tail));
					logLine({
						kind: "stream",
						model: `${body.model}→${used}`,
						ms: Date.now() - t0,
						in_tok: tr.usage.input_tokens,
						out_tok: tr.usage.output_tokens,
						stop: tr.stop ?? "end_turn",
					});
					controller.close();
				})
				.catch((e: unknown) => {
					try {
						controller.error(e);
					} catch {}
				});
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"x-ikea-shim": `copilot/${used}`,
		},
	});
}

async function handleMessages(req: Request): Promise<Response> {
	let body: AnthBody;
	try {
		body = (await req.json()) as AnthBody;
	} catch {
		return errorResponse("invalid_request_error", "bad json", 400);
	}
	if (!body.model)
		return errorResponse("invalid_request_error", "model required", 400);
	const used = mapModel(body.model);
	const oaBody = toOaBody(body, used, body.stream === true);
	if (body.stream === true) return streamResponse(req, body, oaBody, used);
	return plainResponse(req, body, oaBody, used);
}

function handleCountTokens(req: Request): Promise<Response> {
	return req
		.json()
		.then((b) =>
			Response.json({
				input_tokens: estTokens(b as AnthBody),
			}),
		)
		.catch(() => errorResponse("invalid_request_error", "bad json", 400));
}

// ─── device-flow login (the human enters the code — token never printed) ───
async function deviceStart(): Promise<{
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}> {
	const r = await fetch(DEVICE_URL, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
	});
	const j = (await r.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		expires_in: number;
		interval: number;
		error?: string;
	};
	if (!r.ok || j.error)
		throw shimError(
			"authentication_error",
			`device flow rejected: ${j.error ?? r.status}`,
		);
	return j;
}

async function devicePoll(d: {
	device_code: string;
	expires_in: number;
	interval: number;
}): Promise<string> {
	let interval = (d.interval ?? 5) * 1000;
	const deadline = Date.now() + d.expires_in * 1000;
	while (Date.now() < deadline) {
		await Bun.sleep(interval);
		const r = await fetch(OAUTH_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: d.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});
		const j = (await r.json()) as { access_token?: string; error?: string };
		if (j.access_token) return j.access_token;
		if (j.error === "authorization_pending") continue;
		if (j.error === "slow_down") {
			interval += 5000;
			continue;
		}
		throw shimError(
			"authentication_error",
			`device flow failed: ${j.error ?? r.status}`,
		);
	}
	throw shimError("authentication_error", "device flow expired unentered");
}

async function verifySeat(): Promise<void> {
	const { token, api } = await copilotToken(true);
	const r = await fetch(`${api}/models`, { headers: chatHeaders(token) });
	const m = (await r.json()) as {
		data?: Array<{
			id: string;
			capabilities?: {
				type?: string;
				supports?: { tool_calls?: boolean; streaming?: boolean };
			};
			policy?: { state?: string };
		}>;
	};
	console.log(`seat OK — api: ${api}`);
	for (const d of m.data ?? [])
		if (d.capabilities?.type === "chat" || d.capabilities?.type === undefined)
			console.log(
				`  ${d.id}  tools=${d.capabilities?.supports?.tool_calls ?? "?"} stream=${d.capabilities?.supports?.streaming ?? "?"} policy=${d.policy?.state ?? "?"}`,
			);
}

async function login(): Promise<void> {
	console.log("ikea-shim login — GitHub device flow (Copilot seat required)");
	const d = await deviceStart();
	console.log(`open ${d.verification_uri} and enter: ${d.user_code}`);
	console.log(`(expires in ${Math.round(d.expires_in / 60)} min — waiting)`);
	const tok = await devicePoll(d);
	mkdirSync(LLM_HOME, { recursive: true });
	writeFileSync(TOK_FILE, `${tok}\n`, { mode: 0o600 });
	console.log(
		"gho_ token minted → ~/.claude/local-llm/ikea-github.token (0600, never printed)",
	);
	await verifySeat();
}

// ─── status: outside-process probe (health is outside-process law) ───
async function status(): Promise<number> {
	let alive = false;
	try {
		const r = await fetch(`${BASE}/health/liveliness`, {
			signal: AbortSignal.timeout(3000),
		});
		alive = r.ok;
	} catch {}
	console.log(`shim :${PORT} ${alive ? "UP" : "DOWN"}`);
	let seat = "no token file — run: bun ~/.claude/local-llm/ikea-shim.ts login";
	if (ghToken()) {
		try {
			const s = await copilotToken(true);
			seat = `seat OK — api ${s.api}`;
		} catch (e) {
			seat = `seat FAIL — ${errmsg(e)}`;
		}
	}
	console.log(seat);
	return alive && seat.startsWith("seat OK") ? 0 : 1;
}

// ─── selftest: 3 live legs through a RUNNING shim (mock-capable via
// IKEA_TOKEN_URL_OVERRIDE + IKEA_API_OVERRIDE) ───
async function legPlain(): Promise<string> {
	const r = await fetch(`${BASE}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-5",
			max_tokens: 50,
			messages: [{ role: "user", content: "Reply with exactly: IKEA-SHIM-OK" }],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const d = (await r.json()) as {
		content?: Array<{ text?: string }>;
		error?: { message?: string };
	};
	if (!r.ok) throw new Error(d.error?.message ?? String(r.status));
	const text = (d.content ?? []).map((b) => b.text ?? "").join("");
	if (!text.includes("IKEA-SHIM-OK"))
		throw new Error(`no marker in: ${text.slice(0, 80)}`);
	return `stop=${String((d as { stop_reason?: string }).stop_reason ?? "?")}`;
}

async function legStream(): Promise<string> {
	const r = await fetch(`${BASE}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-5",
			max_tokens: 50,
			stream: true,
			messages: [
				{ role: "user", content: "Reply with exactly: IKEA-STREAM-OK" },
			],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!r.ok || !r.body) throw new Error(`stream status ${r.status}`);
	const dec = new TextDecoder();
	let buf = "";
	let text = "";
	const seen = new Set<string>();
	const reader = r.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		for (;;) {
			const cut = buf.indexOf("\n\n");
			if (cut < 0) break;
			const ev = buf.slice(0, cut);
			buf = buf.slice(cut + 2);
			for (const line of ev.split("\n")) {
				if (!line.startsWith("data:")) continue;
				try {
					const j = JSON.parse(line.slice(5)) as {
						type?: string;
						delta?: { text?: string };
					};
					if (j.type) seen.add(j.type);
					if (j.type === "content_block_delta" && j.delta?.text)
						text += j.delta.text;
				} catch {}
			}
		}
	}
	if (!seen.has("message_start") || !seen.has("message_stop"))
		throw new Error(`SSE frame incomplete: ${[...seen].join(",")}`);
	if (!text.includes("IKEA-STREAM-OK"))
		throw new Error(`no marker in stream text: ${text.slice(0, 80)}`);
	return `${seen.size} event kinds`;
}

async function legTools(): Promise<string> {
	const r = await fetch(`${BASE}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-5",
			max_tokens: 300,
			tools: [
				{
					name: "get_weather",
					description: "Current weather for a city",
					input_schema: {
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					},
				},
			],
			messages: [
				{
					role: "user",
					content:
						"What is the weather in Copenhagen right now? Call the get_weather tool.",
				},
			],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const d = (await r.json()) as {
		content?: Array<{ type: string; name?: string; input?: unknown }>;
		error?: { message?: string };
	};
	if (!r.ok) throw new Error(d.error?.message ?? String(r.status));
	const call = (d.content ?? []).find((b) => b.type === "tool_use");
	if (!call)
		throw new Error(
			`no tool_use block: ${JSON.stringify(d.content ?? []).slice(0, 120)}`,
		);
	if (call.name !== "get_weather") throw new Error(`wrong tool: ${call.name}`);
	return `input=${JSON.stringify(call.input)}`;
}

async function selftest(): Promise<number> {
	console.log(`selftest vs ${BASE}`);
	const legs: Array<[string, () => Promise<string>]> = [
		["plain", legPlain],
		["stream", legStream],
		["tools", legTools],
	];
	let fails = 0;
	for (const [name, fn] of legs) {
		const t0 = Date.now();
		try {
			const note = await fn();
			console.log(`✓ ${name} (${Date.now() - t0}ms) ${note}`);
		} catch (e) {
			fails++;
			console.log(`✗ ${name} — ${errmsg(e)}`);
		}
	}
	return fails ? 1 : 0;
}

// ─── serve (default: no subcommand) ───
const cmd = process.argv[2];
if (cmd === undefined) {
	Bun.serve({
		port: PORT,
		hostname: "127.0.0.1", // W204: loopback-only; external access via an authenticated hop
		async fetch(req) {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname === "/health/liveliness")
				return Response.json({ status: "alive", shim: "ikea" });
			if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens")
				return handleCountTokens(req);
			if (req.method === "POST" && url.pathname.startsWith("/v1/messages"))
				return handleMessages(req);
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	console.log(`ikea-shim ready on :${PORT} — anthropic→copilot`);
} else if (cmd === "login") await login();
else if (cmd === "status") process.exit(await status());
else if (cmd === "selftest") process.exit(await selftest());
else {
	console.log(`unknown subcommand: ${cmd}`);
	console.log("usage: ikea-shim.ts [login|status|selftest]");
	process.exit(1);
}
