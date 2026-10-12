// test/keyid.test.ts — presented credential → hashed ledger key id, and the
// header extraction (Authorization Bearer first, then Anthropic x-api-key).
import { expect, test } from "bun:test";
import { keyIdFromToken, tokenFromHeaders } from "../src/ledger.ts";

test("keyIdFromToken: credential → stable truncated sha-256, never the token", () => {
	const id1 = keyIdFromToken("sekrit-token");
	expect(keyIdFromToken("sekrit-token")).toBe(id1);
	expect(id1).toHaveLength(12);
	expect(id1).not.toContain("sekrit");
});

test("keyIdFromToken: nothing presented → empty key id", () => {
	expect(keyIdFromToken(null)).toBe("");
	expect(keyIdFromToken("")).toBe("");
});

test("tokenFromHeaders: Bearer wins over x-api-key", () => {
	const h = new Headers({
		authorization: "Bearer bearer-token",
		"x-api-key": "anthropic-token",
	});
	expect(tokenFromHeaders(h)).toBe("bearer-token");
});

test("tokenFromHeaders: x-api-key alone (Anthropic wire) → the api key", () => {
	const h = new Headers({ "x-api-key": "anthropic-token" });
	expect(tokenFromHeaders(h)).toBe("anthropic-token");
});

test("tokenFromHeaders: neither header → null", () => {
	expect(tokenFromHeaders(new Headers())).toBeNull();
	expect(
		tokenFromHeaders(new Headers({ authorization: "Basic abc" })),
	).toBeNull();
});

test("tokenFromHeaders: empty credentials — Bearer-only → null, x-api-key → malformed-empty", () => {
	// "Bearer " with no token never matched the Bearer regex (pre-existing
	// semantics): auth_missing, not auth_malformed
	expect(
		tokenFromHeaders(new Headers({ authorization: "Bearer " })),
	).toBeNull();
	// x-api-key present but empty → "" → authDispatch's malformed branch
	expect(tokenFromHeaders(new Headers({ "x-api-key": "" }))).toBe("");
});
