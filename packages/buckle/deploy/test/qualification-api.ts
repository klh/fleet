import { expect } from "@playwright/test";
import { z } from "zod";
import { FIXTURE_CAPABILITIES } from "./fixture.ts";
import { readHttp } from "./qualification-http.ts";

const KeySchema = z.object({
	key_id: z.string().regex(/^[a-f0-9]{12}$/),
	key: z.string().min(1),
	scopes: z.array(z.string()),
	expires_at: z.number().int().positive(),
});
const CatalogSchema = z.object({
	object: z.literal("list"),
	data: z.array(
		z
			.object({
				id: z.string(),
				object: z.literal("model"),
				owned_by: z.literal("buckle"),
				context_length: z.number().int().positive(),
				max_output_tokens: z.number().int().positive(),
				reasoning: z.boolean(),
				capability_source: z.literal("operator-pinned"),
				admission: z.unknown().optional(),
			})
			.strict(),
	),
});
const IdentitySchema = z.object({
	key_id: z.string(),
	scopes: z.array(z.string()),
});
const VerificationSchema = z.object({
	valid: z.boolean(),
	key_id: z.string().optional(),
});
const KeysSchema = z.object({
	keys: z.array(
		z.object({
			key_id: z.string(),
			expires_at: z.number().nullable(),
			revoked_at: z.number().nullable(),
		}),
	),
});
export const CONTROL_SCOPES = ["buckle:runner:WRITE_", "buckle:proxy:READ_"];

export async function qualifyApi(
	origin: string,
	rootKey: string,
	inferenceCount: () => number,
	observe: (fact: {
		method: string;
		path: string;
		status: number;
	}) => void = () => {},
) {
	async function request(
		path: string,
		key: string | null,
		status: number,
		body?: unknown,
	) {
		const response = await readHttp(`${origin}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(key ? { authorization: `Bearer ${key}` } : {}),
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		observe({
			method: body === undefined ? "GET" : "POST",
			path: path.replace(/\/[a-f0-9]{12}\/revoke$/, "/:keyId/revoke"),
			status: response.status,
		});
		expect(response.status, `Unexpected status for ${path}`).toBe(status);
		return response;
	}
	const chat = {
		model: "seed-model",
		stream: true,
		messages: [{ role: "user", content: "synthetic fixture" }],
	};
	await request("/v1/models", null, 401);
	const issuedAt = Date.now();
	const control = KeySchema.parse(
		JSON.parse(
			(
				await request("/v1/admin/keys", rootKey, 201, {
					name: "qualification-control",
					scopes: CONTROL_SCOPES,
					expires_in_s: 60,
				})
			).text,
		),
	);
	expect([...control.scopes].sort()).toEqual([...CONTROL_SCOPES].sort());
	expect(control.expires_at).toBeGreaterThan(issuedAt);
	expect(control.expires_at).toBeLessThanOrEqual(Date.now() + 60000);
	const identity = IdentitySchema.parse(
		JSON.parse((await request("/v1/fleet/whoami", control.key, 200)).text),
	);
	expect(identity.key_id).toBe(control.key_id);
	expect([...identity.scopes].sort()).toEqual([...CONTROL_SCOPES].sort());
	const before = inferenceCount();
	await request("/v1/admin/keys", control.key, 403);
	await request("/v1/chat/completions", control.key, 403, chat);
	expect(inferenceCount()).toBe(before);
	const catalog = CatalogSchema.parse(
		JSON.parse((await request("/v1/models", control.key, 200)).text),
	);
	expect(catalog.data).toEqual([
		{
			id: "seed-model",
			object: "model",
			owned_by: "buckle",
			...FIXTURE_CAPABILITIES,
		},
	]);
	const listed = KeysSchema.parse(
		JSON.parse((await request("/v1/admin/keys", rootKey, 200)).text),
	);
	expect(
		listed.keys.find((key) => key.key_id === control.key_id)?.expires_at,
	).toBe(control.expires_at);
	const verified = VerificationSchema.parse(
		JSON.parse(
			(
				await request("/v1/admin/keys/verify", rootKey, 200, {
					key: control.key,
				})
			).text,
		),
	);
	expect(verified).toEqual({ valid: true, key_id: control.key_id });
	const inference = KeySchema.parse(
		JSON.parse(
			(
				await request("/v1/admin/keys", rootKey, 201, {
					name: "qualification-inference",
					scopes: ["buckle:proxy:WRITE_"],
					expires_in_s: 60,
				})
			).text,
		),
	);
	const stream = await request(
		"/v1/chat/completions",
		inference.key,
		200,
		chat,
	);
	expect(stream.headers.get("content-type")).toContain("text/event-stream");
	expect(stream.reads).toBeGreaterThan(1);
	expect(stream.text.trim().endsWith("data: [DONE]")).toBe(true);
	expect(stream.text).toContain('"total_tokens":5');
	expect(inferenceCount()).toBe(before + 1);
	for (const key of [control, inference]) {
		await request(`/v1/admin/keys/${key.key_id}/revoke`, rootKey, 200, {});
		expect(
			VerificationSchema.parse(
				JSON.parse(
					(
						await request("/v1/admin/keys/verify", rootKey, 200, {
							key: key.key,
						})
					).text,
				),
			).valid,
		).toBe(false);
		await request("/v1/fleet/whoami", key.key, 401);
	}
	const after = KeysSchema.parse(
		JSON.parse((await request("/v1/admin/keys", rootKey, 200)).text),
	);
	for (const key of [control, inference])
		expect(
			after.keys.find((row) => row.key_id === key.key_id)?.revoked_at,
		).toBeGreaterThan(0);
	return {
		catalog: catalog.data,
		controlScopes: control.scopes,
		finiteTtlSeconds: 60,
		identityStatus: 200,
		controlChatStatus: 403,
		controlInferenceDelta: 0,
		streamReads: stream.reads,
		terminalUsage: true,
		revokedKeys: 2,
	};
}
