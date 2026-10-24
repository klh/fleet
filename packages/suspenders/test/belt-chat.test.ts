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
