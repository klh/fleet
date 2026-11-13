// settings.stack.ts — the stack.json documents settings.json absorbs beside
// hubs: version pin, release updates, auth posture, providers, executors,
// per-repo policies, postures. Connection credentials may be inline only
// in the private operator document; diagnostics always redact their values.
import { z } from "zod";
import { list, opt } from "./settings.leaf.ts";
import { ConnectionSchema } from "./settings.connections.ts";
import { LegacyProviderSchema } from "./settings.connection-legacy.ts";

export const UpdatesSchema = z
	.object({
		mode: z.enum(["manual", "latest"]).default("manual"),
		origin: opt("Release origin"),
		check_interval_s: z.number().int().min(60).max(86_400).optional(),
	})
	.strict()
	.optional()
	.describe("Release reconciliation");

export const AuthSchema = z
	.object({
		required: z.boolean().optional(),
		tokens: z
			.object({ ttlHours: z.number().min(0).max(8760).optional() })
			.strict()
			.optional(),
		oidc: z
			.object({
				enforced: z.boolean().optional(),
				issuer: opt("OIDC issuer"),
				jwksUri: opt("JWKS URI"),
				audience: opt("Audience"),
				requiredScope: opt("Required scope"),
			})
			.strict()
			.optional(),
	})
	.strict()
	.optional()
	.describe("Auth posture");

export const ProviderSchema = z.union([ConnectionSchema, LegacyProviderSchema]);

export const ExecutorSchema = z
	.object({
		anthropic_base: opt("Anthropic-wire gateway base"),
		openai_base: opt("OpenAI-wire gateway base"),
		model: opt("Model pin"),
	})
	.strict();

export const RepoPolicySchema = z
	.object({
		must: opt("must law expression"),
		prefer: opt("prefer law expression"),
		hub: opt("Hub label"),
		residency: z.array(z.string()).optional(),
	})
	.strict();

export const RoutePreflightSchema = z
	.object({
		terminal_origins: z
			.array(z.string().min(1))
			.max(256)
			.optional()
			.describe(
				"Hub-machine terminal endpoints (model engines etc.) the route preflight gate treats as mapped leaves (W1094.1)",
			),
	})
	.strict()
	.optional()
	.describe("Route preflight");

export const StackSections = {
	version: opt("THE stack version: one string pins buckle+suspenders+belt"),
	updates: UpdatesSchema,
	auth: AuthSchema,
	// W2582: the stack.json sections that had no settings home — a partial
	// settings.json silently masked them (projection dropped every row).
	route_preflight: RoutePreflightSchema,
	admin: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Admin posture (owner-validated; stack.json carries admin.gui)"),
	providers: z
		.record(z.string(), ProviderSchema)
		.default({})
		.describe("Private provider accounts and peer Buckle connections"),
	executors: z
		.record(z.string(), ExecutorSchema)
		.default({})
		.describe("Per-executor gateway bases + model pin"),
	policies: z
		.record(z.string(), RepoPolicySchema)
		.default({})
		.describe("Per-repo routing policy"),
	postures: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Posture document (validated by its owner)"),
	cache_unsupported_models: list(
		[],
		"Models without provider prompt-cache reporting",
	),
};
