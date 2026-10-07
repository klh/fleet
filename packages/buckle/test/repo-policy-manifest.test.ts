import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "policy-manifest-"));
writeFileSync(join(dir, "upstreams.yaml"), "groups: {}\n");
writeFileSync(
	join(dir, "policy.yaml"),
	"rows:\n  - id: fixture-policy\n    repoClass: any\n    check: [{exists: LICENSE}]\n    missingQuestion: Implement a license?\n    policySource: operator:fixture-v1\n",
);
const server = startServer({
	port: 0,
	dbPath: ":memory:",
	secretsHome: dir,
	upstreamsPath: join(dir, "upstreams.yaml"),
	repoPolicyPath: join(dir, "policy.yaml"),
	auth: { rootKey: "manifest-fixture-key" },
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});
const url = `http://127.0.0.1:${server.port}/repo-policy/manifest`;

test("policy discovery is governed and carries an exact content pin", async () => {
	expect((await fetch(url)).status).toBe(401);
	expect(
		(await fetch(url, { headers: { authorization: "Bearer invalid" } })).status,
	).toBe(401);
	const response = await fetch(url, {
		headers: { authorization: "Bearer manifest-fixture-key" },
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const manifest = await response.json();
	expect(manifest.version).toBe(1);
	expect(manifest.rows[0].id).toBe("fixture-policy");
	expect(manifest.sha256).toBe(
		createHash("sha256").update(JSON.stringify(manifest.rows)).digest("hex"),
	);
	expect(JSON.stringify(manifest)).not.toContain(dir);
});

test("manifest permits proxy read but denies unrelated scopes", async () => {
	for (const [scope, status] of [
		["buckle:proxy:READ_", 200],
		["buckle:admin:WRITE_", 403],
		["buckle:budget:READ_", 403],
	] as const) {
		const issued = await fetch(
			`http://127.0.0.1:${server.port}/v1/admin/keys`,
			{
				method: "POST",
				headers: { authorization: "Bearer manifest-fixture-key" },
				body: JSON.stringify({ name: `manifest-${scope}`, scopes: [scope] }),
			},
		);
		expect(issued.status).toBe(201);
		const body = await issued.json();
		expect(
			(await fetch(url, { headers: { authorization: `Bearer ${body.key}` } }))
				.status,
		).toBe(status);
	}
	expect(
		(
			await fetch(url, {
				method: "HEAD",
				headers: { authorization: "Bearer manifest-fixture-key" },
			})
		).status,
	).toBe(405);
});
