import { z } from "zod";
import {
	ConnectionKeySchema,
	ConnectionUrlSchema,
} from "./settings.connections.ts";

/** Compatibility input only; normalized before any consumer acts on it. */
export const LegacyProviderSchema = z
	.strictObject({
		provider: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
			.optional(),
		key: ConnectionKeySchema.optional(),
		env: z
			.string()
			.regex(/^[A-Z][A-Z0-9_]*$/)
			.optional(),
		key_file: z.string().min(1).max(4096).optional(),
		key_name: z
			.string()
			.regex(/^[A-Z][A-Z0-9_]*$/)
			.optional(),
		base_url: ConnectionUrlSchema.optional(),
		endpoints: z
			.strictObject({
				openai: ConnectionUrlSchema.optional(),
				anthropic: ConnectionUrlSchema.optional(),
				catalog: ConnectionUrlSchema.optional(),
			})
			.optional(),
	})
	.superRefine((value, ctx) => {
		if (value.key && !value.provider)
			ctx.addIssue({
				code: "custom",
				message: "Legacy central key requires its provider family",
			});
		if (value.provider && !value.key && !value.key_file && !value.env)
			ctx.addIssue({
				code: "custom",
				message: "Legacy provider requires an explicit credential source",
			});
		if (value.key && (value.key_file || value.key_name || value.base_url))
			ctx.addIssue({
				code: "custom",
				message: "Legacy raw provider cannot mix credential declarations",
			});
		if (value.key_name && !value.key_file)
			ctx.addIssue({
				code: "custom",
				message: "Credential field name requires its explicit file",
			});
	});
export type LegacyProvider = z.infer<typeof LegacyProviderSchema>;
