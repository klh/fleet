// scripts/lib/lane-auth.ts — per-lane buckle keys. The buckle governance gate
// demands bksk_ keys; a lane riding the /w/<sid> front needs its own scoped
// key (buckle:proxy:WRITE_), minted at dispatch time by the admin key that
// lives in belt.env (0600, machine-level .env law). No admin key = the lane
// skips the buckle front and rides belt directly — surfaced, never silent.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BELT_ENV_PATH =
	process.env.SUSPENDERS_BELT_ENV ??
	join(homedir(), ".claude", "local-llm", "belt.env");

/** KEY=VALUE line parser — no eval; quotes are literal (belt.env is ours). */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
		if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2];
	}
	return out;
}

/** The dispatch admin key: process env wins over belt.env; null when absent. */
export function adminKey(
	env: NodeJS.ProcessEnv = process.env,
	path: string = BELT_ENV_PATH,
): string | null {
	const fromFile = existsSync(path)
		? (parseEnvFile(readFileSync(path, "utf8")).BUCKLE_ADMIN_KEY ?? null)
		: null;
	return env.BUCKLE_ADMIN_KEY ?? fromFile;
}

/** Mint a per-lane proxy key (name=sid, scope buckle:proxy:WRITE_). Exposed
 *  for tests — the fetch is injected. */
export async function mintLaneKey(
	sid: string,
	admin: string,
	fetchFn: typeof fetch = fetch,
	front = "http://127.0.0.1:4101",
): Promise<string | null> {
	const r = await fetchFn(`${front}/v1/admin/keys`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${admin}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			name: sid,
			scopes: ["buckle:proxy:WRITE_"],
		}),
	});
	const data = (await r.json().catch(() => null)) as {
		key?: string;
		apiKey?: string;
	} | null;
	const k = data?.key ?? data?.apiKey;
	return typeof k === "string" && k.startsWith("bksk_") ? k : null;
}

/** Resolve a lane's buckle key: null when no admin key is configured — the
 *  caller then skips the buckle front (NO_BELT-style fallback, surfaced). */
export async function ensureLaneKey(
	sid: string,
	front?: string,
): Promise<string | null> {
	const admin = adminKey();
	if (!admin) return null;
	return mintLaneKey(sid, admin, fetch, front);
}
