// test/endpoints.test.ts — W914 registry contract: the versioned front-door
// table is explicit (no wildcards), the no-injection reasons are present,
// admin stays lane:false (the /w/ prefix never widens surface), and
// matchEndpoint/methodsOf behave. Pins REGISTRY_VERSION semantics.
import { describe, expect, test } from "bun:test";
import {
	matchEndpoint,
	methodsOf,
	REGISTRY_VERSION,
	registryDocument,
} from "../src/endpoints.ts";

describe("endpoint registry contract (W914)", () => {
	test("version is 1", () => {
		expect(REGISTRY_VERSION).toBe(1);
	});

	test("every injection:none entry carries a why", () => {
		const doc = registryDocument().endpoints;
		for (const row of doc) {
			if (row.injection === "none") {
				expect(typeof row.why).toBe("string");
				expect((row.why ?? "").length).toBeGreaterThan(4);
			}
		}
	});

	test("admin lane:false — /w/ never widens surface", () => {
		const doc = registryDocument().endpoints;
		for (const row of doc) {
			if (row.kind === "admin") expect(row.lane).toBe(false);
			if (row.lane) expect(row.path.startsWith("/v1/")).toBe(true);
		}
	});

	test("semantic injection only on chat-shaped ingress", () => {
		const doc = registryDocument().endpoints;
		for (const row of doc) {
			if (row.injection === "semantic") {
				expect([
					"/v1/messages",
					"/v1/chat/completions",
					"/v1/responses",
				]).toContain(row.path);
			}
		}
	});
});

describe("endpoint registry matching (W914)", () => {
	test("matchEndpoint: exact + parametric + miss", () => {
		expect(matchEndpoint("POST", "/v1/chat/completions")?.path).toBe(
			"/v1/chat/completions",
		);
		expect(matchEndpoint("GET", "/v1/files/file-abc/content")?.path).toBe(
			"/v1/files/{id}/content",
		);
		expect(matchEndpoint("GET", "/v1/files/file-abc")?.path).toBe(
			"/v1/files/{id}",
		);
		expect(matchEndpoint("GET", "/v1/batches/bat_1")).not.toBeNull();
		expect(matchEndpoint("GET", "/v1/batches/bat_1/extra")).toBeNull();
		expect(matchEndpoint("GET", "/v1/chat/completions")).toBeNull();
		expect(matchEndpoint("POST", "/v1/nope")).toBeNull();
	});

	test("methodsOf: per-path method sets", () => {
		expect(methodsOf("/v1/files")).toEqual(["POST", "GET"]);
		expect(methodsOf("/v1/batches/bat_9")).toEqual(["GET"]);
	});

	test("registryDocument: all served — no pending rows at this head", () => {
		const doc = registryDocument();
		expect(doc.registry_version).toBe(1);
		const responses = doc.endpoints.find((r) => r.path === "/v1/responses");
		expect(responses?.status).toBe("served");
		for (const row of doc.endpoints) expect(row.status).toBe("served");
	});

	test("agents: per-agent wire compatibility (W918)", () => {
		const agents = registryDocument().agents;
		expect(agents.map((a) => a.agent)).toEqual(["claude", "codex", "copilot"]);
		const claude = agents.find((a) => a.agent === "claude");
		expect(claude?.wire).toBe("anthropic");
		expect(claude?.status).toBe("full");
		const codex = agents.find((a) => a.agent === "codex");
		expect(codex?.status).toBe("full");
		expect(codex?.note).toBeUndefined();
		const copilot = agents.find((a) => a.agent === "copilot");
		expect(copilot?.wire).toBe("openai");
		expect(copilot?.status).toBe("full");
	});
});
