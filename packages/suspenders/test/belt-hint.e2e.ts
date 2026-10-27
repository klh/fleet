// belt-hint.test.ts — knowledge distillation enters Buckle with the W96 hint.
import { expect, test } from "@playwright/test";

let captured: {
	auth: string | null;
	hint: string | null;
	body: Record<string, unknown>;
} | null = null;

const stub = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method !== "POST" || !req.url.endsWith("/v1/chat/completions"))
			return new Response("not found", { status: 404 });
		const auth = req.headers.get("authorization");
		const hint = req.headers.get("x-belt-hint");
		const body = (await req.json()) as Record<string, unknown>;
		captured = { auth, hint, body };
		return Response.json({ choices: [{ message: { content: "[]" } }] });
	},
});

test.afterAll(() => stub.stop(true));

test.describe("BuckleDistillClient W96 hint", () => {
	test("keeps the queue untouched when a scoped key is absent", () => {
		const script = [
			`const m = await import(${JSON.stringify(new URL("../hooks/lib/knowledge/distill-clients.ts", import.meta.url).pathname)});`,
			`m.makeDistillClient();`,
		].join("\n");
		const {
			SUSPENDERS_BUCKLE_URL: _url,
			SUSPENDERS_BUCKLE_TOKEN: _token,
			INGEST_LLM_URL: _legacy,
			...env
		} = process.env;
		const p = Bun.spawnSync(["bun", "-e", script], {
			env: { ...env, HOME: "/nonexistent-knowledge-buckle-home" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).not.toBe(0);
		expect(p.stderr.toString()).toContain(
			"scoped Buckle distill route unavailable",
		);
	});

	test("rejects the legacy direct endpoint override", () => {
		const script = [
			`const m = await import(${JSON.stringify(new URL("../hooks/lib/knowledge/distill-clients.ts", import.meta.url).pathname)});`,
			`m.makeDistillClient();`,
		].join("\n");
		const p = Bun.spawnSync(["bun", "-e", script], {
			env: {
				...process.env,
				INGEST_LLM_URL: "http://127.0.0.1:8903/v1/chat/completions",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).not.toBe(0);
		expect(p.stderr.toString()).toContain("INGEST_LLM_URL bypasses Buckle");
	});

	test("sends the scoped key, local-swarm group, and W96 hint", async () => {
		const script = [
			`const m = await import(${JSON.stringify(
				new URL("../hooks/lib/knowledge/distill-clients.ts", import.meta.url)
					.pathname,
			)});`,
			`const c = new m.BuckleDistillClient();`,
			`const out = await c.distill("payload-w96", {`,
			`  domain: "d", area: "a", codeOrigin: "c", originSid: "s",`,
			`});`,
			`console.log("RESULT" + JSON.stringify(out));`,
		].join("\n");
		const p = Bun.spawn(["bun", "-e", script], {
			env: {
				...process.env,
				SUSPENDERS_BUCKLE_URL: `http://127.0.0.1:${stub.port}`,
				SUSPENDERS_BUCKLE_TOKEN: "bksk_w96_test_token",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (code !== 0)
			throw new Error(`child failed (${code}): ${err.slice(0, 400)}`);
		if (!captured) throw new Error("stub saw no Buckle request");
		expect(captured.auth).toBe("Bearer bksk_w96_test_token");
		expect(captured.hint).toBe("prefer local distill reasoning");
		expect(captured.body.model).toBe("local-swarm");
		expect(captured.body.hint).toBeUndefined();
		expect(captured.body.role).toBeUndefined();
		expect(Array.isArray(captured.body.messages)).toBe(true);
		// the reply flows through parseDistill — "[]" means zero rows, cleanly
		expect(JSON.parse(out.split("RESULT")[1] ?? "bad")).toEqual([]);
	});
});
