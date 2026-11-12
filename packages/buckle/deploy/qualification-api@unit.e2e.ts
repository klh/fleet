import { expect, test } from "@playwright/test";
import { qualifyApi, CONTROL_SCOPES } from "./test/qualification-api.ts";
import { FIXTURE_CAPABILITIES } from "./test/fixture.ts";

for (const order of ["storage", "reverse"] as const)
	test(`qualification observes finite scoped CRUD with ${order} scope order`, async () => {
		const keys = new Map<
			string,
			{
				key_id: string;
				key: string;
				scopes: string[];
				expires_at: number;
				revoked_at: number | null;
			}
		>();
		let inference = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname,
					token = request.headers.get("authorization")?.slice(7),
					key = keys.get(token ?? "");
				const admin = token === "synthetic-root";
				if (!admin && (!key || key.revoked_at))
					return new Response(null, { status: 401 });
				if (path.startsWith("/v1/admin/") && !admin)
					return new Response(null, { status: 403 });
				if (path === "/v1/admin/keys" && request.method === "POST") {
					const body = await request.json();
					const index = keys.size + 1,
						minted = {
							key_id: index.toString(16).padStart(12, "0"),
							key: `synthetic-${index}`,
							scopes:
								order === "storage"
									? [...body.scopes].sort()
									: [...body.scopes].sort().reverse(),
							expires_at: Date.now() + body.expires_in_s * 1000,
							revoked_at: null,
						};
					keys.set(minted.key, minted);
					return Response.json(minted, { status: 201 });
				}
				if (path === "/v1/admin/keys")
					return Response.json({ keys: [...keys.values()] });
				if (path.endsWith("/revoke")) {
					const selected = [...keys.values()].find((row) =>
						path.includes(row.key_id),
					);
					if (selected) selected.revoked_at = Date.now();
					return Response.json({ revoked: selected?.key_id });
				}
				if (path === "/v1/admin/keys/verify") {
					const selected = keys.get((await request.json()).key);
					return Response.json(
						selected && !selected.revoked_at
							? { valid: true, key_id: selected.key_id }
							: { valid: false },
					);
				}
				if (path === "/v1/fleet/whoami")
					return Response.json({
						...key,
						scopes: [...(key?.scopes ?? [])].sort(),
					});
				if (path === "/v1/models")
					return Response.json({
						object: "list",
						data: [
							{
								id: "seed-model",
								object: "model",
								owned_by: "buckle",
								...FIXTURE_CAPABILITIES,
							},
						],
					});
				if (path === "/v1/chat/completions") {
					if (!key?.scopes.includes("buckle:proxy:WRITE_"))
						return new Response(null, { status: 403 });
					inference++;
					return new Response(
						new ReadableStream({
							async start(controller) {
								controller.enqueue(
									Buffer.from('data: {"usage":{"total_tokens":5}}\n\n'),
								);
								await Bun.sleep(20);
								controller.enqueue(Buffer.from("data: [DONE]\n\n"));
								controller.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				return new Response(null, { status: 404 });
			},
		});
		try {
			const facts = await qualifyApi(
				`http://127.0.0.1:${server.port}`,
				"synthetic-root",
				() => inference,
			);
			expect(facts.revokedKeys).toBe(2);
			expect([...facts.controlScopes].sort()).toEqual(
				[...CONTROL_SCOPES].sort(),
			);
			expect(
				[...keys.values()].every(
					(key) =>
						key.revoked_at &&
						key.scopes.every((scope) => !scope.startsWith("buckle:admin:")),
				),
			).toBe(true);
		} finally {
			await server.stop(true);
		}
	});
