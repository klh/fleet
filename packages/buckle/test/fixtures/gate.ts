// test/fixtures/gate.ts — W1135.1 shared gate fixture: the ONE
// mkdtemp-backed startGate / issueViaAdmin / chat trio that replaced the
// ~12 per-file copies (each previously minted its own /tmp/buckle-gate-*
// yaml and, uncleaned, leaked it). Scratch files ride one mkdtemp dir per
// gate; stop() tears the whole dir down.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerOpts } from "../../src/server.ts";

export const ROOT = "buckle-test-root";

export interface GateHandle {
	base: string;
	srv: ReturnType<typeof startServer>;
	/** Scratch dir holding the gate's yaml files (removed by stop()). */
	dir: string;
	stop(): void;
}

export interface StartGateOpts {
	/** Loopback URL the default single-group upstreams yaml pins to. */
	upstreamUrl?: string;
	dialect?: string;
	/** Raw upstreams/policy yaml + prefs json; overrides the defaults. */
	upstreamsYaml?: string;
	policyYaml?: string;
	prefsJson?: string;
	auth?: ServerOpts extends { auth?: infer A } ? A : never;
	/** File-backed ledger path when a test must read the db post-stop. */
	dbPath?: string;
	hostname?: string;
	ingressBodyTimeoutMs?: number;
	secretsHome?: string;
	repoPolicyPath?: string;
}

/** Start a real gate on a scratch port with its config files in one
 *  mkdtemp dir; stop() closes the server and removes the dir. */
export async function startGate(
	opts: StartGateOpts = {},
): Promise<GateHandle> {
	const dir = mkdtempSync(join(tmpdir(), "buckle-gate-"));
	const write = (name: string, content: string): string => {
		const p = join(dir, name);
		writeFileSync(p, content);
		return p;
	};
	const upstreams = opts.upstreamsYaml ??
		`groups:\n  glm-5.3-flash:\n    - url: ${opts.upstreamUrl ?? "http://127.0.0.1:1"}\n      dialect: ${opts.dialect ?? "openai"}\n`;
	const upstreamsPath = write("upstreams.yaml", upstreams);
	const policyPath = opts.policyYaml === undefined
		? undefined
		: write("policy.yaml", opts.policyYaml);
	const prefsPath = opts.prefsJson === undefined
		? undefined
		: write("prefs.json", opts.prefsJson);
	const srv = startServer({
		port: 0,
		upstreamsPath,
		policyPath,
		prefsPath,
		dbPath: opts.dbPath ?? ":memory:",
		...(opts.auth === undefined ? {} : { auth: opts.auth }),
		...(opts.hostname === undefined ? {} : { hostname: opts.hostname }),
		...(opts.ingressBodyTimeoutMs === undefined
			? {}
			: { ingressBodyTimeoutMs: opts.ingressBodyTimeoutMs }),
		...(opts.secretsHome === undefined ? {} : { secretsHome: opts.secretsHome }),
		...(opts.repoPolicyPath === undefined
			? {}
			: { repoPolicyPath: opts.repoPolicyPath }),
	});
	return {
		base: `http://127.0.0.1:${srv.port}`,
		srv,
		dir,
		stop: () => {
			srv.stop(true);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Mint an API key through the admin API (scopes ride the body). */
export async function issueViaAdmin(
	base: string,
	body: Record<string, unknown>,
	root: string = ROOT,
): Promise<{ key: string; keyId: string }> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${root}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string; key_id: string };
	return { key: out.key, keyId: out.key_id };
}

export const CHAT_BODY = JSON.stringify({
	model: "glm-5.3-flash",
	stream: false,
});

export interface ChatOpts {
	body?: string;
	headers?: Record<string, string>;
}

/** POST one chat completion with a bearer token (null = no header). */
export async function chat(
	base: string,
	token: string | null,
	opts: ChatOpts = {},
): Promise<Response> {
	return fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...(opts.headers ?? {}),
		},
		body: opts.body ?? CHAT_BODY,
	});
}
