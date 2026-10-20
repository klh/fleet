// A machine-scoped cosmetic preference shared by the .local dashboards.
// The endpoint deliberately accepts only the three theme values; it does not
// carry board credentials or expose any other setting across origins.
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { hostnameOf, hostAllowlist } from "../lib/host-guard.ts";
import { BIND } from "./context.ts";
import { isPref, type ThemePref } from "../lib/theme.ts";

interface ThemeState {
	pref: ThemePref;
	revision: number;
}
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
const defaultState: ThemeState = { pref: "system", revision: 0 };
export const themePath = (env: NodeJS.ProcessEnv = process.env): string =>
	`${env.HOME}/.cache/claude-governor/ui-theme.json`;

export function readTheme(path = themePath()): ThemeState {
	try {
		const state = JSON.parse(readFileSync(path, "utf8"));
		if (
			isPref(state?.pref) &&
			Number.isSafeInteger(state.revision) &&
			state.revision >= 0
		)
			return { pref: state.pref, revision: state.revision };
	} catch {}
	return defaultState;
}

function writeTheme(pref: ThemePref, path = themePath()): ThemeState {
	const state = {
		pref,
		revision: Math.max(Date.now(), readTheme(path).revision + 1),
	};
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
	for (const client of clients) {
		try {
			client.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
		} catch {
			clients.delete(client);
		}
	}
	return state;
}

function allowedOrigin(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.origin !== value) return null;
		if (
			url.protocol === "https:" &&
			!url.port &&
			/^[a-z0-9-]+\.local$/.test(url.hostname)
		)
			return value;
		if (
			url.protocol === "http:" &&
			["localhost", "127.0.0.1"].includes(url.hostname)
		)
			return value;
	} catch {}
	return null;
}

export const isThemePath = (pathname: string): boolean =>
	pathname === "/api/theme" || pathname === "/api/theme/events";

export async function handleTheme(
	req: Request,
	path = themePath(),
): Promise<Response> {
	const url = new URL(req.url);
	const host = req.headers.get("host") ?? url.host;
	if (!hostAllowlist(BIND).has(hostnameOf(host)))
		return Response.json({ error: "untrusted host" }, { status: 403 });
	const origin = req.headers.get("origin");
	const allow = allowedOrigin(origin);
	if (origin && !allow)
		return Response.json({ error: "untrusted origin" }, { status: 403 });
	const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
	if (allow) {
		headers.set("Access-Control-Allow-Origin", allow);
		headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		headers.set("Access-Control-Allow-Headers", "content-type");
	}
	if (req.method === "OPTIONS")
		return new Response(null, { status: 204, headers });
	if (url.pathname === "/api/theme/events" && req.method === "GET") {
		headers.set("Content-Type", "text/event-stream; charset=utf-8");
		let client: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				client = controller;
				clients.add(controller);
				req.signal.addEventListener("abort", () => clients.delete(controller), {
					once: true,
				});
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(readTheme(path))}\n\n`),
				);
			},
			cancel() {
				if (client) clients.delete(client);
			},
		});
		return new Response(stream, { headers });
	}
	if (url.pathname !== "/api/theme")
		return new Response(null, { status: 404, headers });
	if (req.method === "GET") return Response.json(readTheme(path), { headers });
	if (req.method !== "POST")
		return new Response(null, { status: 405, headers });
	if (Number(req.headers.get("content-length") ?? 0) > 128)
		return new Response(null, { status: 413, headers });
	let body: unknown;
	try {
		const reader = req.body?.getReader();
		if (!reader) return new Response(null, { status: 400, headers });
		const parts: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 128) {
				await reader.cancel();
				return new Response(null, { status: 413, headers });
			}
			parts.push(chunk.value);
		}
		body = JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
	} catch {
		return new Response(null, { status: 400, headers });
	}
	const pref = (body as { pref?: unknown } | null)?.pref;
	if (!isPref(pref))
		return Response.json(
			{ error: "invalid preference" },
			{ status: 400, headers },
		);
	return Response.json(writeTheme(pref, path), { headers });
}
