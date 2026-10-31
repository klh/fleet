// test/serve-stub.test.ts — the kit's own suite for serveStub(): request
// recording, programmable responses, default handler, close().
import { expect, test } from "bun:test";
import { serveStub } from "../src/serve-stub.ts";

test("serveStub: records path/body/auth and answers programmatically", async () => {
	const stub = serveStub((_req, _body, n) =>
		n === 1
			? new Response("first", { status: 201 })
			: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
	);
	const r1 = await fetch(`${stub.url}/v1/messages`, {
		method: "POST",
		body: JSON.stringify({ model: "kit-probe" }),
		headers: { authorization: "Bearer kit-probe", "x-kit-probe": "1" },
	});
	expect(r1.status).toBe(201);
	const r2 = await fetch(`${stub.url}/health`);
	expect(r2.ok).toBe(true);
	const first = stub.requests[0];
	if (!first) throw new Error("no recorded request");
	expect(first.path).toBe("/v1/messages");
	expect(first.body).toEqual({ model: "kit-probe" });
	expect(first.auth).toBe("Bearer kit-probe");
	expect(first.headers.get("x-kit-probe")).toBe("1");
	expect(first.n).toBe(1);
	stub.close();
});

test("serveStub: default handler answers 200 ok", async () => {
	const stub = serveStub();
	const r = await fetch(`${stub.url}/anything`);
	expect(r.status).toBe(200);
	expect(await r.text()).toBe("ok");
	stub.close();
});

test("serveStub: close() frees the port", () => {
	const stub = serveStub();
	const port = stub.port;
	stub.close();
	// the port binds again immediately
	const s = Bun.serve({ port, fetch: () => new Response("ok") });
	s.stop(true);
});

test("serveStub: raw mode leaves non-JSON bodies for the handler", async () => {
	const stub = serveStub(
		async (req) => {
			const form = await req.formData();
			const f = form.get("file");
			if (!(f instanceof File)) return new Response("no file", { status: 400 });
			return Response.json({ name: f.name, text: await f.text() });
		},
		{ raw: true },
	);
	const form = new FormData();
	form.set("file", new File(["kit-bytes"], "k.txt"));
	const r = await fetch(`${stub.url}/v1/files`, { method: "POST", body: form });
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ name: "k.txt", text: "kit-bytes" });
	const rec = stub.requests[0];
	if (!rec) throw new Error("no recorded request");
	expect(rec.body).toBeNull();
	stub.close();
});
