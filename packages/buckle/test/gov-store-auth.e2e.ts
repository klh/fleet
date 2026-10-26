// test/gov-store-auth.test.ts — W764: store pull auth — scope gate before
// bucket, per-key fairness isolation, and the wire error envelope.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { KeyStore } from "../src/gov/keys.ts";
import { applyGovernanceSchema } from "../src/gov/schema.ts";
import {
	PullAuthorizer,
	STORE_READ_SCOPE,
	STORE_WRITE_SCOPE,
	TokenBucket,
} from "../src/gov/store-auth.ts";

test.describe({ tag: "@unit" }, () => {
	function govDb(): Database {
		const db = new Database(":memory:", { create: true });
		applyGovernanceSchema(db);
		return db;
	}

	function bearer(token: string | null): Headers {
		const h = new Headers();
		if (token !== null) h.set("authorization", `Bearer ${token}`);
		return h;
	}

	function keyWith(
		ks: KeyStore,
		scopes: string[],
		expiresInS: number | null = null,
	): string {
		return ks.issue({
			name: "t",
			team: null,
			scopes,
			rpmLimit: null,
			tpmLimit: null,
			expiresInS,
			actor: "test",
		}).key;
	}

	const mkBucket = () =>
		new TokenBucket({ capacity: 3, refillPerS: 1, idleTtlMs: 60_000 });

	test.describe("TokenBucket", () => {
		test("burst drain → disallow with retryAfterS, refill over time", () => {
			const b = mkBucket();
			expect(b.take("k", 1, 1000).ok).toBe(true);
			expect(b.take("k", 1, 1000).ok).toBe(true);
			expect(b.take("k", 1, 1000).ok).toBe(true);
			const r4 = b.take("k", 1, 1000);
			expect(r4.ok).toBe(false);
			if (r4.ok) return;
			expect(r4.retryAfterS).toBe(1);
			const r5 = b.take("k", 1, 2100);
			expect(r5.ok).toBe(true);
		});

		test("cost above capacity is unsatisfiable → retryAfterS null", () => {
			const b = mkBucket();
			const r = b.take("k", 4, 1000);
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.retryAfterS).toBeNull();
		});

		test("buckets are per-key: draining one never touches another", () => {
			const b = mkBucket();
			for (let i = 0; i < 3; i++) expect(b.take("a", 1, 1000).ok).toBe(true);
			expect(b.take("a", 1, 1000).ok).toBe(false);
			expect(b.take("b", 1, 1000).ok).toBe(true);
		});
	});

	test.describe("sweep", () => {
		test("drops idle buckets, fresh take gets full capacity again", () => {
			const b = new TokenBucket({ capacity: 2, refillPerS: 1, idleTtlMs: 500 });
			expect(b.take("k", 1, 1000).ok).toBe(true);
			expect(b.take("k", 1, 1000).ok).toBe(true);
			expect(b.take("k", 1, 1000).ok).toBe(false);
			expect(b.sweep(1600)).toBe(1);
			expect(b.take("k", 1, 1600).ok).toBe(true);
		});
	});

	test.describe("authorize", () => {
		function authorizer(): PullAuthorizer {
			return new PullAuthorizer({
				keys: new KeyStore(govDb()),
				bucket: mkBucket(),
			});
		}

		test("missing credential → 401 buckle.auth_missing", () => {
			const r = authorizer().authorize(bearer(null));
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.status).toBe(401);
			expect(r.code).toBe("buckle.auth_missing");
		});

		test("empty credential → 401 buckle.auth_malformed", () => {
			const h = new Headers({ "x-api-key": "" });
			const r = authorizer().authorize(h);
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.status).toBe(401);
			expect(r.code).toBe("buckle.auth_malformed");
		});

		test("non-bksk_ token → 401 buckle.invalid_key", () => {
			const r = authorizer().authorize(bearer("sk-proj-whatever"));
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.status).toBe(401);
			expect(r.code).toBe("buckle.invalid_key");
		});

		test("revoked key → 401 buckle.key_revoked", () => {
			const ks = new KeyStore(govDb());
			const { keyId, key } = ks.issue({
				name: "t",
				team: null,
				scopes: [STORE_READ_SCOPE],
				rpmLimit: null,
				tpmLimit: null,
				expiresInS: null,
				actor: "test",
			});
			ks.revoke(keyId);
			const r = new PullAuthorizer({ keys: ks, bucket: mkBucket() }).authorize(
				bearer(key),
			);
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.status).toBe(401);
			expect(r.code).toBe("buckle.key_revoked");
		});

		test("expired key → 401 buckle.key_expired", () => {
			const ks = new KeyStore(govDb());
			const key = keyWith(ks, [STORE_READ_SCOPE], -1);
			const r = new PullAuthorizer({ keys: ks, bucket: mkBucket() }).authorize(
				bearer(key),
			);
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.status).toBe(401);
			expect(r.code).toBe("buckle.key_expired");
		});

		test("key without store scope → 403 buckle.store_scope, never bucket-charged", () => {
			const ks = new KeyStore(govDb());
			const key = keyWith(ks, ["buckle:proxy:WRITE_"]);
			const auth = new PullAuthorizer({ keys: ks, bucket: mkBucket() });
			for (let i = 0; i < 5; i++) {
				const r = auth.authorize(bearer(key));
				expect(r.ok).toBe(false);
				if (r.ok) return;
				expect(r.status).toBe(403);
				expect(r.code).toBe("buckle.store_scope");
			}
		});

		test("READ_ key pulls under the burst cap, then 429 carries retryAfterS", () => {
			const ks = new KeyStore(govDb());
			const key = keyWith(ks, [STORE_READ_SCOPE]);
			const auth = new PullAuthorizer({ keys: ks, bucket: mkBucket() });
			const a1 = auth.authorize(bearer(key));
			expect(a1.ok).toBe(true);
			if (!a1.ok) return;
			expect(a1.kind).toBe("api_key");
			expect(auth.authorize(bearer(key)).ok).toBe(true);
			expect(auth.authorize(bearer(key)).ok).toBe(true);
			const a4 = auth.authorize(bearer(key));
			expect(a4.ok).toBe(false);
			if (a4.ok) return;
			expect(a4.status).toBe(429);
			expect(a4.code).toBe("buckle.store_rate_limited");
			expect(a4.retryAfterS).toBe(1);
		});

		test("WRITE_ key pulls too (WRITE_ implies READ_)", () => {
			const ks = new KeyStore(govDb());
			const key = keyWith(ks, [STORE_WRITE_SCOPE]);
			const auth = new PullAuthorizer({ keys: ks, bucket: mkBucket() });
			expect(auth.authorize(bearer(key)).ok).toBe(true);
		});

		test("50-dev fairness: each key drains its own bucket, never a shared one", () => {
			const ks = new KeyStore(govDb());
			const auth = new PullAuthorizer({ keys: ks, bucket: mkBucket() });
			const keys = Array.from({ length: 50 }, () =>
				keyWith(ks, [STORE_READ_SCOPE], null),
			);
			const verdicts = keys.map((k) => auth.authorize(bearer(k)));
			expect(verdicts.every((v) => v.ok)).toBe(true);
		});
	});
});
