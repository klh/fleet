// w1117-router-auth.test.ts — W1117.5: the /v1/messages ingress credential
// gate (owner law #55681: first ingress via authenticated Buckle; the hop
// header alone is not auth). Unit-covers the verdict ladder; e2e spawns the
// real shim and proves the Buckle→Belt→Buckle return: credential enforced,
// trace/deadline/budget/visited-path preserved on the gate leg, and
// mid-escalation client cancellation reaching the gate.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyUpstreamAuth } from "../bin/router-auth.ts";
import {
	encodeHopContract,
	parseHopContract,
} from "../../telemetry/src/hop-contract.ts";

setDefaultTimeout(30_000);

describe("verifyUpstreamAuth verdict ladder", () => {
	const withKey = async <T>(
		value: string | undefined,
		run: () => Promise<T>,
	): Promise<T> => {
		const saved = process.env.BELT_UPSTREAM_KEY;
		if (value === undefined) delete process.env.BELT_UPSTREAM_KEY;
		else process.env.BELT_UPSTREAM_KEY = value;
		try {
			return await run();
		} finally {
			if (saved === undefined) delete process.env.BELT_UPSTREAM_KEY;
			else process.env.BELT_UPSTREAM_KEY = saved;
		}
	};
	const req = (headers: Record<string, string>) =>
		new Request("http://127.0.0.1:4000/v1/messages", {
			method: "POST",
			headers,
		});

	test("key unset → unconfigured (fail-closed, no open mode)", async () =>
		withKey(undefined, async () => {
			expect(verifyUpstreamAuth(req({})).verdict).toBe("unconfigured");
			expect(
				verifyUpstreamAuth(req({ authorization: "Bearer x" })).verdict,
			).toBe("unconfigured");
		}));

	test("correct Bearer credential → ok", async () =>
		withKey("bksk_peer-secret", async () => {
			expect(
				verifyUpstreamAuth(
					req({ authorization: "Bearer bksk_peer-secret" }),
				).verdict,
			).toBe("ok");
		}));

	test("anthropic-wire x-api-key accepted too", async () =>
		withKey("bksk_peer-secret", async () => {
			expect(
				verifyUpstreamAuth(req({ "x-api-key": "bksk_peer-secret" })).verdict,
			).toBe("ok");
		}));

	test("wrong or absent credential → denied", async () =>
		withKey("bksk_peer-secret", async () => {
			expect(verifyUpstreamAuth(req({})).verdict).toBe("denied");
			expect(
				verifyUpstreamAuth(req({ authorization: "Bearer nope" })).verdict,
			).toBe("denied");
			expect(
				verifyUpstreamAuth(req({ "x-api-key": "nope" })).verdict,
			).toBe("denied");
		}));
});

// ─── e2e: real shim, authenticated gate leg, loop + cancel ──────────────────
const KEY = "bksk_belt-ingress-fake";
const GATE_KEY = "bksk_gate-scoped-fake";

type GateHit = {
	authorization: string | null;
	contract: string | null;
	traceparent: string | null;
};

const gateHits: GateHit[] = [];
let gateHold: Promise<void> | null = null;
let gateAbortDeferred: { promise: Promise<void>; resolve: () => void } | null =
	null;
const gate = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname !== "/v1/messages")
			return new Response("not found", { status: 404 });
		gateHits.push({
			authorization: req.headers.get("authorization"),
			contract: req.headers.get("x-klh-hop-contract"),
			traceparent: req.headers.get("traceparent"),
		});
		if (gateAbortDeferred) {
			const deferred = gateAbortDeferred;
			gateAbortDeferred = null;
			req.signal.addEventListener("abort", () => deferred.resolve());
		}
		if (gateHold) await gateHold;
		return Response.json({
			content: [{ type: "text", text: "gate answer" }],
		});
	},
});

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response() });
	const p = s.port;
	s.stop(true);
	return p;
};

const spawnShim = async (withKey: boolean) => {
	const home = mkdtempSync(join(tmpdir(), "w1117-auth-"));
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "local-llm", "prefs.json"),
		JSON.stringify({ allow_cloud: true, kev: { enabled: false } }),
	);
	const port = await freePort();
	const proc = Bun.spawn(
		["bun", new URL("../bin/router-shim.ts", import.meta.url).pathname],
		{
			env: {
				...process.env,
				HOME: home,
				BELT_ROUTER_PORT: String(port),
				...(withKey ? { BELT_UPSTREAM_KEY: KEY } : {}),
				BELT_ESCALATE_URL: `http://127.0.0.1:${gate.port}`,
				BELT_ESCALATE_KEY: GATE_KEY,
				BELT_RETRY_WAIT_CAP_MS: "200",
			},
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 100; i++) {
		if (
			await fetch(`${base}/health`)
				.then((r) => r.ok)
				.catch(() => false)
		)
			return { proc, base, home };
		await Bun.sleep(50);
	}
	proc.kill();
	throw new Error("router-shim did not come up");
};

describe("w1117 authenticated ingress e2e", () => {
	let shim: Awaited<ReturnType<typeof spawnShim>>;

	beforeAll(async () => {
		shim = await spawnShim(true);
	});
	afterAll(() => {
		shim?.proc.kill();
		rmSync(shim?.home ?? "", { recursive: true, force: true });
		gate.stop(true);
	});

	const post = (headers: Record<string, string>, signal?: AbortSignal) =>
		fetch(`${shim.base}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({
				model: "glm-5.3-flash",
				max_tokens: 32,
				messages: [
					{
						role: "user",
						content:
							"From the attached 120k-token specification, explain the retry policy.",
					},
				],
			}),
			signal,
		});

	test("unauthenticated direct caller is refused and never reaches the gate", async () => {
		const hitsBefore = gateHits.length;
		const r = await post({});
		expect(r.status).toBe(401);
		expect(r.headers.get("x-klh-refusal")).toBe("unauthorized");
		expect(gateHits.length).toBe(hitsBefore);
	});

	test("unconfigured shim answers 503 unconfigured (fail-closed)", async () => {
		const bare = await spawnShim(false);
		try {
			const r = await fetch(`${bare.base}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(r.status).toBe(503);
			expect(r.headers.get("x-klh-refusal")).toBe("unconfigured");
		} finally {
			bare.proc.kill();
			rmSync(bare.home, { recursive: true, force: true });
		}
	});

	test("authenticated request rides the gate with preserved deadline/budget/path/trace", async () => {
		gateHits.length = 0;
		const deadline = Date.now() + 60_000;
		const visited = "aaaaaaaaaaaaaaaa";
		const traceId = "11111111111111111111111111111111";
		const r = await post({
			authorization: `Bearer ${KEY}`,
			"x-klh-hop-contract": encodeHopContract({
				deadlineMs: deadline,
				budget: 2,
				path: [visited],
			}) as string,
			traceparent: `00-${traceId}-2222222222222222-01`,
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as {
			content: { type: string; text: string }[];
		};
		expect(body.content[0]?.text).toBe("gate answer");
		expect(gateHits.length).toBe(1);
		const hit = gateHits[0];
		// belt presented the scoped gate credential, not the caller's
		expect(hit?.authorization).toBe(`Bearer ${GATE_KEY}`);
		// hop contract: deadline passthrough, budget counted DOWN, rung appended
		const parsed = parseHopContract(hit?.contract ?? null, 0);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") return;
		expect(parsed.deadlineMs).toBe(deadline);
		expect(parsed.budget).toBe(1);
		expect(parsed.path.length).toBe(2);
		expect(parsed.path[0]).toBe(visited);
		// trace preserved: same trace id, belt's own child span
		expect(hit?.traceparent?.startsWith(`00-${traceId}`)).toBe(true);
	});

	test("client cancellation mid-escalation aborts the gate leg", async () => {
		gateHits.length = 0;
		gateHold = new Promise(() => {});
		let resolveAbort: () => void;
		const gateSawAbort = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		gateAbortDeferred = { promise: gateSawAbort, resolve: resolveAbort };
		const controller = new AbortController();
		const call = post({ authorization: `Bearer ${KEY}` }, controller.signal);
		const guarded = call.catch(() => {});
		// wait until the gate received the escalated leg, then cancel
		for (let i = 0; i < 80 && gateHits.length === 0; i++)
			await Bun.sleep(25);
		expect(gateHits.length).toBe(1);
		controller.abort();
		await Promise.race([
			gateSawAbort,
			Bun.sleep(2000).then(() => {
				throw new Error("gate never saw the abort");
			}),
		]);
		await guarded;
		gateHold = null;
	});
});
