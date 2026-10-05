// test/lane-auth.test.ts — the per-lane buckle key surface: belt.env parsing,
// admin-key resolution (env wins over file), and the mint contract (name=sid,
// scope buckle:proxy:WRITE_, bearer admin) against a stubbed fetch.

import { describe, expect, test } from "bun:test";
import {
	adminKey,
	mintLaneKey,
	parseEnvFile,
} from "../scripts/lib/lane-auth.ts";

describe("parseEnvFile", () => {
	test("parses KEY=VALUE lines, ignores comments and blanks", () => {
		const env = parseEnvFile(
			["# comment", "", "A=1", 'B="quoted"', "C=1 # trailing", ""].join("\n"),
		);
		expect(env.A).toBe("1");
		expect(env.B).toBe('"quoted"'); // belt.env is ours — quotes stay literal
		expect(env.C).toBe("1 # trailing");
		expect(Object.keys(env).length).toBe(3);
	});
});

describe("adminKey", () => {
	test("process env wins over belt.env", () => {
		const k = adminKey(
			{ BUCKLE_ADMIN_KEY: "bksk_env" } as NodeJS.ProcessEnv,
			"/nonexistent/belt.env",
		);
		expect(k).toBe("bksk_env");
	});
	test("falls back to belt.env, null when neither", () => {
		expect(adminKey({}, "/nonexistent/belt.env")).toBeNull();
	});
});

describe("mintLaneKey", () => {
	test("posts name=sid + proxy scope with bearer admin", async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		const stub = (async (url: string | URL, init?: RequestInit) => {
			captured = { url: String(url), init: init ?? {} };
			return new Response(
				JSON.stringify({ key: "bksk_minted", key_id: "abc123" }),
				{ status: 201 },
			);
		}) as unknown as typeof fetch;
		const key = await mintLaneKey("autow123", "bksk_admin", stub);
		expect(key).toBe("bksk_minted");
		const c = captured as { url: string; init: RequestInit } | null;
		expect(c?.url).toBe("http://127.0.0.1:4101/v1/admin/keys");
		expect(String(c?.init.headers?.["content-type"])).toBe("application/json");
		const headers = c?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer bksk_admin");
		const body = JSON.parse(String(c?.init.body)) as {
			name: string;
			scopes: string[];
		};
		expect(body.name).toBe("autow123");
		expect(body.scopes).toEqual(["buckle:proxy:WRITE_"]);
	});
	test("returns null on non-201 or missing key shape", async () => {
		const stub = (async () =>
			new Response(JSON.stringify({ error: "no" }), {
				status: 403,
			})) as unknown as typeof fetch;
		expect(await mintLaneKey("autow123", "bksk_admin", stub)).toBeNull();
	});
});
