// belt-chat.test.ts — W552.6.1: the shared governed-gateway chat leg (kept
// for decide-eval). Placeholder/empty belt replies validate to null (never
// an answer). The advise chain retired its belt/direct legs in W1119.1 —
// the empty-answer honest-failure contract now rides the gated client
// (pinned in advise-gated.test.ts).
import { afterAll, setDefaultTimeout, describe, expect, test } from "bun:test";
import { boardFixture } from "./helpers/board-fixture.ts";
import { beltChat } from "../hooks/lib/belt-chat.ts";

setDefaultTimeout(30_000);

await boardFixture(0, afterAll);

// ─── beltChat unit: reply validation at the seam ───
describe("beltChat final-text validation", () => {
	const priorBelt = process.env.SUSPENDERS_BELT_URL;
	const withBelt = async (
		reply: unknown,
		status = 200,
		run?: (body: Record<string, unknown>) => void,
	) => {
		let seen: Record<string, unknown> | null = null;
		const mock = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				seen = (await req.json()) as Record<string, unknown>;
				return Response.json(reply, { status });
			},
		});
		process.env.SUSPENDERS_BELT_URL = `http://127.0.0.1:${mock.port}`;
		try {
			const r = await beltChat({ user: "w552 probe" });
			if (seen && run) run(seen);
			return r;
		} finally {
			mock.stop(true);
			if (priorBelt === undefined) delete process.env.SUSPENDERS_BELT_URL;
			else process.env.SUSPENDERS_BELT_URL = priorBelt;
		}
	};

	test("the belt placeholder is NOT an answer — validates to null", async () => {
		let body: Record<string, unknown> | null = null;
		const r = await withBelt({ reply: "(empty response)" }, 200, (b) => {
			body = b;
		});
		expect(r).toBeNull();
		expect(body?.execute).toBe(true);
		expect(body?.role).toBe("reasoning");
	});

	test("empty string reply validates to null", async () => {
		expect(await withBelt({ reply: "   " })).toBeNull();
	});

	test("a real reply passes through trimmed, with target metadata", async () => {
		const r = await withBelt({
			reply: "  RECOMMENDATION: go  \nRATIONALE: fine",
			target: { model: "glm-5.3-flash", machine: "mac" },
			ms: 7,
		});
		expect(r?.text).toBe("RECOMMENDATION: go  \nRATIONALE: fine");
		expect(r?.model).toBe("glm-5.3-flash");
		expect(r?.host).toBe("belt(mac)");
		expect(r?.ms).toBe(7);
	});

	test("belt erroring degrades to null (never throws)", async () => {
		expect(await withBelt({ error: "no healthy fit" }, 503)).toBeNull();
	});
});

// W1119.1.1 successors (consult C89): the advise-child integration block that
// stood here retired with the direct legs — wire contract + failure pins.
describe("beltChat wire contract (W1119.1.1)", () => {
	test("the /api/route wire carries the bearer credential and route shape", async () => {
		// the seam surface: beltChat is the ONE governed-gateway chat export
		expect(beltChat).toBeFunction();
		expect(beltChat.name).toBe("beltChat");
		expect(beltChat.length).toBe(1);
		const priorUrl = process.env.SUSPENDERS_BELT_URL;
		const priorToken = process.env.SUSPENDERS_BELT_TOKEN;
		const mock = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				// the wire contract pins fire on the real request, in the handler
				expect(req.method).toBe("POST");
				expect(new URL(req.url).pathname).toBe("/api/route");
				expect(req.headers.get("authorization")).toBe("Bearer belt-tok-1");
				const body = (await req.json()) as Record<string, unknown>;
				expect(body.role).toBe("reasoning");
				expect(body.execute).toBe(true);
				expect(body.max_tokens).toBe(500);
				expect(body.temperature).toBe(0.2);
				return Response.json({ reply: "wire ok" });
			},
		});
		process.env.SUSPENDERS_BELT_URL = `http://127.0.0.1:${mock.port}`;
		process.env.SUSPENDERS_BELT_TOKEN = "belt-tok-1";
		try {
			const r = await beltChat({ user: "wire probe" });
			expect(r?.text).toBe("wire ok");
		} finally {
			mock.stop(true);
			if (priorUrl === undefined) delete process.env.SUSPENDERS_BELT_URL;
			else process.env.SUSPENDERS_BELT_URL = priorUrl;
			if (priorToken === undefined) delete process.env.SUSPENDERS_BELT_TOKEN;
			else process.env.SUSPENDERS_BELT_TOKEN = priorToken;
		}
	});
});

test("message assembly rides system-first with the 500/0.2 defaults", async () => {
	const priorUrl = process.env.SUSPENDERS_BELT_URL;
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as Record<string, unknown>;
			const msgs = body.messages as { role: string; content: string }[];
			// the assembly pins fire on the real request, in the handler
			expect(msgs).toHaveLength(2);
			expect(msgs[0]?.role).toBe("system");
			expect(msgs[0]?.content).toBe("be terse");
			expect(msgs[1]?.role).toBe("user");
			expect(msgs[1]?.content).toBe("wire probe");
			expect(body.max_tokens).toBe(500);
			expect(body.temperature).toBe(0.2);
			return Response.json({ reply: "assembled" });
		},
	});
	process.env.SUSPENDERS_BELT_URL = `http://127.0.0.1:${mock.port}`;
	try {
		const r = await beltChat({ user: "wire probe", system: "be terse" });
		expect(r?.text).toBe("assembled");
	} finally {
		mock.stop(true);
		if (priorUrl === undefined) delete process.env.SUSPENDERS_BELT_URL;
		else process.env.SUSPENDERS_BELT_URL = priorUrl;
	}
});

test("an unreachable belt degrades to null on the network path (never throws)", async () => {
	const priorUrl = process.env.SUSPENDERS_BELT_URL;
	process.env.SUSPENDERS_BELT_URL = "http://127.0.0.1:1";
	try {
		expect(await beltChat({ user: "dead wire probe" })).toBeNull();
	} finally {
		if (priorUrl === undefined) delete process.env.SUSPENDERS_BELT_URL;
		else process.env.SUSPENDERS_BELT_URL = priorUrl;
	}
});
