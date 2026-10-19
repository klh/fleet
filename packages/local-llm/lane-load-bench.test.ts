import { describe, expect, test } from "bun:test";
import {
	benchConcurrency,
	benchPort,
	consumeLines,
	generateOnce,
	pctl,
	PROMPTS,
	probeResidency,
	summarize,
	type BenchRow,
	type Prompt,
	type Specialist,
} from "./lane-load-bench.ts";
import { SPECIALISTS } from "./registry.ts";

// registry rows feed the bench fixtures; empty would mean belt broke
const firstSpecialist = (): Specialist => {
	const s = SPECIALISTS[0];
	if (!s) throw new Error("SPECIALISTS empty — registry regressed");
	return s;
};

const promptById = (id: string): Prompt => {
	const p = PROMPTS.find((x) => x.id === id);
	if (!p) throw new Error(`prompt ${id} missing`);
	return p;
};

describe("pctl", () => {
	test("nearest-rank on sorted input", () => {
		expect(pctl([1, 2, 3, 4], 50)).toBe(2);
		expect(pctl([1, 2, 3, 4], 95)).toBe(4);
		expect(pctl([], 50)).toBeNull();
	});
});

describe("benchConcurrency", () => {
	test("registry cap wins, default 4", () => {
		expect(benchConcurrency({ ...firstSpecialist(), maxInflight: 2 })).toBe(2);
		expect(benchConcurrency({ ...firstSpecialist(), maxInflight: undefined })).toBe(
			4,
		);
	});
});

describe("consumeLines", () => {
	test("parses deltas, holds back partial tail", () => {
		const a = consumeLines(
			'data: {"choices":[{"delta":{"content":"He"}}]}\n' +
				'data: {"choices":[{"delta":{"content":"j"}}]}\n' +
				'data: {"choices":[{"delta":{"content":"jsa"}}',
		);
		expect(a.chunks).toBe(2);
		expect(a.text).toBe("Hej");
		expect(a.ttft).toBe(true);
		expect(a.rest).toBe('data: {"choices":[{"delta":{"content":"jsa"}}');
	});
	test("skips [DONE] and non-data lines", () => {
		const a = consumeLines(
			"event: ping\n" +
				"data: [DONE]\n" +
				'data: {"choices":[{"delta":{"content":"x"}}]}\n',
		);
		expect(a.chunks).toBe(1);
	});
});

describe("PROMPTS validators", () => {
	test("format-line accepts exact, rejects chatter", () => {
		const p = promptById("format-line");
		expect(p.grade("STATUS=ok")).toBe(true);
		expect(p.grade("STATUS=ok\nthanks")).toBe(false);
	});
	test("json-shape parses and checks fields", () => {
		const p = promptById("json-shape");
		expect(p.grade('{"ok":true,"n":7}')).toBe(true);
		expect(p.grade('```json\n{"ok":true,"n":7}\n```')).toBe(true);
		expect(p.grade('{"ok":false,"n":7}')).toBe(false);
	});
	test("count-letters + danish sanity", () => {
		const c = promptById("count-letters");
		expect(c.grade("5")).toBe(true);
		expect(c.grade("The word has 5 letters.")).toBe(true);
		expect(c.grade("4")).toBe(false);
		const d = promptById("danish");
		expect(d.grade("Flåden bevæger sig som én.")).toBe(true);
		expect(d.grade("The fleet moves as one.")).toBe(false);
	});
});

describe("generateOnce + benchPort vs stub", () => {
	const stub = (): { server: Bun.Server; port: number } => {
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				if (new URL(req.url).pathname === "/health")
					return Response.json({ ok: true });
				const body = await req.text();
				const reply = body.includes("JSON")
					? '{"ok":true,"n":7}'
					: "STATUS=ok";
				return new Response(
					`data: ${JSON.stringify({
						choices: [{ delta: { content: reply } }],
					})}\n\n` + "data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		return { server, port: server.port };
	};
	test("generateOnce parses the stream", async () => {
		const { server, port } = stub();
		try {
			const r = await generateOnce(port, "stub-model", PROMPTS[0]);
			expect(r.ok).toBe(true);
			expect(r.text).toContain("STATUS=ok");
			expect(r.ttftMs).toBeLessThan(5000);
		} finally {
			server.stop(true);
		}
	});
	test("benchPort labels cold and grades quality", async () => {
		const { server, port } = stub();
		try {
			const s = { ...firstSpecialist(), port };
			const rows = await benchPort(s, 2, 2, false);
			expect(rows).toHaveLength(4);
			expect(rows.filter((r) => r.cold)).toHaveLength(2); // round 1
			expect(rows.every((r) => r.quality === "pass")).toBe(true);
			expect(rows.every((r) => r.concurrency === 2)).toBe(true);
		} finally {
			server.stop(true);
		}
	});
	test("probeResidency true vs stub /health", async () => {
		const { server, port } = stub();
		try {
			const s = { ...firstSpecialist(), port };
			expect(await probeResidency(s)).toBe(true);
		} finally {
			server.stop(true);
		}
	});
});

describe("summarize", () => {
	test("renders one line per port with quality tally", () => {
		const row = (over: object): BenchRow =>
			({
				port: 8901,
				model: "m",
				role: "code",
				alias: "local-coder",
				concurrency: 2,
				round: 1,
				slot: 0,
				cold: false,
				resident_before: true,
				ttft_ms: 200,
				total_ms: 400,
				chunks: 5,
				ok: true,
				quality: "pass",
				...over,
			}) as never;
		const lines = summarize([row({}), row({ slot: 1 })]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("port 8901");
		expect(lines[0]).toContain("quality=2/2");
	});
});
