// test/provider-pressure-e2e.test.ts — W1257: a real Z.ai shared-account
// burst answers 16x200/34x429 code 1302 "Rate limit reached for requests"
// (owner probe 2026-10-24; aggregate live load — RPM vs concurrency stays
// unclassified). Buckle must relay those refusals' status/code/message/source
// verbatim through BOTH gateways without collapsing its adaptive account
// pool to 1, and local admission overflow must answer a typed local 503 —
// never a fabricated 429.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { readRemoteTraces } from "@klh/telemetry/src/remote-traces.ts";

const GROUP = "glm-5.3-flash";
const POOL = "zai-coding-account";
const ROOT = "pressure-e2e-root";
const RATE_BODY = {
	code: "1302",
	type: "rate_limit_error",
	message: "[1302] Rate limit reached for requests",
};
const ENTITLEMENT_BODY = {
	code: "1311",
	type: "rate_limit_error",
	message: "current subscription plan does not yet include FlashX",
};
const BALANCE_BODY = {
	code: "1113",
	type: "rate_limit_error",
	message: "Insufficient balance or no resource package. Please recharge",
};

interface ChainMode {
	code: string;
	type: string;
	message: string;
	status429: boolean;
	holdMs: number;
}

const CHAT = "/v1/chat/completions";

function fakeHandler(mode: ChainMode) {
	return async (): Promise<Response> => {
		if (mode.holdMs > 0) await Bun.sleep(mode.holdMs);
		if (!mode.status429)
			return Response.json({
				id: "engine-1",
				model: GROUP,
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "engine says hi" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			});
		return Response.json(
			{ error: { code: mode.code, type: mode.type, message: mode.message } },
			{ status: 429, headers: { "retry-after": "1" } },
		);
	};
}

const POOL_POLICY = {
	gateway: {
		num_retries: 0,
		allowed_fails: 1000,
		cooldown_time: 30,
		provider_pools: {
			[POOL]: {
				concurrency: 50,
				intervalCap: 600,
				intervalMs: 1000,
				maxOutstanding: 100,
				queueWaitMs: 250,
				recovery: { successWindow: 4, decreasePercent: 25 },
				concurrencyErrorCodes: ["1302"],
			},
		},
	},
};

async function startChain(
	mode: ChainMode,
	frontEnv: Record<string, string> = {},
	policyPatch: Record<string, unknown> = {},
): Promise<{
	frontBase: string;
	hubBase: string;
	hubCalls: { path: string }[];
	stopFake(): void;
	cleanup(): void;
}> {
	const dir = mkdtempSync(join(tmpdir(), "pressure-e2e-"));
	const fake = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: fakeHandler(mode),
	});
	const policyPath = join(dir, "policy.json");
	writeFileSync(
		policyPath,
		JSON.stringify({
			gateway: { ...POOL_POLICY.gateway, ...policyPatch },
		}),
	);
	const hubUpstreams = join(dir, "hub-upstreams.json");
	writeFileSync(
		hubUpstreams,
		JSON.stringify({
			inherit_defaults: false,
			groups: {
				[GROUP]: [
					{
						url: `http://127.0.0.1:${fake.port}`,
						dialect: "openai",
						adapter: "openai-compat",
						model: GROUP,
						adapter_config: {
							provider_pool: POOL,
							provider_concurrency_error_codes: ["1302"],
						},
					},
				],
			},
		}),
	);
	const hub = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath: hubUpstreams,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	const frontUpstreams = join(dir, "front-upstreams.json");
	writeFileSync(
		frontUpstreams,
		JSON.stringify({
			inherit_defaults: false,
			groups: {
				[GROUP]: [
					{
						url: `http://127.0.0.1:${hub.port}`,
						dialect: "openai",
						adapter: "openai-compat",
						api_key_env: "PRESSURE_E2E_KEY",
						adapter_config: {
							provider_pool: POOL,
							provider_concurrency_error_codes: ["1302"],
						},
					},
				],
			},
		}),
	);
	const previous: Array<[string, string | undefined]> = Object.entries({
		PRESSURE_E2E_KEY: ROOT,
		...frontEnv,
	}).map(([key]) => [key, process.env[key]]);
	for (const [key, value] of Object.entries({
		PRESSURE_E2E_KEY: ROOT,
		...frontEnv,
	}))
		process.env[key] = value;
	const front = startServer({
		port: 0,
		hostname: "127.0.0.1",
		policyPath,
		upstreamsPath: frontUpstreams,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	return {
		frontBase: `http://127.0.0.1:${front.port}`,
		hubBase: `http://127.0.0.1:${hub.port}`,
		hubCalls: [],
		stopFake: () => fake.stop(true),
		cleanup() {
			front.stop(true);
			hub.stop(true);
			fake.stop(true);
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function poolMetric(base: string, field: string): Promise<number | null> {
	const text = await (
		await fetch(`${base}/v1/admin/metrics`, {
			headers: { authorization: `Bearer ${ROOT}` },
		})
	).text();
	const match = new RegExp(
		`^buckle_provider_pool_${field}\\{pool="${POOL}"\\} (\\d+)$`,
		"m",
	).exec(text);
	return match ? Number(match[1]) : null;
}

const burst = async (base: string, n: number): Promise<Response[]> =>
	Promise.all(
		Array.from({ length: n }, () =>
			fetch(`${base}${CHAT}`, {
				method: "POST",
				headers: { authorization: `Bearer ${ROOT}` },
				body: JSON.stringify({
					model: GROUP,
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
		),
	);

/** Every answer in a refusal wave is the provider's own 429, relayed
 *  verbatim, or a typed LOCAL admission 503 for the Retry-After deferral
 *  window — never a fabricated 429 story (W1257). */
async function assertRefusalWave(
	responses: Response[],
	code: string,
	messageFragment: string,
): Promise<void> {
	const relayed = responses.filter((r) => r.status === 429);
	const local = responses.filter((r) => r.status === 503);
	expect(relayed.length + local.length).toBe(responses.length);
	expect(relayed.length).toBeGreaterThan(0);
	for (const response of relayed) {
		const body = (await response.json()) as {
			error: { code: string; type: string; message: string };
		};
		expect(body.error.code).toBe(code);
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.message).toContain(messageFragment);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(
			1,
		);
	}
	for (const response of local) {
		const body = (await response.json()) as { detail: string };
		// front-local W1078 refusals carry the pool wording; a 503 raised
		// deeper in the chain relays as the front's typed no_route — both
		// honest LOCAL stories, neither a fabricated provider body
		expect(body.detail).toMatch(/provider account pool|no_route/);
	}
}

test("fifty concurrent provider 200s through two buckles: every answer useful, none fabricated", async () => {
	const mode: ChainMode = { ...RATE_BODY, status429: false, holdMs: 0 };
	const chain = await startChain(mode);
	try {
		const responses = await burst(chain.frontBase, 50);
		expect(responses.map((r) => r.status)).toEqual(
			Array.from({ length: 50 }, () => 200),
		);
		for (const response of responses) {
			const body = (await response.json()) as {
				choices: Array<{ message: { content: string } }>;
			};
			expect(body.choices[0].message.content).toBe("engine says hi");
		}
		for (const base of [chain.frontBase, chain.hubBase]) {
			expect(await poolMetric(base, "adaptive_concurrency")).toBe(50);
			expect(await poolMetric(base, "rate_limited_total")).toBe(0);
		}
	} finally {
		chain.cleanup();
	}
});

test("provider 429 1302 and 1311 relay exact status code message through both buckles; pool never collapses", async () => {
	const mode: ChainMode = { ...RATE_BODY, status429: true, holdMs: 0 };
	const dir = mkdtempSync(join(tmpdir(), "pressure-e2e-peers-"));
	const keyPath = join(dir, "read.key");
	writeFileSync(keyPath, ROOT, { mode: 0o600 });
	const chain = await startChain(mode, { W1191_PEER_KEY: ROOT });
	delete process.env.BUCKLE_TRACE_PEERS_FILE;
	try {
		const first = await burst(chain.frontBase, 12);
		// every client answer is either the provider's own refusal relayed
		// verbatim or a typed LOCAL admission refusal for the deferral window
		// the provider's Retry-After opened — never a mixed story
		await assertRefusalWave(first, "1302", "Rate limit reached for requests");
		// the provider's Retry-After defers the pool ~1s; waves inside that
		// window answer from the local queue, not upstream — wait it out
		await Bun.sleep(1100);
		// entitlement (1311) and balance (1113) are the provider's business
		// words: relayed verbatim, never pool backoff either way
		mode.code = ENTITLEMENT_BODY.code;
		mode.message = ENTITLEMENT_BODY.message;
		await assertRefusalWave(
			await burst(chain.frontBase, 4),
			"1311",
			"current subscription plan does not yet include FlashX",
		);
		await Bun.sleep(1100);
		mode.code = BALANCE_BODY.code;
		mode.message = BALANCE_BODY.message;
		await assertRefusalWave(
			await burst(chain.frontBase, 4),
			"1113",
			"Insufficient balance",
		);
		mode.code = RATE_BODY.code;
		mode.message = RATE_BODY.message;
		// let the wave-3 Retry-After deferral expire so the trace request
		// below gets a REAL relayed upstream rung (the provenance proof)
		await Bun.sleep(1100);
		for (const base of [chain.frontBase, chain.hubBase]) {
			expect(await poolMetric(base, "adaptive_concurrency")).toBe(50);
			expect(await poolMetric(base, "concurrency_limited_total")).toBe(0);
		}
		const traceId = "d".repeat(32);
		await fetch(`${chain.frontBase}${CHAT}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ROOT}`,
				traceparent: `00-${traceId}-1111111111111111-01`,
			},
			body: JSON.stringify({
				model: GROUP,
				messages: [{ role: "user", content: "hello" }],
			}),
		}).then((r) => r.text());
		const trace = await (
			await fetch(`${chain.frontBase}/v1/admin/traces?trace_id=${traceId}`, {
				headers: { authorization: `Bearer ${ROOT}` },
			})
		).json();
		expect(trace.attempts[0]).toMatchObject({
			status: 429,
			provider_error_code: "1302",
			provider_error_type: "rate_limit_error",
			refusal_origin: "upstream",
		});
		const peersPath = join(dir, "peers.json");
		writeFileSync(
			peersPath,
			JSON.stringify({
				peers: [{ hubId: "fixture", url: chain.hubBase, tokenFile: keyPath }],
			}),
			{ mode: 0o600 },
		);
		const remote = await readRemoteTraces(peersPath, traceId);
		expect(remote.peers[0].attempts[0]).toMatchObject({
			status: 429,
			provider_error_code: "1302",
			provider_error_type: "rate_limit_error",
		});
	} finally {
		delete process.env.W1191_PEER_KEY;
		chain.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("local admission overflow answers typed local 503, never a fabricated 429", async () => {
	const mode: ChainMode = { ...RATE_BODY, status429: false, holdMs: 60 };
	const chain = await startChain(mode, {
		BUCKLE_GROUP_CAPS: `${GROUP}:2`,
	});
	try {
		const responses = await burst(chain.frontBase, 12);
		const statuses = responses.map((r) => r.status);
		expect(statuses.filter((s) => s === 429)).toEqual([]);
		const refusals = statuses.filter((s) => s !== 200);
		expect(refusals.length).toBeGreaterThan(6);
		expect(refusals.every((s) => s === 503)).toBe(true);
		for (const response of responses.filter((r) => r.status !== 200)) {
			const body = (await response.json()) as {
				type: string;
				detail: string;
			};
			expect(body.type).toBe("/problems/service_unavailable");
			expect(body.detail).toContain("max in-flight");
			expect(
				Number(response.headers.get("retry-after")),
			).toBeGreaterThanOrEqual(1);
		}
	} finally {
		chain.cleanup();
	}
});

test("rate-limit cooldown answers a typed local 503 hold with banked provider words, never a fabricated 429", async () => {
	const mode: ChainMode = { ...RATE_BODY, status429: true, holdMs: 0 };
	// allowed_fails 1: the first refusal benches the leg for the whole
	// cooldown window; killing the fake makes every bench probe fail, so the
	// hold answers deterministically from LOCAL cooldown memory
	const chain = await startChain(
		mode,
		{},
		{ allowed_fails: 1, cooldown_time: 30 },
	);
	try {
		// while alive: real relayed refusals bank the provider's own words
		// (the hub rides the fake directly — one leg, so killing the fake
		// leaves the bench probe dead and the hold deterministic)
		await assertRefusalWave(
			await burst(chain.hubBase, 3),
			"1302",
			"Rate limit reached for requests",
		);
		chain.stopFake();
		const holds = await burst(chain.hubBase, 3);
		expect(holds.map((r) => r.status)).toEqual(
			Array.from({ length: 3 }, () => 503),
		);
		for (const response of holds) {
			const body = (await response.json()) as { detail: string };
			expect(body.detail).toContain("gateway cooldown");
			expect(body.detail).toContain("not the provider");
			expect(body.detail).toContain("last provider refusal: code 1302");
			expect(body.detail).toContain("Rate limit reached for requests");
			const retryAfter = Number(response.headers.get("retry-after"));
			expect(retryAfter).toBeGreaterThanOrEqual(1);
			expect(retryAfter).toBeLessThanOrEqual(30);
		}
	} finally {
		chain.cleanup();
	}
});
