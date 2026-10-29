// test/systemone.e2e.ts — W1120: the typed SystemOne ingress. Proves the
// fail-closed law (no target, no key), the semantic-success contract
// (well-formed typed answers relayed), the malformed-decision refusal
// (out-of-set choice never relays), the deadline (a hung upstream hits the
// configured ceiling), cancel propagation (caller abort → upstream abort),
// and the 429 relay with retry-after. Every failure lands an audit row +
// hop receipt; a lane-prefixed path never widens the surface.
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import { newTraceparent } from "../src/trace.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { type GateServer, issueViaAdmin, startGate } from "./gate.ts";
import { type MockUpstream, startMockUpstream } from "./mock.ts";

// systemone never routes through the candidate table — an empty pool.
const EMPTY: UpstreamPool = { groups: () => [], deployments: () => [] };

test.describe("@api", () => {
	const post = (
		app: { fetch(r: Request): Promise<Response> },
		url: string,
		body: unknown,
		init?: RequestInit,
	): Promise<Response> =>
		app.fetch(
			new Request(`${url}/v1/systemone`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				...init,
			}),
		);

	const req = (
		overrides?: Record<string, unknown>,
	): Record<string, unknown> => ({
		state: "the request asks about routing tiers",
		questions: {
			use_case: {
				type: "choice",
				instructions: "Which use-case class is this?",
				criteria: { coding: "code work", research: "multi-source" },
			},
		},
		...overrides,
	});

	const okUpstreamBody = (): Record<string, unknown> => ({
		model: "kev-0.4",
		answers: {
			use_case: {
				type: "choice",
				choice: "coding",
				confidence: 0.9,
				probabilities: { coding: 0.9, research: 0.1 },
			},
		},
		usage: { input_tokens: 70, output_tokens: 8 },
		latency_ms: 42,
	});

	/** The scoped-key leg of the gate test: mint a proxy-WRITE lane key, ride
	 *  the front door, expect the typed answer through. */
	const laneKeyLeg = async (base: string): Promise<void> => {
		const lane = await issueViaAdmin(base, {
			name: "w1120-lane",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const ok = await fetch(`${base}/v1/systemone`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${lane.key}`,
			},
			body: JSON.stringify(req()),
		});
		expect(ok.status).toBe(200);
		const j = (await ok.json()) as {
			answers?: Record<string, { choice?: string }>;
		};
		expect(j.answers?.use_case?.choice).toBe("coding");
	};

	/** The trace leg's upstream: always 500s — the receipt + audit row carry
	 *  the failure onto the trace. */
	const traceLegUpstream = async (): Promise<MockUpstream> =>
		startMockUpstream(() => new Response("{}", { status: 500 }));

	const withKey = (): void => {
		process.env.BUCKLE_SYSTEMONE_TEST_KEY = "k-s1-test";
	};
	const dropKey = (): void => {
		delete process.env.BUCKLE_SYSTEMONE_TEST_KEY;
	};

	test("fail closed: no configured target → typed 503, zero outbound", async () => {
		const app = createApp(testDeps(EMPTY, {}));
		const res = await post(app, "http://buckle.test", req());
		expect(res.status).toBe(503);
		const j = (await res.json()) as { code?: string };
		expect(j.code).toBe("buckle.systemone_unconfigured");
	});

	test("fail closed: key env unset → typed 503, zero outbound", async () => {
		const deps = testDeps(EMPTY, {
			systemonePolicy: {
				url: "http://127.0.0.1:1",
				api_key_env: "BUCKLE_SYSTEMONE_KEY_DEFINITELY_UNSET",
			},
		});
		const app = createApp(deps);
		const res = await post(app, "http://buckle.test", req());
		expect(res.status).toBe(503);
		const j = (await res.json()) as { code?: string };
		expect(j.code).toBe("buckle.systemone_no_key");
	});

	test("success: typed decision relayed with usage + latency", async () => {
		let kev: MockUpstream | undefined;
		try {
			kev = await startMockUpstream(
				() =>
					new Response(JSON.stringify(okUpstreamBody()), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			);
			withKey();
			const deps = testDeps(EMPTY, {
				systemonePolicy: {
					url: kev.url,
					api_key_env: "BUCKLE_SYSTEMONE_TEST_KEY",
				},
			});
			const app = createApp(deps);
			const res = await post(app, "http://buckle.test", req());
			expect(res.status).toBe(200);
			const j = (await res.json()) as {
				model?: string;
				answers?: Record<string, { choice?: string }>;
				usage?: Record<string, number>;
				latency_ms?: number;
			};
			expect(j.model).toBe("kev-0.4");
			expect(j.answers?.use_case?.choice).toBe("coding");
			expect(j.usage?.input_tokens).toBe(70);
			expect(typeof j.latency_ms).toBe("number");
			expect(kev.calls.length).toBe(1);
			const call = kev.calls[0];
			expect(call.headers.get("authorization")).toBe("Bearer k-s1-test");
			const sent = call.body as {
				state?: string;
				questions?: Record<string, unknown>;
			};
			expect(sent.state).toBe("the request asks about routing tiers");
			expect(Object.keys(sent.questions ?? {}).length).toBe(1);
		} finally {
			dropKey();
			kev?.close();
		}
	});

	test("malformed decision: choice outside the criteria → 502, never relayed", async () => {
		let kev: MockUpstream | undefined;
		try {
			kev = await startMockUpstream(() => {
				const body = okUpstreamBody();
				const answers = body.answers as Record<string, Record<string, unknown>>;
				answers.use_case.choice = "trading";
				(answers.use_case.probabilities as Record<string, number>).trading =
					0.99;
				return new Response(JSON.stringify(body), { status: 200 });
			});
			withKey();
			const deps = testDeps(EMPTY, {
				systemonePolicy: {
					url: kev.url,
					api_key_env: "BUCKLE_SYSTEMONE_TEST_KEY",
				},
			});
			const app = createApp(deps);
			const res = await post(app, "http://buckle.test", req());
			expect(res.status).toBe(502);
			const j = (await res.json()) as { code?: string };
			expect(j.code).toBe("buckle.systemone_malformed");
		} finally {
			dropKey();
			kev?.close();
		}
	});

	test("timeout: hung upstream hits the configured ceiling → 504", async () => {
		let kev: MockUpstream | undefined;
		try {
			kev = await startMockUpstream(
				() =>
					new Promise<Response>((resolve) => {
						setTimeout(
							() => resolve(new Response("{}", { status: 200 })),
							10_000,
						);
					}),
			);
			withKey();
			const deps = testDeps(EMPTY, {
				systemonePolicy: {
					url: kev.url,
					api_key_env: "BUCKLE_SYSTEMONE_TEST_KEY",
					timeout_ms: 250,
				},
			});
			const app = createApp(deps);
			const res = await post(app, "http://buckle.test", req());
			expect(res.status).toBe(504);
			const j = (await res.json()) as { code?: string };
			expect(j.code).toBe("buckle.systemone_timeout");
		} finally {
			dropKey();
			kev?.close();
		}
	});

	test("cancel: caller disconnect aborts the upstream exchange", async () => {
		const held = new Promise<Response>((resolve) => {
			setTimeout(() => resolve(new Response("{}", { status: 200 })), 5_000);
		});
		let kev: MockUpstream | undefined;
		try {
			kev = await startMockUpstream(() => held);
			withKey();
			const deps = testDeps(EMPTY, {
				systemonePolicy: {
					url: kev.url,
					api_key_env: "BUCKLE_SYSTEMONE_TEST_KEY",
				},
			});
			const app = createApp(deps);
			const ctl = new AbortController();
			const p = post(app, "http://buckle.test", req(), {
				signal: ctl.signal,
			});
			await Bun.sleep(30);
			const sawRequest = kev.calls.length > 0;
			ctl.abort();
			const res = await p;
			expect(res.status).toBe(499);
			expect(sawRequest).toBe(true);
		} finally {
			dropKey();
			kev?.close();
		}
	});

	test("429: upstream budget refusal relays with retry-after", async () => {
		let kev: MockUpstream | undefined;
		try {
			kev = await startMockUpstream(
				() =>
					new Response("{}", {
						status: 429,
						headers: { "retry-after": "7" },
					}),
			);
			withKey();
			const deps = testDeps(EMPTY, {
				systemonePolicy: {
					url: kev.url,
					api_key_env: "BUCKLE_SYSTEMONE_TEST_KEY",
				},
			});
			const app = createApp(deps);
			const res = await post(app, "http://buckle.test", req());
			expect(res.status).toBe(429);
			expect(res.headers.get("retry-after")).toBe("7");
			const j = (await res.json()) as { code?: string };
			expect(j.code).toBe("buckle.systemone_rate_limited");
		} finally {
			dropKey();
			kev?.close();
		}
	});

	test("bad request: drift fails loud — 400 with the parse why", async () => {
		// a bad body must 400, not hide behind the fail-closed 503
		const deps = testDeps(EMPTY, {
			systemonePolicy: {
				url: "http://127.0.0.1:1",
				api_key_env: "BUCKLE_SYSTEMONE_TEST_KEY",
			},
		});
		withKey();
		const app = createApp(deps);
		const res = await post(app, "http://buckle.test", {
			state: "x",
			questions: { d: { type: "ranking", criteria: { a: "a", b: "b" } } },
		});
		expect(res.status).toBe(400);
		const j = (await res.json()) as { code?: string };
		expect(j.code).toBe("buckle.systemone_bad_request");
		dropKey();
	});

	test("surface law: lane prefix never widens — /w/<slug>/v1/systemone 404s", async () => {
		const app = createApp(testDeps(EMPTY, {}));
		const res = await app.fetch(
			new Request("http://buckle.test/w/laneslug/v1/systemone", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(req()),
			}),
		);
		expect(res.status).toBe(404);
	});

	test("OPTIONS answers from the one route table", async () => {
		const app = createApp(testDeps(EMPTY, {}));
		const res = await app.fetch(
			new Request("http://buckle.test/v1/systemone", { method: "OPTIONS" }),
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("allow")).toContain("POST");
	});

	test("trace: semantic outcome + upstream hop land on the ledger", async () => {
		let kev: MockUpstream | undefined;
		try {
			kev = await traceLegUpstream();
			withKey();
			const deps = testDeps(EMPTY, {
				systemonePolicy: {
					url: kev.url,
					api_key_env: "BUCKLE_SYSTEMONE_TEST_KEY",
				},
			});
			const app = createApp(deps);
			const tp = newTraceparent();
			const res = await post(app, "http://buckle.test", req(), {
				headers: { "content-type": "application/json", traceparent: tp },
			});
			expect(res.status).toBe(502);
			deps.ledger.flush();
			const read = deps.ledger.traceRead(tp.split("-")[1] ?? "");
			expect(read.attempts[0]?.hop).toBe("systemone");
			expect(read.attempts[0]?.status).toBe(500);
			const reqs = read.requests as Array<{
				dialect?: string;
				error_code?: string | null;
			}>;
			expect(reqs[0]?.dialect).toBe("systemone");
			expect(reqs[0]?.error_code).toBe("upstream_error");
		} finally {
			dropKey();
			kev?.close();
		}
	});

	test("no direct caller bypass: the gated route demands a credential", async () => {
		let kev: MockUpstream | undefined;
		let gate: GateServer | undefined;
		try {
			kev = await startMockUpstream(
				() => new Response(JSON.stringify(okUpstreamBody()), { status: 200 }),
			);
			withKey();
			gate = await startGate({
				upstreamUrl: kev.url,
				// explicit .json policy path — the .yaml name is retired (W1253)
				// and a misnamed file silently falls through to the machine conf
				policyYaml: JSON.stringify({
					gateway: {
						num_retries: 1,
						allowed_fails: 3,
						systemone: {
							url: kev.url,
							api_key_env: "BUCKLE_SYSTEMONE_TEST_KEY",
						},
					},
				}),
				policyJson: true,
			});
			// no credential → 401 before the route runs (never an anonymous hop)
			const anon = await fetch(`${gate.base}/v1/systemone`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(req()),
			});
			expect(anon.status).toBe(401);
			await laneKeyLeg(gate.base);
		} finally {
			dropKey();
			gate?.stop();
			kev?.close();
		}
	});
});
