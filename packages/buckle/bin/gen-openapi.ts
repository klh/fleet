#!/usr/bin/env bun
// bin/gen-openapi.ts — W1303.4: emit the buckle OpenAPI document from the
// wire schemas (src/wire-schemas.ts — zod is THE definition; this tool
// renders it, never the reverse). Generated file: docs/openapi.json.
//   gen-openapi                 write docs/openapi.json
//   gen-openapi --check         verify the committed file matches the
//                               schemas (push-gate mode: exit 1 + diff on
//                               drift, exit 0 when current)
//   gen-openapi --stdout        print the document, write nothing
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import * as W from "../src/wire-schemas.ts";

const OUT = join(import.meta.dir, "..", "docs", "openapi.json");

const jsonOf = (s: z.ZodType): unknown =>
	z.toJSONSchema(s, { target: "openapi-3.0" });

const jsonBody = (s: z.ZodType): Record<string, unknown> => ({
	required: true,
	content: { "application/json": { schema: jsonOf(s) } },
});
const jsonResponse = (s: z.ZodType, desc: string): Record<string, unknown> => ({
	description: desc,
	content: { "application/json": { schema: jsonOf(s) } },
});
const problemResponse = (codes: string[]): Record<string, unknown> => ({
	description: `problem+json — ${codes.join(", ")}`,
	content: {
		"application/problem+json": { schema: jsonOf(W.ProblemSchema) },
	},
});

/** The OpenAPI 3.0 document, composed from the wire schemas. */
export function openApiDoc(): Record<string, unknown> {
	return {
		openapi: "3.0.3",
		info: {
			title: "buckle",
			version: "2.0.0",
			description:
				"LLM router plane: dual-dialect proxy (/v1/messages, /v1/chat/completions, /v1/responses) plus the /v1/admin governance API. Generated from src/wire-schemas.ts by bin/gen-openapi.ts — never hand-edited.",
		},
		paths: {
			"/v1/messages": {
				post: {
					summary: "Anthropic Messages (proxy)",
					requestBody: jsonBody(W.MessagesBodySchema),
					responses: {
						"200": {
							description: "proxied upstream response (SSE when stream)",
						},
						"400": problemResponse(["buckle.bad_body", "missing model"]),
						"401": problemResponse(["buckle.unauthorized"]),
					},
				},
			},
			"/v1/messages/count_tokens": {
				post: {
					summary: "Anthropic count_tokens (proxy)",
					requestBody: jsonBody(W.CountTokensBodySchema),
					responses: {
						"200": { description: "proxied upstream response" },
						"400": problemResponse(["buckle.bad_body", "missing model"]),
						"401": problemResponse(["buckle.unauthorized"]),
					},
				},
			},
			"/v1/chat/completions": {
				post: {
					summary: "OpenAI Chat Completions (proxy)",
					requestBody: jsonBody(W.ChatCompletionsBodySchema),
					responses: {
						"200": {
							description: "proxied upstream response (SSE when stream)",
						},
						"400": problemResponse(["buckle.bad_body", "missing model"]),
						"401": problemResponse(["buckle.unauthorized"]),
					},
				},
			},
			"/v1/responses": {
				post: {
					summary: "OpenAI Responses (proxy, path forwarded verbatim)",
					requestBody: jsonBody(W.ResponsesBodySchema),
					responses: {
						"200": { description: "proxied upstream response" },
						"400": problemResponse(["buckle.bad_body", "missing model"]),
						"401": problemResponse(["buckle.unauthorized"]),
					},
				},
			},
			"/v1/models": {
				get: {
					summary: "Served model groups",
					responses: {
						"200": jsonResponse(W.ModelListResponseSchema, "model list"),
					},
				},
			},
			"/v1/admin/keys": {
				post: {
					summary: "Issue a key (raw material returned exactly once)",
					requestBody: jsonBody(W.IssueKeyRequestSchema),
					responses: {
						"201": jsonResponse(W.IssueKeyResponseSchema, "issued"),
						"400": problemResponse(["buckle.bad_body", "buckle.bad_scopes"]),
					},
				},
				get: {
					summary: "List keys (never key_hash)",
					responses: {
						"200": jsonResponse(W.KeyListResponseSchema, "key rows"),
					},
				},
			},
			"/v1/admin/keys/verify": {
				post: {
					summary: "Verify a key (no hash echo)",
					requestBody: jsonBody(W.VerifyKeyRequestSchema),
					responses: {
						"200": jsonResponse(
							W.VerifyKeyResponseSchema,
							"valid + identity, or valid:false + code",
						),
					},
				},
			},
			"/v1/admin/keys/{key_id}/revoke": {
				post: {
					summary: "Revoke a key",
					parameters: [
						{
							name: "key_id",
							in: "path",
							required: true,
							schema: { type: "string", pattern: "^[0-9a-f]{12}$" },
						},
					],
					responses: {
						"200": jsonResponse(W.RevokeKeyResponseSchema, "revoked"),
						"404": problemResponse(["buckle.no_route"]),
					},
				},
			},
			"/v1/admin/teams": {
				post: {
					summary: "Upsert a team (budget ceilings)",
					requestBody: jsonBody(W.TeamUpsertRequestSchema),
					responses: {
						"200": jsonResponse(W.TeamUpsertResponseSchema, "echoed ceilings"),
					},
				},
				get: {
					summary: "List teams",
					responses: {
						"200": { description: "team rows" },
					},
				},
			},
			"/v1/admin/drain": {
				post: {
					summary: "Arm the deployment drain (first intent wins)",
					requestBody: jsonBody(W.DrainRequestSchema),
					responses: {
						"200": jsonResponse(W.DrainResponseSchema, "draining"),
						"409": problemResponse(["buckle.already_draining"]),
					},
				},
			},
		},
	};
}

const render = (): string => `${JSON.stringify(openApiDoc(), null, "\t")}\n`;

if (import.meta.main) {
	const CHECK = process.argv.includes("--check");
	const STDOUT = process.argv.includes("--stdout");

	if (STDOUT) {
		process.stdout.write(render());
	} else if (CHECK) {
		const current = readFileSync(OUT, "utf8");
		const fresh = render();
		if (current === fresh) {
			console.log("gen-openapi: docs/openapi.json current");
		} else {
			console.error(
				"gen-openapi: docs/openapi.json is STALE — regenerate with `bun bin/gen-openapi.ts` and commit",
			);
			process.exit(1);
		}
	} else {
		mkdirSync(dirname(OUT), { recursive: true });
		writeFileSync(OUT, render());
		console.log(`gen-openapi: wrote ${OUT}`);
	}
}
