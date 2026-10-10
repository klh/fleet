// test/fleet-whoami.test.ts — W607: GET /v1/fleet/whoami is the GUI fleet
// reader's self-verify echo. The presented bearer IS the credential: the
// gate authenticates + scope-checks (proxy GET → buckle:proxy:READ_), the
// route echoes the principal (key_id, scopes) the fleet-mcp server audits
// and enforces. Revocation takes effect on the next echo.
import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

function start(): { base: string; stop(): void } {
	const dir = `/tmp/buckle-whoami-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	Bun.write(
		`${dir}.yaml`,
		`groups:\n  glm-5.3-flash:\n    - url: http://127.0.0.1:1\n      dialect: openai\n`,
	);
	const server = startServer({
		port: 0,
		upstreamsPath: `${dir}.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

async function mint(
	base: string,
	scopes: string[],
): Promise<{ key: string; keyId: string }> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({ name: "fleet-mcp-test", scopes }),
	});
	const out = (await res.json()) as { key: string; key_id: string };
	return { key: out.key, keyId: out.key_id };
}

async function revoke(base: string, keyId: string): Promise<void> {
	await fetch(`${base}/v1/admin/keys/${keyId}/revoke`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
	});
}

const whoami = (base: string, key: string | null): Promise<Response> =>
	fetch(`${base}/v1/fleet/whoami`, {
		headers: key === null ? {} : { authorization: `Bearer ${key}` },
	});

describe("W607 /v1/fleet/whoami", () => {
	test("proxy:READ_ key → 200 echo with key_id + scopes", async () => {
		const g = start();
		try {
			const { key, keyId } = await mint(g.base, ["buckle:proxy:READ_"]);
			const r = await whoami(g.base, key);
			expect(r.status).toBe(200);
			const b = (await r.json()) as {
				authenticated: boolean;
				key_id: string;
				scopes: string[];
			};
			expect(b.authenticated).toBe(true);
			expect(b.key_id).toBe(keyId);
			expect(b.scopes).toContain("buckle:proxy:READ_");
		} finally {
			g.stop();
		}
	});

	test("key without proxy scope → 403 insufficient_scope", async () => {
		const g = start();
		try {
			const { key } = await mint(g.base, ["buckle:admin:READ_"]);
			const r = await whoami(g.base, key);
			expect(r.status).toBe(403);
			const b = (await r.json()) as { code: string };
			expect(b.code).toBe("buckle.insufficient_scope");
		} finally {
			g.stop();
		}
	});

	test("revoked key → 401; missing key → 401", async () => {
		const g = start();
		try {
			const { key, keyId } = await mint(g.base, ["buckle:proxy:READ_"]);
			await revoke(g.base, keyId);
			const revoked = await whoami(g.base, key);
			expect(revoked.status).toBe(401);
			const none = await whoami(g.base, null);
			expect(none.status).toBe(401);
		} finally {
			g.stop();
		}
	});

	test("OPTIONS preflight → 204 + Allow (http-citizenship)", async () => {
		const g = start();
		try {
			const r = await fetch(`${g.base}/v1/fleet/whoami`, {
				method: "OPTIONS",
			});
			expect(r.status).toBe(204);
			expect(r.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
		} finally {
			g.stop();
		}
	});
});
