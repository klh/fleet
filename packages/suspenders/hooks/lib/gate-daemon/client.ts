// lib/gate-daemon/client.ts — the thin-client half of the hub governor
// daemon (hub-of-one phase 5). hooks/gate.ts asks the warm store-server to
// evaluate a hot gate instead of cold-loading the gate graph per tool call.
//
// Semantics: the daemon is an accelerator, never a bypass. Every failure
// (disabled, non-loopback store, no token file, refused, timeout, bad
// response) returns null and the caller evaluates the same gate locally —
// no gate is ever skipped, so a dead daemon degrades to today's latency,
// not to fail-open. Deliberately light: node:fs + the zod wire schema only
// (no govdb import — that graph is what the daemon exists to avoid).
import { existsSync, readFileSync, statSync } from "node:fs";
import {
	type GateResponse,
	GateResponseSchema,
	isDaemonEvent,
} from "./schema.ts";

// gate evaluation reads LOCAL files (anchor, read, claim-location): only a
// store on this machine may evaluate them
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function daemonEnabled(env = process.env): boolean {
	return env.SUSPENDERS_GATE_DAEMON === "1";
}

function regDir(env: NodeJS.ProcessEnv): string {
	return `${env.HOME ?? ""}/.cache/claude-governor`;
}

// same binding chain as govdb-store resolveStoreHttpBase(), loopback-only
export function daemonBase(env = process.env): string | null {
	let raw = (env.GOVERNOR_STORE_URL ?? "").trim();
	if (!raw) {
		try {
			raw = readFileSync(`${regDir(env)}/store.url`, "utf8").trim();
		} catch {
			return null;
		}
	}
	if (!raw || raw === "local") return null;
	try {
		const u = new URL(raw);
		return LOOPBACK.has(u.hostname) ? raw.replace(/\/+$/, "") : null;
	} catch {
		return null;
	}
}

// the store token rule (govdb-store resolveStoreToken): env, else a private
// 0600 file; an unreadable/loose file disables the daemon path, never throws
export function daemonToken(env = process.env): string | null | undefined {
	if (env.GOVERNOR_STORE_TOKEN) return env.GOVERNOR_STORE_TOKEN;
	const file = env.GOVERNOR_STORE_TOKEN_FILE ?? `${regDir(env)}/store.token`;
	if (!existsSync(file))
		return env.GOVERNOR_STORE_TOKEN_FILE ? undefined : null;
	try {
		const st = statSync(file);
		if (!st.isFile() || (st.mode & 0o777) !== 0o600) return undefined;
		const tok = readFileSync(file, "utf8").trim();
		return tok && !/\s/.test(tok) ? tok : undefined;
	} catch {
		return undefined;
	}
}

export async function gateViaDaemon(
	event: string,
	raw: string,
	env = process.env,
): Promise<GateResponse | null> {
	if (!daemonEnabled(env) || !isDaemonEvent(event)) return null;
	const base = daemonBase(env);
	const token = daemonToken(env);
	if (!base || token === undefined) return null;
	const timeoutMs = Number(env.SUSPENDERS_GATE_DAEMON_TIMEOUT_MS) || 1500;
	try {
		const res = await fetch(`${base}/gate/${event}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { "x-governor-token": token } : {}),
			},
			body: JSON.stringify({
				raw,
				env: Object.fromEntries(
					Object.entries(env).filter(
						(e): e is [string, string] => typeof e[1] === "string",
					),
				),
				cwd: process.cwd(),
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const parsed = GateResponseSchema.safeParse(await res.json());
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
