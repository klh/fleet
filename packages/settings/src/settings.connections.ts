import { z } from "zod";

const NameSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const EnvNameSchema = z
	.string()
	.regex(/^[A-Z][A-Z0-9_]*$/)
	.max(256);
export const ConnectionUrlSchema = z
	.string()
	.max(4096)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				["http:", "https:"].includes(url.protocol) &&
				!!url.hostname &&
				!url.username &&
				!url.password &&
				!url.hash &&
				!url.search
			);
		} catch {
			return false;
		}
	}, "Expected HTTP(S) endpoint without credentials, query or fragment");

export const ConnectionKeySchema = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(value) =>
			value.length > 0 &&
			[...value].every((character) => {
				const code = character.charCodeAt(0);
				return code > 32 && code < 127;
			}),
		"Invalid credential value",
	);
export const ConnectionAuthSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("inline"), key: ConnectionKeySchema }),
	z.strictObject({
		kind: z.literal("file"),
		path: z.string().min(1).max(4096),
		key_name: EnvNameSchema.optional(),
	}),
	z.strictObject({ kind: z.literal("env"), name: EnvNameSchema }),
]);
export const ConnectionEndpointsSchema = z
	.strictObject({
		base: ConnectionUrlSchema.optional(),
		openai: ConnectionUrlSchema.optional(),
		anthropic: ConnectionUrlSchema.optional(),
		catalog: ConnectionUrlSchema.optional(),
	})
	.refine(
		(value) => !!value.base || !!value.openai || !!value.anthropic,
		"A wire endpoint is required",
	);
export const ConnectionTransportSchema = z.strictObject({
	max_connections: z.number().int().positive().optional(),
});
export const ProviderPacingSchema = z.strictObject({
	intervalCap: z.number().int().positive(),
	intervalMs: z.number().int().positive(),
	queueWaitMs: z.number().int().positive(),
	recovery: z.strictObject({
		successWindow: z.number().int().positive(),
		decreasePercent: z.number().int().min(1).max(99),
	}),
	concurrencyErrorCodes: z.array(z.string().min(1).max(64)).max(256).optional(),
});
export const ProviderAccountSchema = z.strictObject({
	id: NameSchema,
	concurrency: z.number().int().positive().optional(),
	queue_limit: z.number().int().nonnegative().optional(),
	pacing: ProviderPacingSchema.optional().describe(
		"Explicit native pool policy, or inherit the explicitly configured hub pool",
	),
});

const ModelNameSchema = z.string().min(1).max(512);
const common = {
	endpoints: ConnectionEndpointsSchema,
	protocol: z.enum(["openai", "anthropic", "native"]).optional(),
	auth: ConnectionAuthSchema.optional(),
	env: EnvNameSchema.optional().describe(
		"Generated output binding, never implicit input",
	),
	transport: ConnectionTransportSchema.optional(),
	default_model: ModelNameSchema.optional(),
	allowed_models: z
		.array(ModelNameSchema)
		.min(1)
		.max(4096)
		.default(["*"])
		.describe("Local allowlist only; never grants upstream entitlement"),
	discovery: z
		.strictObject({
			enabled: z.boolean().default(true),
		})
		.prefault({}),
};
export const ProviderConnectionSchema = z.strictObject({
	kind: z.literal("provider"),
	provider: NameSchema,
	adapter: NameSchema.describe(
		"Validated against the owning consumer's adapter registry",
	),
	...common,
	account: ProviderAccountSchema.optional(),
});
export const BuckleConnectionSchema = z.strictObject({
	kind: z.literal("buckle"),
	adapter: z.literal("buckle"),
	...common,
});
export const ConnectionSchema = z
	.discriminatedUnion("kind", [
		ProviderConnectionSchema,
		BuckleConnectionSchema,
	])
	.superRefine((value, ctx) => {
		if (
			value.protocol &&
			!value.endpoints[value.protocol === "native" ? "base" : value.protocol]
		)
			ctx.addIssue({
				code: "custom",
				path: ["protocol"],
				message: "Selected wire endpoint is absent",
			});
		if (
			new Set(value.allowed_models).size !== value.allowed_models.length ||
			(value.allowed_models.includes("*") && value.allowed_models.length !== 1)
		)
			ctx.addIssue({
				code: "custom",
				path: ["allowed_models"],
				message: "Use unique model IDs or a single wildcard",
			});
		if (
			value.default_model &&
			!value.allowed_models.includes("*") &&
			!value.allowed_models.includes(value.default_model)
		)
			ctx.addIssue({
				code: "custom",
				path: ["default_model"],
				message: "Default model is outside the local allowlist",
			});
	});
export type Connection = z.infer<typeof ConnectionSchema>;
