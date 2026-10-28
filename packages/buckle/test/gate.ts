// test/gate.ts — shared gate fixture kit (W1135.1.2): one startGate
// bootstrap (scratch upstreams yaml + real Bun.serve gate on port 0),
// issueViaAdmin, and the chat() probe, replacing the per-file copies
// across the gov-* / e2e-* suites. Behavior-neutral: same yaml shape,
// same auth shapes, same return contracts.
import { startServer } from "../src/server.ts";

export const ROOT = "buckle-test-root";

export interface GateServer {
	base: string;
	stop(): void;
}

export interface Issued {
	key: string;
	keyId: string;
}

export interface GateJwt {
	issuers: Array<{ issuer: string; jwksUri: string }>;
	audience: string;
}

export interface StartGateOptions {
	/** Full upstreams yaml; wins over the upstreamUrl/model/dialect form. */
	yaml?: string;
	/** Single-group convenience: one model row on a scratch loopback. */
	upstreamUrl?: string;
	model?: string;
	dialect?: string;
	jwt?: GateJwt;
	slots?: { global: number; perTeam: number };
	/** W1118: admission-slot lease length (ms) — short leases make sweeps deterministic. */
	slotLeaseMs?: number;
	/** Test seam for the app-owned request-body deadline. */
	ingressBodyTimeoutMs?: number;
	/** Gateway policy yaml, written next to the scratch upstreams file. */
	policyYaml?: string;
}

const yamlFor = (opts: StartGateOptions): string => {
	if (opts.yaml) return opts.yaml;
	const model = opts.model ?? "glm-5.3-flash";
	// W1253: JSON content — the upstreams parser is JSON-only.
	return JSON.stringify({
		groups: {
			[model]: [{ url: opts.upstreamUrl, dialect: opts.dialect ?? "openai" }],
		},
	});
};

/** One real gate on a scratch port: writes the upstreams (+policy) yaml
 *  to /tmp, boots startServer with an in-memory ledger. The policy file is
 *  ALWAYS explicit — explicit path wins the loadGatewayPolicy chain over
 *  BUCKLE_POLICY/BELT_POLICY env and the machine routing-policy, so the
 *  suite is hermetic to operator knobs. */
export async function startGate(
	opts: StartGateOptions = {},
): Promise<GateServer> {
	const dir = `/tmp/buckle-gate-${Date.now()}-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	await Bun.write(`${dir}.yaml`, yamlFor(opts));
	await Bun.write(
		`${dir}-policy.yaml`,
		opts.policyYaml ??
			JSON.stringify({ gateway: { num_retries: 1, allowed_fails: 3 } }),
	);
	const server = startServer({
		port: 0,
		upstreamsPath: `${dir}.yaml`,
		policyPath: `${dir}-policy.yaml`,
		dbPath: ":memory:",
		auth: {
			rootKey: ROOT,
			jwt: opts.jwt,
			...(opts.slots ? { slots: opts.slots } : {}),
		},
		...(opts.ingressBodyTimeoutMs
			? { ingressBodyTimeoutMs: opts.ingressBodyTimeoutMs }
			: {}),
		...(opts.slotLeaseMs ? { slotLeaseMs: opts.slotLeaseMs } : {}),
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

/** Mint a key over the admin API; rootKey defaults to the shared ROOT. */
export async function issueViaAdmin(
	base: string,
	body: Record<string, unknown>,
	rootKey: string = ROOT,
): Promise<Issued> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${rootKey}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string; key_id: string };
	return { key: out.key, keyId: out.key_id };
}

const CHAT_BODY = JSON.stringify({ model: "glm-5.3-flash", stream: false });

/** The standard proxy probe: POST /v1/chat/completions. token null sends
 *  no auth header (the 401 leg); extra rides additional headers. */
export function chat(
	base: string,
	token: string | null,
	extra?: Record<string, string>,
): Promise<Response> {
	return fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...extra,
		},
		body: CHAT_BODY,
	});
}
