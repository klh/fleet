// test/wire-schema-parity.test.ts — W1303.4 schema-first parity: the zod
// wire schemas (src/wire-schemas.ts) are THE definition of the admin +
// model-list wire; these tests boot the REAL server and validate live
// responses against them, so schema/server drift fails loud instead of at
// client-render time. Self-contained JSON fixtures: the W1253 JSON-only
// parser rejects gate.ts's YAML kit (pre-existing; W1294.17 sweep owns it).
import { afterAll, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import {
	IssueKeyResponseSchema,
	KeyListResponseSchema,
	ModelListResponseSchema,
	ProblemSchema,
	RevokeKeyResponseSchema,
	VerifyKeyResponseSchema,
} from "../src/wire-schemas.ts";

const ROOT = "buckle-test-root";
const dir = `/tmp/buckle-w1303-${Date.now()}-${process.pid}`;
await Bun.write(
	`${dir}-upstreams.json`,
	JSON.stringify({
		groups: {
			"glm-5.3-flash": [{ url: "http://127.0.0.1:1/v1", dialect: "openai" }],
		},
	}),
);
await Bun.write(`${dir}-policy.json`, JSON.stringify({ gateway: {} }));
const server = startServer({
	port: 0,
	upstreamsPath: `${dir}-upstreams.json`,
	policyPath: `${dir}-policy.json`,
	dbPath: ":memory:",
	auth: { rootKey: ROOT },
});
const gate = { base: `http://127.0.0.1:${server.port}` };
afterAll(() => server.stop(true));

/** admin fetch with the root credential pre-attached. */
const admin = (path: string, init?: RequestInit) =>
	fetch(`${gate.base}${path}`, {
		...init,
		headers: { authorization: `Bearer ${ROOT}`, ...init?.headers },
	});

/** mint one proxy key through the real admin API. */
const issue = async (name: string) => {
	const res = await admin("/v1/admin/keys", {
		method: "POST",
		body: JSON.stringify({ name, scopes: ["buckle:proxy:WRITE_"] }),
	});
	const j = (await res.json()) as { key: string; key_id: string };
	return { key: j.key, keyId: j.key_id };
};

test("issue key response matches IssueKeyResponseSchema", async () => {
	const res = await admin("/v1/admin/keys", {
		method: "POST",
		body: JSON.stringify({
			name: "w1303-parity",
			scopes: ["buckle:proxy:WRITE_"],
		}),
	});
	expect(res.status).toBe(201);
	const j = await res.json();
	const r = IssueKeyResponseSchema.safeParse(j);
	expect(r.success).toBeTrue();
	// raw key material exists exactly once — the issue response
	expect(typeof j.key).toBe("string");
	expect(j.key.startsWith("bksk_")).toBeTrue();
});

test("key list matches KeyListResponseSchema and never carries key_hash", async () => {
	const res = await admin("/v1/admin/keys");
	const j = await res.json();
	expect(KeyListResponseSchema.safeParse(j).success).toBeTrue();
	expect(JSON.stringify(j)).not.toContain("key_hash");
});

test("verify key matches VerifyKeyResponseSchema (valid leg)", async () => {
	const { key } = await issue("w1303-verify");
	const res = await fetch(`${gate.base}/v1/admin/keys/verify`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({ key }),
	});
	const j = await res.json();
	const r = VerifyKeyResponseSchema.safeParse(j);
	expect(r.success).toBeTrue();
	expect(j.valid).toBeTrue();
});

test("verify key matches the invalid leg", async () => {
	const res = await fetch(`${gate.base}/v1/admin/keys/verify`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({ key: "bksk_not-a-real-key" }),
	});
	const j = await res.json();
	expect(VerifyKeyResponseSchema.safeParse(j).success).toBeTrue();
	expect(j.valid).toBeFalse();
});

test("revoke matches RevokeKeyResponseSchema", async () => {
	const { keyId } = await issue("w1303-revoke");
	const res = await fetch(`${gate.base}/v1/admin/keys/${keyId}/revoke`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
	});
	const j = await res.json();
	expect(RevokeKeyResponseSchema.safeParse(j).success).toBeTrue();
});

test("unauthorized proxy refusal matches ProblemSchema", async () => {
	const res = await fetch(`${gate.base}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "glm-5.3-flash", stream: false }),
	});
	expect(res.status).toBe(401);
	expect(res.headers.get("content-type")).toContain("application/problem+json");
	const j = await res.json();
	expect(ProblemSchema.safeParse(j).success).toBeTrue();
});

test("model list matches ModelListResponseSchema", async () => {
	const res = await fetch(`${gate.base}/v1/models`, {
		headers: { authorization: `Bearer ${ROOT}` },
	});
	const j = await res.json();
	expect(ModelListResponseSchema.safeParse(j).success).toBeTrue();
});
