// w1117-mcp-deadline.test.ts — W1117: the direct MCP face rides the shared
// hop contract. Spawned server + stub infer leg prove: an expired contract is
// a 504 verdict before any dispatch; a live contract tightens the app clock
// (the response honors the contract, not the local default); belt_infer
// forwards the child contract — deadline passthrough, budget counted DOWN,
// belt's rung appended; absent contract mints the root (budget 99 − rung).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	encodeHopContract,
	parseHopContract,
	rungIdOf,
} from "../../telemetry/src/hop-contract.ts";

setDefaultTimeout(30_000);

const hits: { contract: string | null; prompt: string }[] = [];
const leg = Bun.serve({
	port: 0,
	async fetch(req) {
		const body = (await req.json()) as {
			messages?: { content?: string }[];
		};
		hits.push({
			contract: req.headers.get("x-klh-hop-contract"),
			prompt: body.messages?.[0]?.content ?? "",
		});
		if (body.messages?.[0]?.content === "stall") await Bun.sleep(2_500);
		return Response.json({
			content: [{ type: "text", text: "leg-answer" }],
		});
	},
});

const spawnMcp = async (deadlineMs?: number) => {
	const port = 19_950 + Math.floor(Math.random() * 400);
	const proc = Bun.spawn([process.execPath, "bin/mcp-server.ts"], {
		cwd: new URL("..", import.meta.url).pathname,
		env: {
			...process.env,
			BELT_MCP_PORT: String(port),
			BELT_MCP_DEV: "1",
			BELT_INFER_URL: `http://127.0.0.1:${leg.port}`,
			BELT_INFER_KEY: "bksk_test-scoped-fake",
			...(deadlineMs ? { BELT_MCP_REQUEST_MS: String(deadlineMs) } : {}),
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 100; i++) {
		if (
			await fetch(`${url}/health`)
				.then((r) => r.ok)
				.catch(() => false)
		)
			return { proc, url };
		await Bun.sleep(50);
	}
	proc.kill();
	throw new Error("mcp-server did not come up");
};

const infer = (
	url: string,
	headers: Record<string, string>,
	prompt = "w1117 deadline probe",
): Promise<Response> =>
	fetch(`${url}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: {
				name: "belt_infer",
				arguments: { prompt },
			},
		}),
	});

describe("w1117 mcp hop-contract deadline", () => {
	let mcp: Awaited<ReturnType<typeof spawnMcp>>;

	beforeAll(async () => {
		mcp = await spawnMcp();
	});
	afterAll(() => {
		mcp.proc.kill();
		leg.stop(true);
	});

	test("expired hop contract → 504 belt.mcp.deadline_expired, leg never hit", async () => {
		const before = hits.length;
		const r = await infer(mcp.url, {
			"x-klh-hop-contract": `v=1;deadline=${Date.now() - 1};budget=3;path=`,
		});
		expect(r.status).toBe(504);
		const body = (await r.json()) as { code?: string };
		expect(body.code).toBe("belt.mcp.deadline_expired");
		expect(hits.length).toBe(before);
	});

	test("no contract → belt_infer mints the root (budget 99, one rung)", async () => {
		const before = hits.length;
		const r = await infer(mcp.url, {});
		expect(r.status).toBe(200);
		const body = (await r.json()) as {
			result: { isError?: boolean; content: { text: string }[] };
		};
		expect(body.result.isError).toBeFalsy();
		expect(body.result.content[0]?.text).toBe("leg-answer");
		expect(hits.length).toBe(before + 1);
		const parsed = parseHopContract(hits[hits.length - 1]?.contract ?? null, 0);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") return;
		expect(parsed.budget).toBe(98); // 99 root − belt-mcp's own consumed rung
		expect(parsed.path.length).toBe(1);
	});

	test("live contract → child contract rides the leg (passthrough, budget down, rung appended)", async () => {
		const before = hits.length;
		const deadline = Date.now() + 60_000;
		const visited = "aaaaaaaaaaaaaaaa";
		const r = await infer(mcp.url, {
			"x-klh-hop-contract": encodeHopContract({
				deadlineMs: deadline,
				budget: 2,
				path: [visited],
			}) as string,
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as {
			result: { isError?: boolean };
		};
		expect(body.result.isError).toBeFalsy();
		expect(hits.length).toBe(before + 1);
		const hit = hits[hits.length - 1];
		const parsed = parseHopContract(hit?.contract ?? null, 0);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") return;
		expect(parsed.deadlineMs).toBe(deadline); // absolute passthrough
		expect(parsed.budget).toBe(1); // counted DOWN
		expect(parsed.path.length).toBe(2);
		expect(parsed.path[0]).toBe(visited);
		expect(parsed.path[1]).toBe(
			rungIdOf("127.0.0.1", leg.port, "belt-router"),
		);
	});

	test("contract tighter than the local default cuts the request at the contract", async () => {
		const tight = await spawnMcp(10_000);
		try {
			const deadline = Date.now() + 350;
			const started = Date.now();
			const r = await infer(
				tight.url,
				{
					"x-klh-hop-contract": encodeHopContract({
						deadlineMs: deadline,
						budget: 5,
						path: [],
					}) as string,
				},
				// stall variant: the leg holds 2.5s, the contract wins at ~350ms
				"stall",
			);
			// MCP law: protocol-level deadline (the app signal fired inside
			// dispatch's await chain) is the server's 504 problem, not a tool
			// error result — the throw beats callTool's catch.
			expect(r.status).toBe(504);
			const body = (await r.json()) as { code?: string };
			expect(body.code).toBe("belt.mcp.deadline");
			const elapsed = Date.now() - started;
			expect(elapsed).toBeGreaterThan(250);
			expect(elapsed).toBeLessThan(5_000); // contract, not the 10s default
			// and the child leg carried the caller's absolute deadline
			const parsed = parseHopContract(hits[hits.length - 1]?.contract ?? null, 0);
			expect(parsed.status).toBe("ok");
			if (parsed.status !== "ok") return;
			expect(parsed.deadlineMs).toBe(deadline);
		} finally {
			tight.proc.kill();
		}
	});
});
