import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANTHROPIC } from "../src/adapters/anthropic.ts";
import { OPENAI_COMPAT } from "../src/adapters/openai-compat.ts";
import {
	preferCopilotHub,
	type UpstreamConfig,
} from "../src/copilot-hub-routes.ts";
import type { Deployment } from "../src/upstreams.ts";

const template = JSON.parse(
	readFileSync(join(import.meta.dir, "../upstreams.copilot.json"), "utf8"),
) as UpstreamConfig;
const hubUrl = "http://127.0.0.1:4201";

describe("Copilot Docker hub routing", () => {
	test("all 26 configured model groups enter the IKEA hub first", () => {
		const names = Object.keys(template.groups);
		expect(names).toHaveLength(26);
		const local: UpstreamConfig = {
			version: 1,
			groups: Object.fromEntries(
				names.map((name) => [
					name,
					[
						{ url: "https://api.githubcopilot.com", model: name },
						{ url: "http://127.0.0.1:4100", model: "glm-5.3-flash" },
					],
				]),
			),
		};
		const first = preferCopilotHub(local, template.groups, hubUrl);
		for (const name of names) {
			const routes = first.config.groups[name] ?? [];
			expect(
				routes
					.filter((route) => route.url === hubUrl)
					.every((route) => route.buckle === true),
			).toBe(true);
			expect(routes[0]).toEqual({
				url: hubUrl,
				buckle: true,
				dialect: name.startsWith("claude-") ? "anthropic" : "openai",
				adapter: name.startsWith("claude-") ? "anthropic" : "openai-compat",
				model: name,
				api_key_env: "IKEA_HUB_KEY",
			});
			expect(routes[1]?.url).toBe("http://127.0.0.1:4100");
			expect(routes.some((route) => route.url.includes("githubcopilot"))).toBe(
				false,
			);
		}
		expect(preferCopilotHub(first.config, template.groups, hubUrl)).toEqual(
			first,
		);
	});

	test("a missing local group aborts before changing any route", () => {
		const local: UpstreamConfig = { groups: { "claude-sonnet-5": [] } };
		expect(() => preferCopilotHub(local, template.groups, hubUrl)).toThrow(
			"Mac upstream groups missing",
		);
		expect(local.groups["claude-sonnet-5"]).toEqual([]);
	});
});

const NATIVE_BETAS = [
	"context-management-2025-06-27",
	"per-turn-control-2026-07-01",
];
const COPILOT = "https://api.githubcopilot.com";

/** One template row as buckle loads it (group stamped on the row). */
function templateRow(group: string): Deployment {
	const row = template.groups[group]?.[0];
	if (!row) throw new Error(`template group missing: ${group}`);
	return { ...row, group } as unknown as Deployment;
}

function request(group: string, path: string, body: Record<string, unknown>) {
	const dialect = path === "/v1/messages" ? "anthropic" : "openai";
	return { group, dialect, path, body, key: "" } as const;
}

describe("Copilot template wire contracts (W1474)", () => {
	test("every claude-* row carries both native Claude betas", () => {
		const claude = Object.keys(template.groups).filter((group) =>
			group.startsWith("claude-"),
		);
		expect(claude).toHaveLength(7);
		for (const group of claude) {
			const headers = templateRow(group).adapter_config?.headers as Record<
				string,
				string
			>;
			expect(headers["copilot-integration-id"]).toBe("vscode-chat");
			expect(headers["anthropic-beta"]?.split(",")).toEqual(
				expect.arrayContaining(NATIVE_BETAS),
			);
		}
	});

	test("native Claude bodies and operator betas reach the seat verbatim", async () => {
		const base = templateRow("claude-opus-5-5");
		const headers = {
			...(base.adapter_config?.headers as Record<string, string>),
		};
		headers["anthropic-beta"] =
			`interleaved-thinking-2025-05-14,${headers["anthropic-beta"]}`;
		const dep = {
			...base,
			adapter_config: { ...base.adapter_config, headers },
		};
		const body = {
			model: "claude-opus-5-5",
			max_tokens: 16,
			context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
			messages: [
				{ role: "user", content: "hi" },
				{ role: "user", content: "go", output_config: { effort: "low" } },
			],
		};
		const req = request(dep.group, "/v1/messages", body);
		const wire = await ANTHROPIC.buildCall(dep, req, body);
		expect(wire.url).toBe(`${COPILOT}/v1/messages`);
		expect(wire.headers["anthropic-beta"]).toBe(
			`interleaved-thinking-2025-05-14,${NATIVE_BETAS.join(",")}`,
		);
		expect(JSON.parse(wire.body)).toEqual({
			...body,
			model: "claude-opus-5.5",
		});
	});

	test("Responses-only frontier rows ride /v1/responses verbatim; chat stays chat", async () => {
		for (const group of ["gpt-6.1-sol", "grok-4.7"]) {
			const body = { model: group, input: "hi", reasoning: { effort: "low" } };
			const req = request(group, "/v1/responses", body);
			const wire = await OPENAI_COMPAT.buildCall(templateRow(group), req, body);
			expect(wire.url).toBe(`${COPILOT}/v1/responses`);
			expect(JSON.parse(wire.body)).toEqual(body);
		}
		const chatBody = { model: "gemini-4-argon", messages: [] };
		const chatReq = request("gemini-4-argon", "/v1/chat/completions", chatBody);
		const argon = templateRow("gemini-4-argon");
		const chat = await OPENAI_COMPAT.buildCall(argon, chatReq, chatBody);
		expect(chat.url).toBe(`${COPILOT}/chat/completions`);
		// a URL-only chat→responses rewrite would ship chat bodies to /v1/responses
		const rewriteTargets = Object.values(template.groups).flatMap((rows) =>
			rows.flatMap((row) =>
				Object.values(
					(row.adapter_config as { path_rewrite?: Record<string, string> })
						?.path_rewrite ?? {},
				),
			),
		);
		expect(rewriteTargets).not.toContain("/v1/responses");
	});
});
