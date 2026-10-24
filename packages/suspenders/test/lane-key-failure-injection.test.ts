// test/lane-key-failure-injection.test.ts — W746 failure injection at the
// lane-key seams (hooks/lib/lane-auth.ts). Two failure classes the
// 2026-10-14 review named, each at the REAL seam with the front's fetch
// injected:
// (1) belt partition mid-dispatch — the front answers the probe, then the
//     mint/revoke fetch never answers: the key paths must bound the wait
//     (timeout/throw → null/false) so dispatch degrades to the covered
//     fail-closed refuse instead of hanging with a half-launched claim;
// (2) key rotation racing a session reuse — the reused key was revoked
//     after the 0600 meta was read: the reuse path must confirm liveness
//     at the front (the W607 whoami self-verify echo) and never re-hand
//     a dead key.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	enrollSessionKey,
	mintLaneKey,
	revokeLaneKey,
	writeSessionEnrollmentFiles,
} from "../hooks/lib/lane-auth.ts";

/** A hung front socket: never answers on its own, but honours the abort
 *  signal exactly like real fetch (abort → rejection). */
const never: typeof fetch = (_url, init) =>
	new Promise<Response>((_ok, err) => {
		const signal = init?.signal;
		if (signal) signal.addEventListener("abort", () => err(signal.reason));
	});
const withTimeoutPin = async <T>(fn: () => Promise<T>): Promise<T> => {
	process.env.SUSPENDERS_LANE_KEY_TIMEOUT_MS = "150";
	try {
		return await fn();
	} finally {
		delete process.env.SUSPENDERS_LANE_KEY_TIMEOUT_MS;
	}
};

describe("W746 belt partition: hung front fetches degrade fail-closed", () => {
	test("hung mint → null within the key-fetch timeout", async () => {
		const t0 = Date.now();
		const out = await withTimeoutPin(() =>
			mintLaneKey("w746-partition", "bksk_admin", never),
		);
		expect(out).toBeNull();
		expect(Date.now() - t0).toBeLessThan(3_000);
	});

	test("hung revoke → false within the key-fetch timeout", async () => {
		const out = await withTimeoutPin(() =>
			revokeLaneKey("deadbeef123", "bksk_admin", never),
		);
		expect(out).toBe(false);
	});
});

/** The rotated front: whoami is the W607 key-liveness seam (200 = live,
 *  401 = revoked/unknown); /v1/admin/keys mints the rotated key. */
const rotatedFront =
	(live: string[], calls: string[]): typeof fetch =>
	(url, init) => {
		calls.push(new URL(url).pathname);
		const h = (init?.headers ?? {}) as Record<string, string>;
		const token = String(h.authorization ?? "").replace("Bearer ", "");
		const path = new URL(url).pathname;
		if (path === "/v1/fleet/whoami")
			return Promise.resolve(
				new Response(JSON.stringify({ authenticated: live.includes(token) }), {
					status: live.includes(token) ? 200 : 401,
				}),
			);
		if (path === "/v1/admin/keys")
			return Promise.resolve(
				Response.json({ key: "bksk_fresh_111", key_id: "fresh0000111" }),
			);
		return Promise.resolve(new Response("no", { status: 404 }));
	};

const SEED_SID = "w746-rotate";
const seedEnrollment = (fleet: string, sid: string): void => {
	writeSessionEnrollmentFiles(
		fleet,
		sid,
		{ key: "bksk_stale_revoked", keyId: "stale0000dead" },
		"http://127.0.0.1:4101",
	);
};

describe("W746 rotation race: reuse never re-hands a revoked key", () => {
	const HOME = mkdtempSync(join(tmpdir(), "w746-rotate-"));
	afterAll(() => rmSync(HOME, { recursive: true, force: true }));
	const fleet = join(HOME, "fleet");

	test("revoked reuse → fresh mint at the front, never the dead key", async () => {
		const sid = `${SEED_SID}-a`;
		seedEnrollment(fleet, sid);
		const calls: string[] = [];
		const out = await enrollSessionKey({
			fleet,
			sid,
			front: "http://127.0.0.1:4101",
			frontUp: true,
			govMode: "strict",
			admin: "bksk_admin",
			fetchFn: rotatedFront(["bksk_fresh_111"], calls),
		});
		expect(out.mode).toBe("enrolled");
		if (out.mode === "enrolled") expect(out.key).toBe("bksk_fresh_111");
		expect(calls).toContain("/v1/admin/keys");
	});

	test("liveness probe error degrades to a fresh mint — enrollment never fails on a flap", async () => {
		const sid = `${SEED_SID}-b`;
		seedEnrollment(fleet, sid);
		// the whoami probe itself dies mid-flight; the mint still answers
		const flap = ((url: string | URL | Request) => {
			const path = new URL(String(url)).pathname;
			if (path === "/v1/fleet/whoami")
				return Promise.reject(new Error("ECONNRESET"));
			return Promise.resolve(
				Response.json({ key: "bksk_fresh_111", key_id: "fresh0000111" }),
			);
		}) as unknown as typeof fetch;
		const out = await enrollSessionKey({
			fleet,
			sid,
			front: "http://127.0.0.1:4101",
			frontUp: true,
			govMode: "strict",
			admin: "bksk_admin",
			fetchFn: flap,
		});
		expect(out.mode).toBe("enrolled");
		if (out.mode === "enrolled") expect(out.key).toBe("bksk_fresh_111");
	});
});
