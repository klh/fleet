// src/wire-schemas.ts — W1303.4 schema-first wire contracts: zod schemas
// are THE definition of every buckle API data shape; types are derived
// (z.infer), never hand-written. Additive over the handlers — the route
// code keeps its enforcement; these schemas document and type the wire so
// gen-openapi emits the OpenAPI face from one source of truth. Bodies are
// deliberately LOOSE beyond the enforced fields: the gate is a pass-through
// proxy (unknown provider fields ride verbatim), so only what handlers.ts
// actually enforces (model) or reads (messages/stream) is pinned.
import { z } from "zod";

// ─── proxy ingress bodies (both dialects, four paths) ─────────────────────

/** One chat message — role is the only field the wire contract names;
 *  content shape varies per dialect/provider and rides loose. */
export const WireMessageSchema = z.looseObject({
	role: z.string(),
});
export type WireMessage = z.infer<typeof WireMessageSchema>;

/** The enforced proxy contract: `model` must be a nonempty string (handlers
 *  400s "missing model" otherwise); everything else passes through. */
const proxyBody = {
	model: z.string().min(1),
	messages: z.array(WireMessageSchema).optional(),
	stream: z.boolean().optional(),
	max_tokens: z.number().int().optional(),
};

export const ChatCompletionsBodySchema = z.object(proxyBody).loose();
export type ChatCompletionsBody = z.infer<typeof ChatCompletionsBodySchema>;

export const ResponsesBodySchema = z.object(proxyBody).loose();
export type ResponsesBody = z.infer<typeof ResponsesBodySchema>;

export const MessagesBodySchema = z.object(proxyBody).loose();
export type MessagesBody = z.infer<typeof MessagesBodySchema>;

export const CountTokensBodySchema = z.object(proxyBody).loose();
export type CountTokensBody = z.infer<typeof CountTokensBodySchema>;

// ─── admin API: keys (issue/list/verify/revoke) ───────────────────────────

/** Scope strings are validated by parseScope at issue time; the wire type
 *  is the raw string array the endpoint accepts. */
export const IssueKeyRequestSchema = z
	.object({
		name: z.string().min(1),
		scopes: z.array(z.string()).optional(),
		team: z.string().nullable().optional(),
		rpm_limit: z.number().int().optional(),
		tpm_limit: z.number().int().optional(),
		expires_in_s: z.number().optional(),
	})
	.loose();
export type IssueKeyRequest = z.infer<typeof IssueKeyRequestSchema>;

/** Raw key material exists exactly once — this response (keys.ts law). */
export const IssueKeyResponseSchema = z.object({
	key_id: z.string(),
	key: z.string(),
	name: z.string(),
	team: z.string().nullable(),
	scopes: z.array(z.string()),
	rpm_limit: z.number().int().nullable(),
	tpm_limit: z.number().int().nullable(),
	expires_at: z.number().nullable(),
});
export type IssueKeyResponse = z.infer<typeof IssueKeyResponseSchema>;

/** The listing row — key_hash NEVER appears (keys.listKeys law). */
export const KeyRowSchema = z
	.object({
		key_id: z.string(),
		jti: z.string().nullable(),
		name: z.string().nullable(),
		team: z.string().nullable(),
		actor: z.string().nullable(),
		token_type: z.string(),
		parent_key_id: z.string().nullable(),
		scopes: z.string().nullable(),
		rpm_limit: z.number().int().nullable(),
		tpm_limit: z.number().int().nullable(),
		expires_at: z.number().nullable(),
		rotated_at: z.number().nullable(),
		revoked_at: z.number().nullable(),
		created_at: z.number(),
	})
	.loose();
export type KeyRow = z.infer<typeof KeyRowSchema>;

export const KeyListResponseSchema = z.object({
	keys: z.array(KeyRowSchema),
});
export type KeyListResponse = z.infer<typeof KeyListResponseSchema>;

export const VerifyKeyRequestSchema = z.object({ key: z.string().min(1) });
export type VerifyKeyRequest = z.infer<typeof VerifyKeyRequestSchema>;

export const VerifyKeyOkSchema = z.object({
	valid: z.literal(true),
	key_id: z.string(),
	team: z.string().nullable(),
	scopes: z.array(z.string()),
	revoked: z.boolean(),
});
export const VerifyKeyErrSchema = z.object({
	valid: z.literal(false),
	code: z.string(),
});
export const VerifyKeyResponseSchema = z.union([
	VerifyKeyOkSchema,
	VerifyKeyErrSchema,
]);
export type VerifyKeyResponse = z.infer<typeof VerifyKeyResponseSchema>;

export const RevokeKeyResponseSchema = z.object({ revoked: z.string() });
export type RevokeKeyResponse = z.infer<typeof RevokeKeyResponseSchema>;

// ─── admin API: teams + drain ─────────────────────────────────────────────

export const TeamUpsertRequestSchema = z
	.object({
		team_id: z.string().min(1),
		name: z.string().optional(),
		department: z.string().nullable().optional(),
		rpm_ceiling: z.number().int().nullable().optional(),
		tpm_ceiling: z.number().int().nullable().optional(),
		spend_ceiling: z.number().int().nullable().optional(),
	})
	.loose();
export type TeamUpsertRequest = z.infer<typeof TeamUpsertRequestSchema>;

export const TeamUpsertResponseSchema = z.object({
	team_id: z.string(),
	rpm_ceiling: z.number().nullable(),
	tpm_ceiling: z.number().nullable(),
	spend_ceiling: z.number().nullable(),
});
export type TeamUpsertResponse = z.infer<typeof TeamUpsertResponseSchema>;

export const DrainRequestSchema = z.object({
	reason: z.string().min(1),
	grace_ms: z.number().optional(),
});
export type DrainRequest = z.infer<typeof DrainRequestSchema>;

export const DrainResponseSchema = z.object({
	draining: z.literal(true),
	reason: z.string(),
	since_ms: z.number(),
	deadline_ms: z.number(),
});
export type DrainResponse = z.infer<typeof DrainResponseSchema>;

// ─── GET /v1/models ───────────────────────────────────────────────────────

export const ModelRowSchema = z.object({
	id: z.string(),
	object: z.literal("model"),
	owned_by: z.string(),
});
export type ModelRow = z.infer<typeof ModelRowSchema>;

export const ModelListResponseSchema = z.object({
	object: z.literal("list"),
	data: z.array(ModelRowSchema),
});
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>;

// ─── the problem+json refusal envelope (every typed 4xx/5xx) ──────────────

export const ProblemSchema = z
	.object({
		type: z.string(),
		title: z.string(),
		status: z.number().int(),
		detail: z.string().optional(),
		instance: z.string().optional(),
		code: z.string(),
		why: z.string(),
		agent_next_steps: z.array(z.string()).optional(),
	})
	.loose();
export type Problem = z.infer<typeof ProblemSchema>;

/** The registered schemas gen-openapi walks — one row per wire face. */
export const WIRE_SCHEMAS = {
	ChatCompletionsBodySchema,
	ResponsesBodySchema,
	MessagesBodySchema,
	CountTokensBodySchema,
	IssueKeyRequestSchema,
	IssueKeyResponseSchema,
	KeyListResponseSchema,
	VerifyKeyRequestSchema,
	VerifyKeyResponseSchema,
	RevokeKeyResponseSchema,
	TeamUpsertRequestSchema,
	TeamUpsertResponseSchema,
	DrainRequestSchema,
	DrainResponseSchema,
	ModelListResponseSchema,
	ProblemSchema,
} as const;
