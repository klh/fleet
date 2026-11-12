import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { createCredentialManager } from "./credentials.ts";

test("exact epoch lookup cannot borrow a higher live credential @unit", async () => {
	let minted = 0;
	const admin = serveStub((request) => {
		if (new URL(request.url).pathname.endsWith("/revoke"))
			return Response.json({ revoked: "fixture-key" });
		minted++;
		return Response.json(
			{
				key_id: `fixture-${minted}`,
				key: `fixture-key-${minted}`,
				name: "epoch-fixture",
				scopes: ["buckle:proxy:WRITE_"],
				expires_at: Date.now() + 60_000,
			},
			{ status: 201 },
		);
	});
	try {
		const manager = createCredentialManager({
			baseUrl: admin.url,
			adminKey: "fixture-admin",
		});
		await manager.mint("run", 1);
		await manager.mint("run", 3);
		expect(manager.resolve("run", 1)).toEqual({
			key: "fixture-key-1",
			keyId: "fixture-1",
			epoch: 1,
		});
		expect(manager.resolve("run")?.epoch).toBe(3);
		expect(manager.resolve("run", 2)).toBeUndefined();
		expect(manager.resolve("other", 1)).toBeUndefined();
		await manager.revoke("run", 1);
		expect(manager.resolve("run", 1)).toBeUndefined();
		expect(manager.resolve("run")?.epoch).toBe(3);
	} finally {
		admin.close();
	}
});
