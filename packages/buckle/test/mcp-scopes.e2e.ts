// test/mcp-scopes.e2e.ts — W2791: the MCP method-level scope family —
// parse near-misses, storage round-trip through the ONE engine, mint →
// verify → scope-check per method class, the implication lattice, the
// root bypass, and the keyed 403 shape. No live face rides this yet; the
// grammar cannot rot before first use.

import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { hashKey, KeyStore } from "../src/gov/keys.ts";
import {
	hasMcpScope,
	mcpAuthorize,
	mcpInsufficient,
	mcpMethodClass,
	mcpScopeImplies,
	mcpScopeNeeded,
	parseMcpScope,
} from "../src/gov/mcp-scopes.ts";
import { applyGovernanceSchema } from "../src/gov/schema.ts";
import {
	parseScope,
	scopesFromStorage,
	scopesToStorage,
} from "../src/gov/scopes.ts";

test.describe("@unit mcp scopes (W2791)", () => {
	test("parse: well-formed per method class + near-miss family fails loud", () => {
		expect(parseMcpScope("buckle:mcp:knowledge:LIST_")).toEqual({
			server: "knowledge",
			methodClass: "LIST_",
			toolGlob: null,
		});
		expect(parseMcpScope("buckle:mcp:knowledge:CALL_")).toMatchObject({
			methodClass: "CALL_",
			toolGlob: null,
		});
		expect(parseMcpScope("buckle:mcp:knowledge:CALL_:search_*")).toMatchObject({
			methodClass: "CALL_",
			toolGlob: "search_*",
		});
		expect(parseMcpScope("buckle:mcp:knowledge:READ_")).toMatchObject({
			methodClass: "READ_",
		});
		// near-misses: 3-segment mcp READ_ (no server), bare server, glob on
		// LIST_, 4th segment, bad server chars, empty glob, non-mcp prefix
		expect(parseMcpScope("buckle:mcp:READ_")).toBeNull();
		expect(parseMcpScope("buckle:mcp:knowledge")).toBeNull();
		expect(parseMcpScope("buckle:mcp:knowledge:LIST_:*")).toBeNull();
		expect(parseMcpScope("buckle:mcp:knowledge:CALL_:a:b")).toBeNull();
		expect(parseMcpScope("buckle:mcp:know_Ledge:CALL_")).toBeNull();
		expect(parseMcpScope("buckle:mcp:knowledge:CALL_:")).toBeNull();
		expect(parseMcpScope("buckle:proxy:READ_")).toBeNull();
	});

	test("method map: tools/* and resources/* resolve; unknown is null", () => {
		expect(mcpMethodClass("tools/list")).toEqual({
			methodClass: "LIST_",
			namesTool: false,
		});
		expect(mcpMethodClass("tools/call")).toEqual({
			methodClass: "CALL_",
			namesTool: true,
		});
		expect(mcpMethodClass("resources/read")).toMatchObject({
			methodClass: "READ_",
		});
		expect(mcpMethodClass("prompts/get")).toBeNull();
	});

	test("mcpScopeNeeded: tool-pinned need for tools/call, server-wide else", () => {
		expect(mcpScopeNeeded("knowledge", "tools/list")).toBe(
			"buckle:mcp:knowledge:LIST_",
		);
		expect(mcpScopeNeeded("knowledge", "tools/call")).toBe(
			"buckle:mcp:knowledge:CALL_",
		);
		expect(mcpScopeNeeded("knowledge", "tools/call", "search_cards")).toBe(
			"buckle:mcp:knowledge:CALL_:search_cards",
		);
		expect(mcpScopeNeeded("knowledge", "resources/read")).toBe(
			"buckle:mcp:knowledge:READ_",
		);
		expect(mcpScopeNeeded("knowledge", "prompts/get")).toBeNull();
	});

	test("lattice: CALL_ ⊃ LIST_, server-wide ⊃ glob, glob never widens", () => {
		const implies = mcpScopeImplies;
		expect(
			implies("buckle:mcp:knowledge:CALL_", "buckle:mcp:knowledge:LIST_"),
		).toBe(true);
		expect(
			implies(
				"buckle:mcp:knowledge:CALL_",
				"buckle:mcp:knowledge:CALL_:search_*",
			),
		).toBe(true);
		expect(
			implies(
				"buckle:mcp:knowledge:CALL_:search_*",
				"buckle:mcp:knowledge:CALL_",
			),
		).toBe(false);
		expect(
			implies("buckle:mcp:knowledge:LIST_", "buckle:mcp:knowledge:CALL_"),
		).toBe(false);
		expect(
			implies("buckle:mcp:knowledge:LIST_", "buckle:mcp:knowledge:READ_"),
		).toBe(false);
		// cross-server never
		expect(implies("buckle:mcp:knowledge:CALL_", "buckle:mcp:belt:LIST_")).toBe(
			false,
		);
		// glob-over-glob: holder glob must span the need's tool name
		expect(
			implies(
				"buckle:mcp:knowledge:CALL_:search_*",
				"buckle:mcp:knowledge:CALL_:search_cards",
			),
		).toBe(true);
		expect(
			implies(
				"buckle:mcp:knowledge:CALL_:search_cards",
				"buckle:mcp:knowledge:CALL_:search_*",
			),
		).toBe(false);
		// legacy family never implies into mcp, either direction
		expect(implies("buckle:proxy:WRITE_", "buckle:mcp:knowledge:LIST_")).toBe(
			false,
		);
		// ...and an mcp scope never grants legacy proxy/admin access
		expect(implies("buckle:mcp:knowledge:CALL_", "buckle:proxy:READ_")).toBe(
			false,
		);
	});

	test("hasMcpScope: holder set with legacy scopes mixed in", () => {
		const scopes = [
			"buckle:proxy:READ_",
			"buckle:mcp:knowledge:CALL_:search_*",
		];
		expect(hasMcpScope(scopes, "buckle:mcp:knowledge:CALL_:search_cards")).toBe(
			true,
		);
		expect(hasMcpScope(scopes, "buckle:mcp:knowledge:CALL_")).toBe(false);
		// glob'd CALL_ still implies LIST_ (discover), never server-wide CALL_
		expect(hasMcpScope(scopes, "buckle:mcp:knowledge:LIST_")).toBe(true);
	});

	test("storage round-trip through the ONE engine (parseScope/scopeImplies)", () => {
		const mixed = [
			"buckle:proxy:READ_",
			"buckle:mcp:knowledge:CALL_:search_*",
			"buckle:mcp:belt:LIST_",
		];
		const stored = scopesToStorage(mixed);
		expect(stored).toContain("buckle:mcp:knowledge:CALL_:search_*");
		const back = scopesFromStorage(stored);
		expect(back.dropped).toEqual([]);
		expect(back.scopes).toContain("buckle:mcp:belt:LIST_");
		// delegation: the legacy engine implies through the mcp lattice
		expect(
			parseScope("buckle:mcp:knowledge:CALL_:search_*") ===
				"buckle:mcp:knowledge:CALL_:search_*",
		).toBe(true);
	});

	test("mint → verify → authorize per method class (KeyStore round-trip)", () => {
		const db = new Database(":memory:", { create: true });
		applyGovernanceSchema(db);
		const ks = new KeyStore(db);
		for (const scope of [
			"buckle:mcp:knowledge:LIST_",
			"buckle:mcp:knowledge:CALL_",
			"buckle:mcp:knowledge:CALL_:search_*",
			"buckle:mcp:knowledge:READ_",
		]) {
			const { key, keyId } = ks.issue({
				name: `mcp-${scope.split(":").slice(-2).join("-")}`,
				team: null,
				scopes: [scope],
				rpmLimit: null,
				tpmLimit: null,
				expiresInS: null,
				actor: "W2791",
			});
			expect(key.startsWith("bksk_")).toBe(true);
			expect(keyId).toBe(hashKey(key).slice(0, 12));
			const v = ks.verify(key);
			expect(v.ok).toBe(true);
			if (!v.ok) continue;
			expect(v.key.scopes).toBe(scopesToStorage([scope]));
			// a LIST_-only key discovers but cannot invoke; CALL_ both; a
			// glob key invokes only inside its glob; READ_ neither
			const holder = [scope];
			expect(
				mcpAuthorize(
					{ kind: "api_key", scopes: holder },
					"buckle:mcp:knowledge:LIST_",
				),
			).toBe(scope !== "buckle:mcp:knowledge:READ_");
			expect(
				mcpAuthorize(
					{ kind: "api_key", scopes: holder },
					"buckle:mcp:knowledge:CALL_:search_cards",
				),
			).toBe(
				scope === "buckle:mcp:knowledge:CALL_" ||
					scope === "buckle:mcp:knowledge:CALL_:search_*",
			);
			expect(
				mcpAuthorize(
					{ kind: "api_key", scopes: holder },
					"buckle:mcp:knowledge:CALL_:belt_infer",
				),
			).toBe(scope === "buckle:mcp:knowledge:CALL_");
		}
	});

	test("root bypass: sovereign over the open-ended family", () => {
		expect(
			mcpAuthorize({ kind: "root", scopes: [] }, "buckle:mcp:anything:CALL_"),
		).toBe(true);
	});

	test("the 403 shape: keyed code + needed scope in why", () => {
		const denial = mcpInsufficient("buckle:mcp:knowledge:CALL_:search_cards");
		expect(denial).toEqual({
			status: 403,
			code: "buckle.insufficient_scope",
			why: "requires buckle:mcp:knowledge:CALL_:search_cards",
		});
	});
});
