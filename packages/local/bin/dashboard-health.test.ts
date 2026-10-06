import { afterEach, expect, test } from "bun:test";
import { probeService, serviceTarget } from "./dashboard-health.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

test("remote upstream takes precedence over a coincident local port", () => {
	expect(serviceTarget({ port: 7799, upstream: "nas.example:7799" })).toBe(
		"nas.example:7799",
	);
	expect(serviceTarget({ port: 7799 })).toBe("127.0.0.1:7799");
});

test("HTTP failures are reachable but do not pass the configured check", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response("down", { status: 503 }),
	});
	servers.push(server);
	expect(
		await probeService(`127.0.0.1:${server.port}`, "/health"),
	).toMatchObject({ ok: false, reachable: true, code: 503 });
});

test("redirects cannot hide a broken endpoint behind a successful landing page", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === "/health"
				? Response.redirect("/", 302)
				: new Response("ok"),
	});
	servers.push(server);
	expect(
		await probeService(`127.0.0.1:${server.port}`, "/health"),
	).toMatchObject({ ok: false, reachable: true, code: 302 });
});

test("successful configured check and unreachable service remain distinct", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response(null, { status: 204 }),
	});
	servers.push(server);
	const target = `127.0.0.1:${server.port}`;
	expect(await probeService(target, "/health")).toMatchObject({
		ok: true,
		reachable: true,
		code: 204,
	});
	server.stop(true);
	expect(await probeService(target, "/health")).toMatchObject({
		ok: false,
		reachable: false,
	});
});
