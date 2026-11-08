import { expect, test } from "@playwright/test";
import { createRunnerIdentity } from "../hooks/lib/runners/api/identity.ts";

test("identity authority outages stay unavailable instead of blaming credentials @unit", async () => {
	for (const status of [429, 503]) {
		const identity = createRunnerIdentity({
			baseUrl: "http://127.0.0.1:4111",
			fetch: async () => new Response(null, { status }),
		});
		await expect(
			identity(
				new Request("http://localhost", {
					headers: { authorization: "Bearer test-key" },
				}),
			),
		).rejects.toThrow("runner.identity_unavailable");
	}
});

test("identity uses verified key ID and rechecks revocation on every request @unit", async () => {
	let revoked = false;
	let calls = 0;
	const identity = createRunnerIdentity({
		baseUrl: "http://127.0.0.1:4111",
		fetch: async (url, init) => {
			calls++;
			expect(String(url)).toBe("http://127.0.0.1:4111/v1/fleet/whoami");
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer test-key",
			);
			return revoked
				? new Response(null, { status: 401 })
				: Response.json({
						authenticated: true,
						kind: "api_key",
						key_id: "key-user",
						actor: "root",
						team: null,
						scopes: ["buckle:runner:WRITE_"],
					});
		},
	});
	const request = () =>
		new Request("http://localhost:7810/runs", {
			headers: { authorization: "Bearer test-key" },
		});
	expect((await identity(request())).keyId).toBe("key-user");
	revoked = true;
	await expect(identity(request())).rejects.toThrow("runner.unauthorized");
	expect(calls).toBe(2);
});

test("identity refuses anonymous echoes, malformed bodies and missing bearer @unit", async () => {
	for (const body of [
		{ authenticated: false },
		{ authenticated: true, scopes: [] },
	]) {
		const identity = createRunnerIdentity({
			baseUrl: "http://127.0.0.1:4111",
			fetch: async () => Response.json(body),
		});
		await expect(
			identity(
				new Request("http://localhost", {
					headers: { authorization: "Bearer test-key" },
				}),
			),
		).rejects.toThrow("runner.unauthorized");
		await expect(identity(new Request("http://localhost"))).rejects.toThrow(
			"runner.unauthorized",
		);
	}
});
