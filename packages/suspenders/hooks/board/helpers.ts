// hooks/board/helpers.ts — http response helpers: json(), writeGuard(), readJson() (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { BIND } from "./context.ts";
import { hostGuard } from "../lib/host-guard.ts";

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// write endpoints are for the human at this board — the shared W264
// perimeter guard (lib/host-guard.ts): host allowlist, Origin ∈ allowlist
// AND Origin == Host for browsers, per-install write token on every write.
export function writeGuard(req: Request, _url: URL): Response | null {
	return hostGuard(req, { bind: BIND, write: true });
}

// JSON-body endpoints must declare application/json (a plain form POST from
// another site can't forge it cross-origin) and must parse.
export async function readJson(
	req: Request,
): Promise<
	{ ok: true; body: Record<string, unknown> } | { ok: false; resp: Response }
> {
	const ct = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	if (ct !== "application/json")
		return {
			ok: false,
			resp: json(
				{ ok: false, error: "content-type must be application/json" },
				415,
			),
		};
	try {
		return { ok: true, body: await req.json() };
	} catch {
		return {
			ok: false,
			resp: json({ ok: false, error: "malformed json body" }, 400),
		};
	}
}

// size-capped JSON body read: streams in chunks, refuses past cap (413) so
// one request cannot buffer the process unboundedly. The bounded-observation
// ingests ride this (routes-observations 8 KiB, observation-serving 256 KiB).
export async function readJsonCapped(
	req: Request,
	cap: number,
): Promise<{ ok: true; body: unknown } | { ok: false; resp: Response }> {
	const ct = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	if (ct !== "application/json")
		return {
			ok: false,
			resp: json(
				{ ok: false, error: "content-type must be application/json" },
				415,
			),
		};
	const reader = req.body?.getReader();
	if (!reader)
		return {
			ok: false,
			resp: json({ ok: false, error: "body required" }, 400),
		};
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > cap) {
				await reader.cancel();
				return {
					ok: false,
					resp: json({ ok: false, error: `body exceeds ${cap} bytes` }, 413),
				};
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return {
			ok: true,
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
		};
	} catch {
		return {
			ok: false,
			resp: json({ ok: false, error: "malformed json body" }, 400),
		};
	}
}

// W685 chunked IN(...) runner: SQLite's bind-variable ceiling is remote but
// the store round-trip is not free — batches of this size keep one statement
// per N keys without hard-coding the driver's limit.
export function chunked<T>(
	values: T[],
	fn: (chunk: T[]) => void,
	size = 400,
): void {
	for (let i = 0; i < values.length; i += size) fn(values.slice(i, i + size));
}

// failure notes ride the work.failed event payload ($.work = item id) — the
// board shows why a lane died, not just that it died
// W64 ship-trigger helpers — merging a lane branch is safe only when no live
// lane still owns it. Two registries: .fleet/lanes.json (dispatched lanes,
// pid-guard) and the sessions table (interactive lanes — hb updates only at
// bootstrap, so the transcript mtime is the liveness signal, per the zombie
// lesson); the ladder comes from <repo>/.fleet/ship.json (owner config).
