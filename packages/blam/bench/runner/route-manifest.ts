import { z } from "zod";

const FrontSchema = z.strictObject({
	url: z.url().refine((raw) => {
		const url = new URL(raw);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	}, "front must be an HTTP(S) URL without credentials, query or fragment"),
	hub: z.string().min(1).nullable(),
});
export const RouteManifestSchema = z.strictObject({
	baseline: FrontSchema,
	candidate: FrontSchema,
	model: z.string().min(1),
	providerIdentity: z.string().min(1),
	reps: z.number().int().min(3).max(30).default(12),
	timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
	cacheCondition: z.string().min(1),
	policyDigest: z.string().min(1),
	outputDir: z.string().min(1),
});
export type RouteManifest = z.infer<typeof RouteManifestSchema>;
export const ROUTE_PROMPT =
	'Return exactly the JSON object {"ok":true}. No prose or markdown.';
export const RouteAnswerSchema = z.strictObject({ ok: z.literal(true) });
