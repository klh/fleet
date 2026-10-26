import { z } from "zod";

const RESERVED_IDENTIFIER = new Set(["__proto__", "constructor", "prototype"]);

const IdentifierSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_-]+$/);

const ModelIdentifierSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(
		/^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
	);

const ProfileReferenceSchema = z
	.string()
	.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
	.refine((value) =>
		value.split(".").every((segment) => !RESERVED_IDENTIFIER.has(segment)),
	);

export const PosturePolicySchema = z.enum(["OFF", "CAN", "MUST"]);
export const LaneLimitSchema = z.union([
	z.literal("MAX"),
	z.number().int().nonnegative().safe(),
]);

export const PostureRuleSchema = z.strictObject({
	policy: PosturePolicySchema,
	lanes: LaneLimitSchema,
});

export const PostureRuleOverlaySchema = z.strictObject({
	policy: PosturePolicySchema.optional(),
	lanes: LaneLimitSchema.optional(),
});

const ProfileSchema = z.strictObject({
	models: z.record(ModelIdentifierSchema, PostureRuleSchema),
});

const ProfileOverlaySchema = z.strictObject({
	models: z.record(ModelIdentifierSchema, PostureRuleOverlaySchema).optional(),
});

const HubSchema = z.strictObject({
	profiles: z.record(IdentifierSchema, ProfileSchema),
});

const HubOverlaySchema = z.strictObject({
	profiles: z.record(IdentifierSchema, ProfileOverlaySchema).optional(),
});

const FleetSchema = z.strictObject({
	postures: z.record(IdentifierSchema, z.array(ProfileReferenceSchema)),
});

const FleetOverlaySchema = z.strictObject({
	postures: z
		.record(IdentifierSchema, z.array(ProfileReferenceSchema))
		.optional(),
});

export const PostureSelectionSchema = z.strictObject({
	fleet: IdentifierSchema,
	posture: IdentifierSchema,
	developmentOverride: z.boolean(),
});

const PostureSelectionOverlaySchema = z.strictObject({
	fleet: IdentifierSchema.optional(),
	posture: IdentifierSchema.optional(),
	developmentOverride: z.boolean().optional(),
});

export const PostureDocumentSchema = z.strictObject({
	version: z.literal(1),
	hubs: z.record(IdentifierSchema, HubSchema),
	fleets: z.record(IdentifierSchema, FleetSchema),
	selection: PostureSelectionSchema,
});

export const PostureOverlaySchema = z.strictObject({
	version: z.literal(1).optional(),
	hubs: z.record(IdentifierSchema, HubOverlaySchema).optional(),
	fleets: z.record(IdentifierSchema, FleetOverlaySchema).optional(),
	selection: PostureSelectionOverlaySchema.optional(),
});

export const PostureLayerSchema = z.strictObject({
	source: z.string().min(1),
	overlay: PostureOverlaySchema,
});

export const ResolvedEntrySchema = z.strictObject({
	hub: IdentifierSchema,
	model: ModelIdentifierSchema,
	policy: PosturePolicySchema,
	lanes: LaneLimitSchema,
});

export const ResolvedPostureSchema = z.strictObject({
	selection: PostureSelectionSchema,
	entries: z.array(ResolvedEntrySchema),
	sources: z.record(z.string(), z.string()),
});

export type PosturePolicy = z.infer<typeof PosturePolicySchema>;
export type LaneLimit = z.infer<typeof LaneLimitSchema>;
export type PostureRule = z.infer<typeof PostureRuleSchema>;
export type PostureRuleOverlay = z.infer<typeof PostureRuleOverlaySchema>;
export type PostureDocument = z.infer<typeof PostureDocumentSchema>;
export type PostureOverlay = z.infer<typeof PostureOverlaySchema>;
export type PostureSelection = z.infer<typeof PostureSelectionSchema>;
export type PostureLayer = z.infer<typeof PostureLayerSchema>;
export type ResolvedEntry = z.infer<typeof ResolvedEntrySchema>;
export type ResolvedPosture = z.infer<typeof ResolvedPostureSchema>;

function issuePath(path: PropertyKey[]): string {
	return path.length === 0 ? "$" : path.map(String).join(".");
}

export function assertSafePostureKeys(input: unknown, source: string): void {
	const active = new WeakSet<object>();
	const visit = (value: unknown, path: string): void => {
		if (value === null || typeof value !== "object") return;
		if (active.has(value)) {
			throw new Error(`${source}:${path}: cyclic configuration data`);
		}
		active.add(value);
		for (const key of Object.keys(value)) {
			const keyPath = path === "$" ? key : `${path}.${key}`;
			if (RESERVED_IDENTIFIER.has(key)) {
				throw new Error(
					`${source}:${keyPath}: prototype-sensitive key is not allowed`,
				);
			}
			visit(
				Reflect.get(value, key),
				Array.isArray(value) ? `${path}.${key}` : keyPath,
			);
		}
		active.delete(value);
	};

	visit(input, "$");
}

function throwValidationError(
	source: string,
	issues: readonly z.ZodIssue[],
): never {
	const details = issues
		.map((issue) => `${source}:${issuePath(issue.path)}: ${issue.message}`)
		.join("\n");
	throw new Error(details);
}

function parseSource<TSchema extends z.ZodType>(
	text: string,
	source: string,
	schema: TSchema,
): z.infer<TSchema> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`${source}: invalid JSON: ${error.message}`);
		}
		throw error;
	}

	assertSafePostureKeys(parsed, source);
	const result = schema.safeParse(parsed);
	if (!result.success) throwValidationError(source, result.error.issues);
	return result.data;
}

export function parsePostureDocument(
	text: string,
	source: string,
): PostureDocument {
	return parseSource(text, source, PostureDocumentSchema);
}

export function parsePostureOverlay(
	text: string,
	source: string,
): PostureOverlay {
	return parseSource(text, source, PostureOverlaySchema);
}

export { throwValidationError };
