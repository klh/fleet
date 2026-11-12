import { expect, test } from "@playwright/test";
import { qualifyApi, CONTROL_SCOPES } from "./test/qualification-api.ts";

for (const location of ["issued", "identity"] as const)
	for (const defect of ["extra", "missing", "duplicate"] as const)
		test(`${location} ${defect} authority refuses before further API effects`, async () => {
			const invalid =
				defect === "extra"
					? [...CONTROL_SCOPES, "buckle:admin:READ_"]
					: defect === "missing"
						? CONTROL_SCOPES.slice(0, 1)
						: [...CONTROL_SCOPES, CONTROL_SCOPES[0]];
			let unexpected = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const path = new URL(request.url).pathname;
					if (path === "/v1/models" && !request.headers.has("authorization"))
						return new Response(null, { status: 401 });
					if (path === "/v1/admin/keys" && request.method === "POST")
						return Response.json(
							{
								key_id: "a".repeat(12),
								key: "synthetic-control",
								scopes:
									location === "issued" ? invalid : [...CONTROL_SCOPES].sort(),
								expires_at: Date.now() + 60000,
							},
							{ status: 201 },
						);
					if (path === "/v1/fleet/whoami")
						return Response.json({ key_id: "a".repeat(12), scopes: invalid });
					unexpected++;
					return new Response(null, { status: 404 });
				},
			});
			try {
				await expect(
					qualifyApi(
						`http://127.0.0.1:${server.port}`,
						"synthetic-root",
						() => 0,
					),
				).rejects.toThrow();
				expect(unexpected).toBe(0);
			} finally {
				await server.stop(true);
			}
		});
